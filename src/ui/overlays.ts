// Toasts, modal dialogs, confirm, help/tutorial and level-up overlays.
import type { ToastKind } from '../game/api';
import { FEATURES, MODE_LIST } from '../config';
import { h, clear } from './dom';

let toastHost: HTMLElement | null = null;
let modalHost: HTMLElement | null = null;

export function initOverlays(root: HTMLElement): void {
  toastHost = h('div', { class: 'cm-toasts', role: 'status', 'aria-live': 'polite' });
  modalHost = h('div', { class: 'cm-modal-host' });
  root.append(toastHost, modalHost);
}

const TOAST_ICON: Record<ToastKind, string> = { info: 'ℹ️', good: '✅', warn: '⚠️', bad: '⛔' };

export interface ToastOpts {
  ms?: number;
  icon?: string;
  action?: { label: string; run: () => void };
}

/** Show a toast; repeated identical messages are merged (counter). */
export function toast(msg: string, kind: ToastKind = 'info', opts: ToastOpts = {}): void {
  if (!toastHost) return;
  for (const el of Array.from(toastHost.children) as HTMLElement[]) {
    if (el.dataset.msg === msg && !el.classList.contains('cm-out')) {
      const n = Number(el.dataset.n || '1') + 1;
      el.dataset.n = String(n);
      const c = el.querySelector('.cm-toast-count');
      if (c) c.textContent = `×${n}`;
      return;
    }
  }
  const el = h(
    'div',
    { class: `cm-toast cm-toast-${kind}`, dataset: { msg, n: '1' } },
    h('span', { class: 'cm-toast-icon' }, opts.icon ?? TOAST_ICON[kind]),
    h('span', { class: 'cm-toast-msg' }, msg),
    h('span', { class: 'cm-toast-count' }),
    opts.action
      ? h('button', { class: 'cm-btn cm-btn-small', onclick: () => { opts.action!.run(); dismiss(); } }, opts.action.label)
      : null,
    h('button', { class: 'cm-toast-x', title: 'Sluiten', 'aria-label': 'Sluiten', onclick: () => dismiss() }, '×'),
  );
  const dismiss = () => {
    if (el.classList.contains('cm-out')) return;
    el.classList.add('cm-out');
    setTimeout(() => el.remove(), 300);
  };
  toastHost.appendChild(el);
  while (toastHost.children.length > 6) toastHost.firstElementChild!.remove();
  setTimeout(dismiss, opts.ms ?? (kind === 'bad' || kind === 'warn' ? 7000 : 4500));
}

export interface ModalHandle {
  el: HTMLElement;
  close: () => void;
}

export function modal(content: HTMLElement, opts: { cls?: string; dismissable?: boolean; onClose?: () => void } = {}): ModalHandle {
  const host = modalHost ?? document.body;
  const card = h('div', { class: `cm-modal cm-glass ${opts.cls ?? ''}`, role: 'dialog', 'aria-modal': 'true' }, content);
  const back = h('div', { class: 'cm-modal-back' }, card);
  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    back.classList.add('cm-out');
    document.removeEventListener('keydown', onKey, true);
    setTimeout(() => back.remove(), 200);
    opts.onClose?.();
  };
  const onKey = (e: KeyboardEvent) => {
    if (e.key === 'Escape' && opts.dismissable !== false) {
      e.stopPropagation();
      close();
    }
  };
  if (opts.dismissable !== false) back.addEventListener('mousedown', (e) => { if (e.target === back) close(); });
  document.addEventListener('keydown', onKey, true);
  host.appendChild(back);
  setTimeout(() => (card.querySelector('[data-autofocus]') as HTMLElement | null)?.focus(), 30);
  return { el: card, close };
}

/** Promise-based confirm dialog. */
export function confirmDialog(title: string, text: string, okLabel = 'Bevestigen', danger = false): Promise<boolean> {
  return new Promise((resolve) => {
    let result = false;
    const body = h(
      'div',
      { class: 'cm-confirm' },
      h('h2', null, title),
      h('p', null, text),
      h(
        'div',
        { class: 'cm-row cm-row-end' },
        h('button', { class: 'cm-btn', onclick: () => m.close() }, 'Annuleren'),
        h('button', { class: `cm-btn ${danger ? 'cm-btn-danger' : 'cm-btn-primary'}`, 'data-autofocus': true, onclick: () => { result = true; m.close(); } }, okLabel),
      ),
    );
    const m = modal(body, { onClose: () => resolve(result) });
  });
}

const FEATURE_ICON: Record<string, string> = {
  speed: '⏱️', oneway: '⬆️', priority: '🔺', buslane: '🚌', lanes: '🛣️', signals: '🚦', roundabout: '🔄', region: '🏙️', highway: '🛣️',
};

export function iconForUnlock(name: string): string {
  const n = name.toLowerCase();
  for (const m of MODE_LIST) if (n.includes(m.name.toLowerCase())) return m.icon;
  for (const f of FEATURES) if (n.includes(f.name.toLowerCase())) return FEATURE_ICON[f.id] ?? '⭐';
  if (n.includes('stad') || n.includes('steden')) return '🏙️';
  return '⭐';
}

export function levelUpModal(level: number, unlocked: string[]): void {
  const descFor = (name: string) => {
    const f = FEATURES.find((x) => name.toLowerCase().includes(x.name.toLowerCase()));
    if (f) return f.desc;
    const m = MODE_LIST.find((x) => name.toLowerCase().includes(x.name.toLowerCase()));
    if (m) return `Je kunt nu ${m.name.toLowerCase()}lijnen aanleggen (capaciteit ${m.capacity} reizigers).`;
    return '';
  };
  const body = h(
    'div',
    { class: 'cm-levelup' },
    h('div', { class: 'cm-levelup-burst' }, h('div', { class: 'cm-levelup-num' }, String(level))),
    h('h2', null, `Level ${level} bereikt!`),
    unlocked.length
      ? [
          h('p', { class: 'cm-muted' }, 'Nieuw beschikbaar:'),
          h(
            'ul',
            { class: 'cm-unlock-list' },
            unlocked.map((u) =>
              h('li', null, h('span', { class: 'cm-unlock-icon' }, iconForUnlock(u)), h('div', null, h('b', null, u), h('div', { class: 'cm-muted cm-small' }, descFor(u)))),
            ),
          ),
        ]
      : h('p', { class: 'cm-muted' }, 'Goed bezig! Blijf reizigers vervoeren om nieuwe vervoerswijzen en steden te ontgrendelen.'),
    h('div', { class: 'cm-row cm-row-center' }, h('button', { class: 'cm-btn cm-btn-primary', 'data-autofocus': true, onclick: () => m.close() }, 'Verder spelen')),
  );
  const m = modal(body, { cls: 'cm-modal-levelup' });
}

export function helpOverlay(onClose?: () => void): void {
  const step = (icon: string, title: string, text: string | HTMLElement) =>
    h('div', { class: 'cm-help-step' }, h('div', { class: 'cm-help-icon' }, icon), h('div', null, h('b', null, title), h('div', { class: 'cm-muted' }, text)));
  const key = (k: string) => h('kbd', null, k);
  const body = h(
    'div',
    { class: 'cm-help' },
    h('h2', null, 'Welkom bij CityMover'),
    h('p', { class: 'cm-muted' }, 'Je bent de nieuwe vervoerder van een echte stad. Breng inwoners met bus, tram, metro en trein naar hun werk, school en winkels — en verdien genoeg om je netwerk uit te breiden.'),
    h(
      'div',
      { class: 'cm-help-grid' },
      h(
        'div',
        null,
        h('h3', null, 'Besturing'),
        step('🖱️', 'Kaart verschuiven', 'Slepen met de linkermuisknop'),
        step('🔄', 'Draaien & kantelen', h('span', null, 'Rechtermuisknop slepen of ', key('Ctrl'), ' + slepen')),
        step('🔍', 'Zoomen', 'Scrollen of knijpen (touch)'),
        step('⌨️', 'Sneltoetsen', h('span', null, key('Spatie'), ' pauze · ', key('1'), '–', key('4'), ' snelheid · ', key('Esc'), ' sluiten')),
      ),
      h(
        'div',
        null,
        h('h3', null, 'Zo begin je'),
        step('🚌', '1. Leg een buslijn aan', 'Klik links op Bus en zet haltes neer tussen drukke plekken: station, centrum, woonwijken, kantoren.'),
        step('🚍', '2. Koop voertuigen', 'Open de lijn en koop genoeg bussen voor de dienstregeling.'),
        step('🕖', '3. Let op de spits', 'Ochtendspits 7–9 uur en avondspits 16–19 uur: zet dan meer voertuigen per uur in.'),
        step('🛣️', '4. Pas wegen aan', 'Met Wegen verander je snelheden, rijrichting, busbanen en kruispunten. Te hard rijden = meer ongelukken!'),
      ),
    ),
    h('p', { class: 'cm-help-goal' }, '🎯 Doel: vervoer zoveel mogelijk reizigers met winst, stijg in level en ontgrendel nieuwe vervoerswijzen en steden.'),
    h('div', { class: 'cm-row cm-row-center' }, h('button', { class: 'cm-btn cm-btn-primary', 'data-autofocus': true, onclick: () => m.close() }, 'Aan de slag!')),
  );
  const m = modal(body, { cls: 'cm-modal-help', onClose });
}

export function clearModals(): void {
  if (modalHost) clear(modalHost);
}
