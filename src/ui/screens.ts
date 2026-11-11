// Full-screen pre-game screens: login, continue/new, city picker, loading.
import type { SaveBackend, SaveData } from '../game/api';
import { CITIES, CITY_BY_ID } from '../data/cities';
import { MODES, levelFromXp } from '../config';
import { h, clear, eurShort, int } from './dom';
import { confirmDialog } from './overlays';

function logo(): HTMLElement {
  return h(
    'div',
    { class: 'cm-logo' },
    h(
      'div',
      { class: 'cm-logo-mark', 'aria-hidden': 'true' },
      h('span', { style: `background:rgb(${MODES.bus.color})` }),
      h('span', { style: `background:rgb(${MODES.tram.color})` }),
      h('span', { style: `background:rgb(${MODES.metro.color})` }),
    ),
    h('div', null, h('div', { class: 'cm-logo-text' }, 'City', h('b', null, 'Mover')), h('div', { class: 'cm-logo-sub' }, 'Bouw het OV-netwerk van een échte stad')),
  );
}

/** Decorative transit-map background (SVG) */
function backdrop(): HTMLElement {
  const lines = [
    { c: MODES.bus.color, d: 'M-50 620 C 200 560, 300 380, 520 400 S 860 520, 1050 380 S 1400 200, 1700 260' },
    { c: MODES.tram.color, d: 'M-50 260 C 220 300, 360 180, 600 240 S 980 420, 1200 300 S 1500 120, 1700 160' },
    { c: MODES.metro.color, d: 'M200 900 C 260 700, 420 620, 560 520 S 760 260, 900 120 S 1100 -40, 1200 -60' },
    { c: MODES.coach.color, d: 'M-50 820 C 300 760, 700 840, 1000 700 S 1500 600, 1700 640' },
    { c: MODES.train.color, d: 'M1300 900 C 1200 700, 1150 520, 1250 360 S 1400 120, 1450 -60' },
  ];
  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg');
  svg.setAttribute('viewBox', '0 0 1600 900');
  svg.setAttribute('preserveAspectRatio', 'xMidYMid slice');
  svg.classList.add('cm-backdrop-svg');
  // street grid
  for (let i = 0; i < 40; i++) {
    const p = document.createElementNS(ns, 'path');
    const y = i * 26 + ((i * 37) % 13);
    p.setAttribute('d', `M0 ${y} L1600 ${y + ((i * 53) % 90) - 45}`);
    p.setAttribute('class', 'cm-bd-street');
    svg.appendChild(p);
    const q = document.createElementNS(ns, 'path');
    const x = i * 42 + ((i * 29) % 17);
    q.setAttribute('d', `M${x} 0 L${x + ((i * 71) % 120) - 60} 900`);
    q.setAttribute('class', 'cm-bd-street');
    svg.appendChild(q);
  }
  lines.forEach((l, i) => {
    const p = document.createElementNS(ns, 'path');
    p.setAttribute('d', l.d);
    p.setAttribute('class', 'cm-bd-line');
    p.setAttribute('style', `stroke:rgb(${l.c});animation-delay:${-i * 3}s`);
    svg.appendChild(p);
  });
  return h('div', { class: 'cm-backdrop' }, svg as unknown as HTMLElement);
}

function screen(root: HTMLElement, cls: string, ...content: HTMLElement[]): HTMLElement {
  clear(root);
  const card = h('div', { class: `cm-screen-card cm-glass ${cls}` }, ...content);
  const s = h('div', { class: 'cm-screen' }, backdrop(), card);
  root.appendChild(s);
  return card;
}

/** Login (cloud) or local notice. Resolves once the player may continue. */
export function loginScreen(root: HTMLElement, backend: SaveBackend): Promise<void> {
  return new Promise((resolve) => {
    if (!backend.isCloud()) {
      screen(
        root,
        'cm-login',
        logo(),
        h('div', { class: 'cm-notice' }, h('span', null, '💾'), h('span', null, 'Supabase niet geconfigureerd — voortgang wordt lokaal in je browser opgeslagen.')),
        h('button', { class: 'cm-btn cm-btn-primary cm-btn-big', 'data-autofocus': true, onclick: () => resolve() }, '▶ Spelen'),
        h('p', { class: 'cm-muted cm-small cm-center' }, 'Kaartgegevens © OpenStreetMap-bijdragers'),
      );
      return;
    }
    const email = h('input', { type: 'email', class: 'cm-input', placeholder: 'naam@voorbeeld.nl', autocomplete: 'email', required: true, id: 'cm-email' });
    const pass = h('input', { type: 'password', class: 'cm-input', placeholder: 'Minimaal 6 tekens', autocomplete: 'current-password', required: true, id: 'cm-pass' });
    const err = h('div', { class: 'cm-error', role: 'alert' });
    const info = h('div', { class: 'cm-info' });
    const btnIn = h('button', { class: 'cm-btn cm-btn-primary', type: 'submit' }, 'Inloggen');
    const btnUp = h('button', { class: 'cm-btn', type: 'button' }, 'Account aanmaken');
    const busy = (b: boolean) => {
      btnIn.disabled = b;
      btnUp.disabled = b;
      form.classList.toggle('cm-busy', b);
    };
    const validate = (): boolean => {
      err.textContent = '';
      if (!email.value.includes('@')) {
        err.textContent = 'Vul een geldig e-mailadres in.';
        return false;
      }
      if (pass.value.length < 6) {
        err.textContent = 'Het wachtwoord moet minimaal 6 tekens hebben.';
        return false;
      }
      return true;
    };
    const run = async (signUp: boolean) => {
      if (!validate()) return;
      busy(true);
      info.textContent = signUp ? 'Account aanmaken…' : 'Inloggen…';
      try {
        const e = signUp ? await backend.signUp(email.value.trim(), pass.value) : await backend.signIn(email.value.trim(), pass.value);
        if (e) {
          err.textContent = e;
          info.textContent = '';
          busy(false);
          return;
        }
        const u = await backend.getUser();
        if (!u) {
          info.textContent = signUp ? 'Account aangemaakt. Bevestig je e-mailadres via de link in je mail en log daarna in.' : '';
          if (!signUp) err.textContent = 'Inloggen mislukt.';
          busy(false);
          return;
        }
        resolve();
      } catch (ex) {
        err.textContent = 'Er ging iets mis: ' + (ex instanceof Error ? ex.message : String(ex));
        info.textContent = '';
        busy(false);
      }
    };
    btnUp.addEventListener('click', () => run(true));
    const form = h(
      'form',
      { class: 'cm-form', onsubmit: (e: Event) => { e.preventDefault(); run(false); } },
      h('label', { for: 'cm-email' }, 'E-mailadres'),
      email,
      h('label', { for: 'cm-pass' }, 'Wachtwoord'),
      pass,
      err,
      info,
      h('div', { class: 'cm-row cm-row-stretch' }, btnIn, btnUp),
    );
    screen(root, 'cm-login', logo(), h('p', { class: 'cm-muted' }, 'Log in om je voortgang in de cloud op te slaan en op elk apparaat verder te spelen.'), form);
    setTimeout(() => email.focus(), 50);
  });
}

/** Existing save found: continue or new. */
export function continueScreen(root: HTMLElement, save: SaveData, userLabel: string): Promise<'continue' | 'new'> {
  return new Promise((resolve) => {
    const lvl = levelFromXp(save.xp);
    const cityNames = save.cities.map((id) => CITY_BY_ID.get(id)?.name ?? id);
    const stat = (label: string, value: string, cls = '') => h('div', { class: 'cm-sumstat' }, h('div', { class: `cm-sumstat-v ${cls}` }, value), h('div', { class: 'cm-sumstat-l' }, label));
    screen(
      root,
      'cm-continue',
      logo(),
      h('h2', null, 'Welkom terug' + (userLabel ? `, ${userLabel}` : '') + '!'),
      h(
        'div',
        { class: 'cm-sumstats' },
        stat('Geld', eurShort(save.money), save.money < 0 ? 'cm-neg' : ''),
        stat('Level', String(lvl)),
        stat('Dag', String(Math.floor(save.time / 1440) + 1)),
        stat('Lijnen', String(save.lines.length)),
        stat('Vervoerd', int(save.totalDelivered)),
      ),
      h('div', { class: 'cm-muted cm-center' }, '🏙️ ', cityNames.join(' · ')),
      h(
        'div',
        { class: 'cm-row cm-row-stretch' },
        h('button', { class: 'cm-btn cm-btn-primary cm-btn-big', 'data-autofocus': true, onclick: () => resolve('continue') }, '▶ Doorgaan'),
        h(
          'button',
          {
            class: 'cm-btn cm-btn-big',
            onclick: async () => {
              const ok = await confirmDialog('Nieuw spel beginnen?', 'Je huidige spel wordt overschreven zodra het nieuwe spel wordt opgeslagen. Dit kan niet ongedaan worden gemaakt.', 'Nieuw spel', true);
              if (ok) resolve('new');
            },
          },
          '✨ Nieuw spel',
        ),
      ),
    );
  });
}

/** Pick a starter city. */
export function cityPickerScreen(root: HTMLElement): Promise<string> {
  return new Promise((resolve) => {
    const starters = CITIES.filter((c) => c.starter).sort((a, b) => (a.id === 'delft' ? -1 : b.id === 'delft' ? 1 : b.population - a.population));
    const flag = (c: string) => (c === 'NL' ? '🇳🇱' : c === 'BE' ? '🇧🇪' : '🇩🇪');
    const grid = h(
      'div',
      { class: 'cm-citygrid' },
      starters.map((c) => {
        const bundled = c.id === 'delft';
        const diff = c.population > 500000 ? 'Uitdagend' : c.population > 200000 ? 'Gemiddeld' : 'Rustig';
        return h(
          'button',
          { class: `cm-citycard ${bundled ? 'cm-citycard-fast' : ''}`, title: `Begin in ${c.name}`, onclick: () => resolve(c.id) },
          h('div', { class: 'cm-citycard-top' }, h('span', { class: 'cm-citycard-name' }, c.name), h('span', null, flag(c.country))),
          h('div', { class: 'cm-citycard-pop' }, `${int(c.population)} inwoners`),
          h(
            'div',
            { class: 'cm-citycard-tags' },
            bundled ? h('span', { class: 'cm-tag cm-tag-good' }, '⚡ Snel laden (meegeleverd)') : h('span', { class: 'cm-tag' }, '🌐 Live uit OpenStreetMap'),
            h('span', { class: 'cm-tag' }, diff),
            c.airport ? h('span', { class: 'cm-tag', title: c.airport.name }, '✈️') : null,
          ),
        );
      }),
    );
    screen(
      root,
      'cm-picker',
      logo(),
      h(
        'div',
        { class: 'cm-picker-intro' },
        h('h2', null, 'Kies je startstad'),
        h(
          'p',
          { class: 'cm-muted' },
          'Elke stad is gebouwd uit echte OpenStreetMap-gegevens: straten, kruispunten, spoorlijnen, woonwijken en kantoren. ',
          'Inwoners kiezen zelf tussen lopen, fiets, auto en jouw openbaar vervoer — maak het OV sneller en goedkoper dan de auto en ze stappen in. ',
          'Begin met een buslijn en groei uit tot een netwerk van tram, metro en treinen tussen steden.',
        ),
        h('p', { class: 'cm-small cm-muted' }, '⚡ Delft is meegeleverd en laadt direct. Andere steden worden live uit OpenStreetMap geladen — dat kan 10 tot 60 seconden duren.'),
      ),
      grid,
    );
  });
}

export interface LoadingHandle {
  status(s: string): void;
  error(msg: string, retry: () => void, back?: () => void): void;
}

const TIPS = [
  'Tip: in de spits (7–9 en 16–19 uur) reizen de meeste mensen. Zet dan meer voertuigen in.',
  'Tip: een lagere ticketprijs trekt meer reizigers, maar levert per rit minder op.',
  'Tip: busbanen laten bussen langs de file rijden.',
  'Tip: verkeerslichten zijn veilig maar kosten wachttijd; rotondes zijn een goed compromis.',
  'Tip: haltes bij stations, scholen en winkelcentra trekken veel reizigers.',
  'Tip: houd de snelheid in woonwijken laag — te hard rijden veroorzaakt ongelukken.',
];

export function loadingScreen(root: HTMLElement, cityName: string): LoadingHandle {
  const statusEl = h('div', { class: 'cm-loading-status' }, 'Bezig met laden…');
  const tipEl = h('div', { class: 'cm-loading-tip cm-muted' }, TIPS[Math.floor(Math.random() * TIPS.length)]);
  const actions = h('div', { class: 'cm-row cm-row-center' });
  const started = performance.now();
  const timeEl = h('div', { class: 'cm-small cm-muted' });
  const card = screen(
    root,
    'cm-loading',
    logo(),
    h('h2', null, `${cityName} wordt geladen`),
    h('div', { class: 'cm-spinner', 'aria-hidden': 'true' }, h('span'), h('span'), h('span')),
    statusEl,
    timeEl,
    tipEl,
    actions,
  );
  let tipI = 0;
  const timer = window.setInterval(() => {
    if (!card.isConnected) {
      clearInterval(timer);
      return;
    }
    const s = Math.round((performance.now() - started) / 1000);
    timeEl.textContent = s >= 3 ? `${s} s — kaartgegevens worden opgehaald en verwerkt` : '';
    if (s > 0 && s % 7 === 0) tipEl.textContent = TIPS[++tipI % TIPS.length];
  }, 1000);
  return {
    status(s) {
      statusEl.textContent = s;
    },
    error(msg, retry, back) {
      clearInterval(timer);
      card.classList.add('cm-has-error');
      statusEl.className = 'cm-error';
      statusEl.textContent = msg;
      timeEl.textContent = '';
      card.querySelector('.cm-spinner')?.remove();
      clear(actions);
      actions.append(h('button', { class: 'cm-btn cm-btn-primary', onclick: retry }, '↻ Opnieuw proberen'));
      if (back) actions.append(h('button', { class: 'cm-btn', onclick: back }, 'Andere stad kiezen'));
    },
  };
}
