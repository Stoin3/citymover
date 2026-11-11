// Small DOM helpers shared by all UI modules (no framework).
import type { ModeId } from '../config';
import { MODES } from '../config';

type Child = Node | string | number | null | undefined | false | Child[];
type Props = Record<string, unknown>;

/** Create an element: h('div', { class: 'cm-x', onclick: fn, title: '…' }, children…) */
export function h<K extends keyof HTMLElementTagNameMap>(tag: K, props?: Props | null, ...children: Child[]): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  if (props) {
    for (const [k, v] of Object.entries(props)) {
      if (v === undefined || v === null || v === false) continue;
      if (k === 'class') el.className = String(v);
      else if (k === 'style' && typeof v === 'string') el.style.cssText = v;
      else if (k === 'text') el.textContent = String(v);
      else if (k === 'html') el.innerHTML = String(v);
      else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v as EventListener);
      else if (k === 'dataset' && typeof v === 'object') Object.assign(el.dataset, v);
      else if (k in el && k !== 'list' && k !== 'form') (el as unknown as Record<string, unknown>)[k] = v;
      else el.setAttribute(k, v === true ? '' : String(v));
    }
  }
  append(el, children);
  return el;
}

export function append(el: Node, children: Child[]): void {
  for (const c of children) {
    if (c === null || c === undefined || c === false) continue;
    if (Array.isArray(c)) append(el, c);
    else el.appendChild(typeof c === 'string' || typeof c === 'number' ? document.createTextNode(String(c)) : c);
  }
}

export function clear(el: Element): void {
  while (el.firstChild) el.removeChild(el.firstChild);
}

const eur0 = new Intl.NumberFormat('nl-NL', { style: 'currency', currency: 'EUR', maximumFractionDigits: 0 });
const eur2 = new Intl.NumberFormat('nl-NL', { style: 'currency', currency: 'EUR', minimumFractionDigits: 2, maximumFractionDigits: 2 });
const num0 = new Intl.NumberFormat('nl-NL', { maximumFractionDigits: 0 });
const num1 = new Intl.NumberFormat('nl-NL', { maximumFractionDigits: 1 });

/** € 1.234.567 */
export function eur(v: number): string {
  return eur0.format(Math.round(v || 0)).replace(/ /g, ' ');
}
export function eurCents(v: number): string {
  return eur2.format(v || 0).replace(/ /g, ' ');
}
/** compact money: € 1,2 mln / € 340k */
export function eurShort(v: number): string {
  const a = Math.abs(v);
  const s = v < 0 ? '−' : '';
  if (a >= 1e9) return `${s}€ ${num1.format(a / 1e9)} mld`;
  if (a >= 1e6) return `${s}€ ${num1.format(a / 1e6)} mln`;
  if (a >= 1e4) return `${s}€ ${num0.format(a / 1e3)}k`;
  return `${s}€ ${num0.format(a)}`;
}
export function int(v: number): string {
  return num0.format(Math.round(v || 0));
}
export function dec1(v: number): string {
  return num1.format(v || 0);
}
export function pct(v01: number): string {
  return `${Math.round((v01 || 0) * 100)}%`;
}
export function km(m: number): string {
  return m >= 1000 ? `${num1.format(m / 1000)} km` : `${Math.round(m)} m`;
}
export function clock(hour: number): string {
  const totalMin = Math.floor(hour * 60);
  const hh = Math.floor(totalMin / 60) % 24;
  const mm = totalMin % 60;
  return `${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}`;
}

export function rgb(c: [number, number, number] | readonly number[], a = 1): string {
  return a >= 1 ? `rgb(${c[0]},${c[1]},${c[2]})` : `rgba(${c[0]},${c[1]},${c[2]},${a})`;
}
export function rgbToHex(c: readonly number[]): string {
  return '#' + [c[0], c[1], c[2]].map((v) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0')).join('');
}
export function hexToRgb(hex: string): [number, number, number] {
  const m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex.trim());
  if (!m) return [255, 255, 255];
  return [parseInt(m[1], 16), parseInt(m[2], 16), parseInt(m[3], 16)];
}
export function modeColor(mode: ModeId, a = 1): string {
  return rgb(MODES[mode].color, a);
}

/** Small coloured pill with the mode icon. */
export function modeChip(mode: ModeId, label?: string): HTMLElement {
  const m = MODES[mode];
  return h('span', { class: 'cm-modechip', style: `--c:${rgb(m.color)}`, title: m.name }, h('span', null, m.icon), h('span', null, label ?? m.name));
}

export function colorDot(c: readonly number[]): HTMLElement {
  return h('span', { class: 'cm-dot', style: `background:${rgb(c)}` });
}

/** true when the user is typing in a form control (keyboard shortcuts must not fire) */
export function isTyping(): boolean {
  const a = document.activeElement as HTMLElement | null;
  if (!a) return false;
  const t = a.tagName;
  return t === 'INPUT' || t === 'TEXTAREA' || t === 'SELECT' || a.isContentEditable;
}
