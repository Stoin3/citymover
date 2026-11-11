// Save backend: Supabase (auth + `saves` table) when VITE_SUPABASE_URL and
// VITE_SUPABASE_ANON_KEY are set, otherwise a pure localStorage fallback.
//
// Cloud mode always writes a local backup copy first, so a failed network save
// never loses progress. Stored payloads are wrapped as
//   { format: 'citymover', savedAt: <ms epoch>, save: SaveData }
// (both in localStorage and in the jsonb `data` column); on load the newest of
// cloud row and local backup wins.
import { createClient, type SupabaseClient, type User } from '@supabase/supabase-js';
import type { SaveBackend, SaveData, SaveUser } from '../game/api';

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const env: Record<string, string | undefined> = (import.meta as { env?: Record<string, string | undefined> }).env ?? {};
const SUPABASE_URL = (env.VITE_SUPABASE_URL || '').trim();
const SUPABASE_KEY = (env.VITE_SUPABASE_ANON_KEY || '').trim();
const CLOUD = !!SUPABASE_URL && !!SUPABASE_KEY;

const TABLE = 'saves';
const LS_PREFIX = 'citymover:save:'; // + user id
const LS_LOCAL_SIGNED_OUT = 'citymover:local-signed-out';
const MIN_UPLOAD_INTERVAL_MS = 2000; // coalesce bursts of save() calls
const WARN_BYTES = 1024 * 1024;

const LOCAL_USER: SaveUser = { id: 'local', email: 'lokaal' };

interface SaveWrapper {
  format: 'citymover';
  savedAt: number;
  save: SaveData;
}

// ---------------------------------------------------------------------------
// localStorage helpers (never throw: private mode / quota / no DOM)
// ---------------------------------------------------------------------------

function lsGet(key: string): string | null {
  try {
    return globalThis.localStorage?.getItem(key) ?? null;
  } catch {
    return null;
  }
}

function lsSet(key: string, value: string): boolean {
  try {
    if (!globalThis.localStorage) return false;
    globalThis.localStorage.setItem(key, value);
    return true;
  } catch (e) {
    console.warn('[save] localStorage schrijven mislukt', e);
    return false;
  }
}

function lsRemove(key: string): void {
  try {
    globalThis.localStorage?.removeItem(key);
  } catch {
    /* ignore */
  }
}

function isSaveData(x: unknown): x is SaveData {
  return !!x && typeof x === 'object' && (x as SaveData).v === 1 && typeof (x as SaveData).money === 'number';
}

/** Accepts a wrapper or a bare SaveData (older / hand-edited rows). */
function unwrap(raw: unknown, fallbackTime = 0): SaveWrapper | null {
  if (!raw || typeof raw !== 'object') return null;
  const w = raw as Partial<SaveWrapper>;
  if (w.format === 'citymover' && isSaveData(w.save)) {
    return { format: 'citymover', savedAt: typeof w.savedAt === 'number' ? w.savedAt : fallbackTime, save: w.save };
  }
  if (isSaveData(raw)) return { format: 'citymover', savedAt: fallbackTime, save: raw };
  return null;
}

function wrap(data: SaveData): SaveWrapper {
  return { format: 'citymover', savedAt: Date.now(), save: data };
}

function readLocal(userId: string): SaveWrapper | null {
  const s = lsGet(LS_PREFIX + userId);
  if (!s) return null;
  try {
    return unwrap(JSON.parse(s));
  } catch {
    console.warn('[save] lokale save is beschadigd en wordt genegeerd');
    return null;
  }
}

function serialize(w: SaveWrapper): string {
  const json = JSON.stringify(w);
  const bytes = typeof TextEncoder !== 'undefined' ? new TextEncoder().encode(json).length : json.length;
  if (bytes > WARN_BYTES) {
    console.warn(`[save] savebestand is groot: ${(bytes / 1024 / 1024).toFixed(2)} MB`);
  }
  return json;
}

function writeLocal(userId: string, w: SaveWrapper, json?: string): boolean {
  return lsSet(LS_PREFIX + userId, json ?? serialize(w));
}

// ---------------------------------------------------------------------------
// Dutch error messages
// ---------------------------------------------------------------------------

interface ErrLike {
  message?: string;
  code?: string;
  status?: number;
  name?: string;
}

function translateError(err: unknown): string {
  if (!err) return 'Onbekende fout';
  const e = err as ErrLike;
  const code = (e.code || '').toLowerCase();
  const msg = (e.message || String(err)).toLowerCase();

  const byCode: Record<string, string> = {
    invalid_credentials: 'Ongeldige inloggegevens',
    email_not_confirmed: 'Bevestig eerst je e-mailadres (klik op de link in de bevestigingsmail)',
    weak_password: 'Wachtwoord moet minimaal 6 tekens zijn',
    user_already_exists: 'Er bestaat al een account met dit e-mailadres',
    email_exists: 'Er bestaat al een account met dit e-mailadres',
    email_address_invalid: 'Ongeldig e-mailadres',
    email_address_not_authorized: 'Naar dit e-mailadres kan geen mail worden verstuurd',
    signup_disabled: 'Nieuwe accounts aanmaken is uitgeschakeld',
    email_provider_disabled: 'Inloggen met e-mail is uitgeschakeld in Supabase',
    provider_disabled: 'Inloggen met e-mail is uitgeschakeld in Supabase',
    over_email_send_rate_limit: 'Te veel e-mails verstuurd, probeer het later opnieuw',
    over_request_rate_limit: 'Te veel pogingen, wacht even en probeer het opnieuw',
    user_banned: 'Dit account is geblokkeerd',
    user_not_found: 'Gebruiker niet gevonden',
    session_expired: 'Je sessie is verlopen, log opnieuw in',
    session_not_found: 'Je sessie is verlopen, log opnieuw in',
    refresh_token_not_found: 'Je sessie is verlopen, log opnieuw in',
    refresh_token_already_used: 'Je sessie is verlopen, log opnieuw in',
    captcha_failed: 'Captcha-controle mislukt',
    request_timeout: 'De server reageert niet, probeer het later opnieuw',
    same_password: 'Het nieuwe wachtwoord moet anders zijn dan het oude',
    // PostgREST / Postgres
    '42p01': 'De tabel "saves" bestaat niet: voer supabase/schema.sql uit in de SQL Editor',
    pgrst205: 'De tabel "saves" bestaat niet: voer supabase/schema.sql uit in de SQL Editor',
    '42501': 'Geen toegang tot de savegegevens (controleer de RLS-policies uit supabase/schema.sql)',
    pgrst301: 'Je sessie is verlopen, log opnieuw in',
    pgrst303: 'Je sessie is verlopen, log opnieuw in',
  };
  if (byCode[code]) return byCode[code];

  if (msg.includes('invalid login credentials')) return byCode.invalid_credentials;
  if (msg.includes('email not confirmed')) return byCode.email_not_confirmed;
  if (msg.includes('password should be at least') || msg.includes('password is too short')) return byCode.weak_password;
  if (msg.includes('password') && msg.includes('weak')) return 'Wachtwoord is te zwak, kies een sterker wachtwoord';
  if (msg.includes('already registered') || msg.includes('already exists')) return byCode.user_already_exists;
  if (msg.includes('unable to validate email') || msg.includes('invalid format') || (msg.includes('email') && msg.includes('invalid')))
    return byCode.email_address_invalid;
  if (msg.includes('signups not allowed') || msg.includes('signup is disabled')) return byCode.signup_disabled;
  if (msg.includes('rate limit') || msg.includes('too many')) return byCode.over_request_rate_limit;
  if (msg.includes('jwt expired') || msg.includes('refresh token')) return byCode.session_expired;
  if (msg.includes('row-level security') || msg.includes('permission denied')) return byCode['42501'];
  if (msg.includes('relation') && msg.includes('does not exist')) return byCode['42p01'];
  if (
    e.name === 'AuthRetryableFetchError' ||
    msg.includes('failed to fetch') ||
    msg.includes('networkerror') ||
    msg.includes('network request failed') ||
    msg.includes('load failed') ||
    msg.includes('fetch failed')
  )
    return 'Geen verbinding met de server. Controleer je internetverbinding';
  if (e.status && e.status >= 500) return 'Serverfout bij Supabase, probeer het later opnieuw';
  return 'Er ging iets mis: ' + (e.message || String(err));
}

function validateCredentials(email: string, password: string): string | null {
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())) return 'Ongeldig e-mailadres';
  if (!password) return 'Vul een wachtwoord in';
  return null;
}

// ---------------------------------------------------------------------------
// Local (offline) backend
// ---------------------------------------------------------------------------

function createLocalBackend(): SaveBackend {
  const listeners = new Set<(u: SaveUser | null) => void>();
  const current = (): SaveUser | null => (lsGet(LS_LOCAL_SIGNED_OUT) === '1' ? null : LOCAL_USER);
  const emit = () => {
    const u = current();
    for (const cb of [...listeners]) cb(u);
  };
  const signInLocal = async (): Promise<string | null> => {
    lsRemove(LS_LOCAL_SIGNED_OUT);
    emit();
    return null;
  };

  return {
    isCloud: () => false,
    getUser: async () => current(),
    signUp: signInLocal,
    signIn: signInLocal,
    async signOut() {
      lsSet(LS_LOCAL_SIGNED_OUT, '1');
      emit();
    },
    async load() {
      return readLocal(LOCAL_USER.id)?.save ?? null;
    },
    async save(data) {
      return writeLocal(LOCAL_USER.id, wrap(data))
        ? null
        : 'Opslaan mislukt: de opslag van je browser is vol of geblokkeerd';
    },
    onAuthChange(cb) {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
  };
}

// ---------------------------------------------------------------------------
// Cloud (Supabase) backend
// ---------------------------------------------------------------------------

function toSaveUser(u: User | null | undefined): SaveUser | null {
  return u ? { id: u.id, email: u.email ?? '' } : null;
}

function createCloudBackend(): SaveBackend {
  const sb: SupabaseClient = createClient(SUPABASE_URL, SUPABASE_KEY, {
    auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true, storageKey: 'citymover-auth' },
  });

  async function currentUser(): Promise<SaveUser | null> {
    // getSession() reads the locally stored session (no network round-trip);
    // RLS on the server still enforces ownership.
    try {
      const { data } = await sb.auth.getSession();
      return toSaveUser(data.session?.user);
    } catch {
      return null;
    }
  }

  // ---- serialized / coalesced uploads ----
  let pending: { userId: string; w: SaveWrapper } | null = null;
  let running: Promise<void> | null = null;
  let waiters: ((err: string | null) => void)[] = [];
  let lastUploadAt = 0;

  async function upload(userId: string, w: SaveWrapper): Promise<string | null> {
    try {
      const { error } = await sb
        .from(TABLE)
        .upsert({ user_id: userId, data: w, updated_at: new Date().toISOString() }, { onConflict: 'user_id' });
      if (error) return translateError(error);
      return null;
    } catch (e) {
      return translateError(e);
    }
  }

  function pump(): Promise<void> {
    if (running) return running;
    running = (async () => {
      while (pending) {
        const wait = lastUploadAt + MIN_UPLOAD_INTERVAL_MS - Date.now();
        if (wait > 0) await new Promise((r) => setTimeout(r, wait));
        const job = pending;
        const jobWaiters = waiters;
        pending = null;
        waiters = [];
        if (!job) break;
        const err = await upload(job.userId, job.w);
        lastUploadAt = Date.now();
        if (err) console.warn('[save] cloud-opslag mislukt, lokale backup blijft bewaard:', err);
        const result = err ? `Opslaan in de cloud mislukt (lokaal bewaard): ${err}` : null;
        for (const res of jobWaiters) res(result);
      }
    })().finally(() => {
      running = null;
      if (pending) void pump();
    });
    return running;
  }

  function enqueue(userId: string, w: SaveWrapper): Promise<string | null> {
    return new Promise((resolve) => {
      // Newer data replaces any not-yet-started upload; everybody waiting gets the result.
      pending = { userId, w };
      waiters.push(resolve);
      void pump();
    });
  }

  return {
    isCloud: () => true,

    getUser: currentUser,

    async signUp(email, password) {
      const v = validateCredentials(email, password);
      if (v) return v;
      if (password.length < 6) return 'Wachtwoord moet minimaal 6 tekens zijn';
      try {
        const redirect = typeof location !== 'undefined' ? location.origin + location.pathname : undefined;
        const { data, error } = await sb.auth.signUp({
          email: email.trim(),
          password,
          options: redirect ? { emailRedirectTo: redirect } : undefined,
        });
        if (error) return translateError(error);
        // With email-enumeration protection an existing address returns a user without identities.
        if (data.user && Array.isArray(data.user.identities) && data.user.identities.length === 0)
          return 'Er bestaat al een account met dit e-mailadres';
        if (!data.session)
          return 'Account aangemaakt! Bevestig eerst je e-mailadres via de link in je mailbox en log daarna in.';
        return null;
      } catch (e) {
        return translateError(e);
      }
    },

    async signIn(email, password) {
      const v = validateCredentials(email, password);
      if (v) return v;
      try {
        const { error } = await sb.auth.signInWithPassword({ email: email.trim(), password });
        return error ? translateError(error) : null;
      } catch (e) {
        return translateError(e);
      }
    },

    async signOut() {
      // Let a pending upload finish first so the last progress reaches the cloud.
      if (running) await running.catch(() => {});
      try {
        await sb.auth.signOut();
      } catch (e) {
        console.warn('[save] uitloggen mislukt', e);
      }
    },

    async load() {
      const user = await currentUser();
      if (!user) return null;
      const local = readLocal(user.id);
      let cloud: SaveWrapper | null = null;
      try {
        const { data, error } = await sb.from(TABLE).select('data, updated_at').eq('user_id', user.id).maybeSingle();
        if (error) throw error;
        if (data) {
          const t = data.updated_at ? Date.parse(data.updated_at as string) || 0 : 0;
          cloud = unwrap(data.data, t);
        }
      } catch (e) {
        console.warn('[save] cloud-save laden mislukt, lokale backup gebruikt:', translateError(e));
        return local?.save ?? null;
      }
      if (local && (!cloud || local.savedAt > cloud.savedAt)) {
        // Local backup is newer (e.g. last cloud save failed): use it and sync it up.
        if (cloud) console.info('[save] lokale backup is nieuwer dan de cloud-save; die wordt gebruikt');
        void enqueue(user.id, local);
        return local.save;
      }
      if (cloud) {
        writeLocal(user.id, cloud);
        return cloud.save;
      }
      return null;
    },

    async save(data) {
      const user = await currentUser();
      const w = wrap(data);
      const json = serialize(w);
      const localOk = writeLocal(user ? user.id : 'anon', w, json);
      if (!user) return 'Je bent niet ingelogd: voortgang alleen lokaal bewaard';
      const err = await enqueue(user.id, w);
      if (err && !localOk) return 'Opslaan mislukt (cloud en lokale opslag): ' + err;
      return err;
    },

    onAuthChange(cb) {
      const { data } = sb.auth.onAuthStateChange((_event, session) => {
        // Defer: calling other supabase methods inside this callback can deadlock.
        const u = toSaveUser(session?.user);
        setTimeout(() => cb(u), 0);
      });
      return () => data.subscription.unsubscribe();
    },
  };
}

export const saveBackend: SaveBackend = CLOUD ? createCloudBackend() : createLocalBackend();

