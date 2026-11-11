// DEV-ONLY fake save backend for the UI harness.
import type { SaveBackend, SaveData, SaveUser } from '../../game/api';

export function createFakeBackend(opts: { cloud: boolean; loggedIn: boolean; save: SaveData | null }): SaveBackend {
  let user: SaveUser | null = opts.loggedIn ? { id: 'u1', email: 'speler@voorbeeld.nl' } : opts.cloud ? null : { id: 'lokaal', email: 'lokaal' };
  let data = opts.save;
  const cbs = new Set<(u: SaveUser | null) => void>();
  return {
    isCloud: () => opts.cloud,
    getUser: async () => user,
    signUp: async (email) => {
      if (email.startsWith('fout')) return 'Dit e-mailadres is al in gebruik.';
      user = { id: 'u2', email };
      cbs.forEach((c) => c(user));
      return null;
    },
    signIn: async (email, pw) => {
      await new Promise((r) => setTimeout(r, 300));
      if (pw !== 'geheim1') return 'Onjuist e-mailadres of wachtwoord.';
      user = { id: 'u1', email };
      cbs.forEach((c) => c(user));
      return null;
    },
    signOut: async () => {
      user = null;
      cbs.forEach((c) => c(null));
    },
    load: async () => data,
    save: async (d) => {
      await new Promise((r) => setTimeout(r, 200));
      data = d;
      return null;
    },
    onAuthChange: (cb) => {
      cbs.add(cb);
      return () => cbs.delete(cb);
    },
  };
}
