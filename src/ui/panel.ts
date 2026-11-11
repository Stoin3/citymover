// Base class for the right-hand side panels. A panel builds its DOM once and
// keeps it fresh through cheap "bindings" (text/value updaters), so periodic
// refreshes never destroy an input the player is typing in.
import type { IGame, IRenderer, PickInfo } from '../game/api';
import type { GameUI } from './gameUI';
import { h, clear } from './dom';

export type Binding = () => void;

export abstract class Panel {
  ui: GameUI;
  el: HTMLElement;
  body: HTMLElement;
  titleEl: HTMLElement;
  private binds: Binding[] = [];
  dirty = false;
  /** panel identity, used to avoid re-opening the same panel */
  abstract key: string;
  /** css modifier class */
  cls = '';

  constructor(ui: GameUI) {
    this.ui = ui;
    this.titleEl = h('h2', { class: 'cm-panel-title' });
    this.body = h('div', { class: 'cm-panel-body' });
    const closeBtn = h('button', { class: 'cm-iconbtn cm-panel-close', title: 'Sluiten (Esc)', 'aria-label': 'Sluiten', onclick: () => this.ui.closePanel(this) }, '✕');
    this.el = h('section', { class: 'cm-panel cm-glass' }, h('header', { class: 'cm-panel-head' }, this.titleEl, closeBtn), this.body);
    this.el.addEventListener('focusout', () => {
      setTimeout(() => {
        if (this.dirty && this.el.isConnected && this.isValid() && !this.hasFocusedInput()) this.rebuild();
      }, 0);
    });
  }

  get game(): IGame {
    return this.ui.game;
  }
  get renderer(): IRenderer {
    return this.ui.renderer;
  }

  abstract title(): string | Node;
  abstract build(body: HTMLElement): void;
  /** selection to highlight on the map while open */
  selection(): PickInfo | null {
    return null;
  }
  /** false → the panel's subject no longer exists and the panel closes */
  isValid(): boolean {
    return true;
  }
  /** react to game 'changed' events (default: rebuild when idle) */
  onChanged(_what: string): void {
    this.dirty = true;
  }
  onOpen(): void {}
  onClose(): void {}

  mount(): void {
    if (this.cls) this.el.classList.add(this.cls);
    this.rebuild();
    this.onOpen();
  }

  hasFocusedInput(): boolean {
    const a = document.activeElement as HTMLElement | null;
    if (!a || !this.el.contains(a)) return false;
    return a.tagName === 'INPUT' || a.tagName === 'TEXTAREA' || a.tagName === 'SELECT';
  }

  rebuild(): void {
    this.dirty = false;
    const scroll = this.body.scrollTop;
    this.binds = [];
    clear(this.body);
    const t = this.title();
    clear(this.titleEl);
    this.titleEl.append(t);
    this.build(this.body);
    this.update();
    this.body.scrollTop = scroll;
  }

  /** periodic refresh (~2×/s) */
  update(): void {
    if (this.dirty && !this.hasFocusedInput()) {
      this.rebuild();
      return;
    }
    for (const b of this.binds) {
      try {
        b();
      } catch (e) {
        console.warn('[ui] binding failed', e);
      }
    }
  }

  // ---- binding helpers ----
  bind(fn: Binding): void {
    this.binds.push(fn);
  }
  /** element whose textContent follows fn() */
  text(fn: () => string, cls = '', tag: 'span' | 'div' | 'b' | 'td' = 'span'): HTMLElement {
    const el = h(tag, { class: cls });
    let last = '';
    this.bind(() => {
      const v = fn();
      if (v !== last) el.textContent = last = v;
    });
    return el;
  }
  /** input whose value follows fn() unless focused */
  syncValue(input: HTMLInputElement | HTMLSelectElement, fn: () => string): void {
    this.bind(() => {
      if (document.activeElement === input) return;
      const v = fn();
      if (input.value !== v) input.value = v;
    });
  }
}

// ---------- shared panel building blocks ----------
export function section(title: string, ...children: (Node | Node[] | null | false | undefined)[]): HTMLElement {
  return h('div', { class: 'cm-section' }, h('h3', { class: 'cm-section-title' }, title), ...children);
}
export function kv(label: string, value: Node | string, hint?: string): HTMLElement {
  return h('div', { class: 'cm-kv', title: hint }, h('span', { class: 'cm-kv-k' }, label), h('span', { class: 'cm-kv-v' }, value));
}
export function hint(text: string, kind: 'info' | 'warn' | 'bad' | 'good' = 'info'): HTMLElement {
  return h('div', { class: `cm-hint cm-hint-${kind}` }, text);
}
export function lockBadge(level: number): HTMLElement {
  return h('span', { class: 'cm-lock', title: `Beschikbaar vanaf level ${level}` }, `🔒 Level ${level}`);
}
