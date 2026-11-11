// Top HUD bar: money, clock, speed, level/XP, passengers, reputation, save, logout.
import { TIME_BLOCKS, blockAt, xpForLevel } from '../config';
import type { GameUI } from './gameUI';
import { h, eur, eurShort, int, clock } from './dom';

export const SPEEDS = [0, 1, 3, 10, 30];

export class Hud {
  el: HTMLElement;
  private ui: GameUI;
  private moneyEl: HTMLElement;
  private moneyVal: HTMLElement;
  private deltaHost: HTMLElement;
  private timeEl: HTMLElement;
  private partEl: HTMLElement;
  private speedBtns: HTMLButtonElement[] = [];
  private lvlNum: HTMLElement;
  private xpFill: HTMLElement;
  private xpWrap: HTMLElement;
  private paxEl: HTMLElement;
  private paxWrap: HTMLElement;
  private repEl: HTMLElement;
  private repWrap: HTMLElement;
  saveBtn: HTMLButtonElement;
  saveState: HTMLElement;
  private lastMoney = NaN;
  private deltaAcc = 0;
  private deltaAt = 0;

  constructor(ui: GameUI) {
    this.ui = ui;
    this.moneyVal = h('span', { class: 'cm-money-v' });
    this.deltaHost = h('span', { class: 'cm-money-deltas', 'aria-hidden': 'true' });
    this.moneyEl = h('div', { class: 'cm-hud-item cm-money', title: 'Saldo. Klik voor financiën.', onclick: () => ui.openFinance(), role: 'button', tabindex: 0 }, h('span', { class: 'cm-hud-ico' }, '💶'), this.moneyVal, this.deltaHost);
    this.timeEl = h('span', { class: 'cm-time-v' });
    this.partEl = h('span', { class: 'cm-daypart' });
    const timeBox = h('div', { class: 'cm-hud-item cm-time', title: 'Speltijd' }, h('span', { class: 'cm-hud-ico' }, '🕒'), h('div', { class: 'cm-stack' }, this.timeEl, this.partEl));

    const labels = ['⏸', '1×', '3×', '10×', '30×'];
    const titles = ['Pauze (spatie)', 'Normale snelheid (1)', 'Snel (2)', 'Sneller (3)', 'Snelst (4)'];
    const speedBox = h('div', { class: 'cm-speed', role: 'group', 'aria-label': 'Spelsnelheid' });
    SPEEDS.forEach((s, i) => {
      const b = h('button', { class: 'cm-speed-btn', title: titles[i], 'aria-label': titles[i], onclick: () => ui.setSpeed(s) }, labels[i]);
      this.speedBtns.push(b);
      speedBox.append(b);
    });

    this.lvlNum = h('span', { class: 'cm-lvl-num' });
    this.xpFill = h('div', { class: 'cm-xp-fill' });
    this.xpWrap = h('div', { class: 'cm-hud-item cm-level' }, h('div', { class: 'cm-lvl-badge' }, h('small', null, 'LVL'), this.lvlNum), h('div', { class: 'cm-xp' }, this.xpFill));

    this.paxEl = h('span', { class: 'cm-hud-v' });
    this.paxWrap = h('div', { class: 'cm-hud-item cm-hud-stat', onclick: () => ui.openStats(), role: 'button', tabindex: 0 }, h('span', { class: 'cm-hud-ico' }, '🧍'), h('div', { class: 'cm-stack' }, this.paxEl, h('span', { class: 'cm-hud-l' }, 'reizigers vandaag')));
    this.repEl = h('span', { class: 'cm-hud-v' });
    this.repWrap = h('div', { class: 'cm-hud-item cm-hud-stat', onclick: () => ui.openRegion(), role: 'button', tabindex: 0 }, h('span', { class: 'cm-hud-ico' }, '⭐'), h('div', { class: 'cm-stack' }, this.repEl, h('span', { class: 'cm-hud-l' }, 'reputatie')));

    this.saveState = h('span', { class: 'cm-save-state' });
    this.saveBtn = h('button', { class: 'cm-iconbtn', title: 'Nu opslaan', 'aria-label': 'Nu opslaan', onclick: () => ui.save(true) }, '💾');
    const help = h('button', { class: 'cm-iconbtn', title: 'Uitleg & besturing', 'aria-label': 'Uitleg', onclick: () => ui.showHelp() }, '?');
    const cloud = ui.backend.isCloud();
    const logout = h('button', { class: 'cm-iconbtn', title: cloud ? 'Opslaan en uitloggen' : 'Opslaan en terug naar het menu', 'aria-label': cloud ? 'Uitloggen' : 'Menu', onclick: () => ui.logout() }, cloud ? '⏻' : '⏏');

    this.el = h(
      'header',
      { class: 'cm-hud cm-glass' },
      h('div', { class: 'cm-hud-group' }, h('div', { class: 'cm-hud-brand', title: 'CityMover' }, 'C', h('b', null, 'M')), this.moneyEl, timeBox),
      h('div', { class: 'cm-hud-group cm-hud-center' }, speedBox),
      h('div', { class: 'cm-hud-group cm-hud-right' }, this.paxWrap, this.repWrap, this.xpWrap, h('div', { class: 'cm-hud-item cm-save' }, this.saveBtn, this.saveState), help, logout),
    );
  }

  update(): void {
    const g = this.ui.game;
    // money
    const m = g.money;
    this.moneyVal.textContent = eur(m);
    this.moneyEl.classList.toggle('cm-neg', m < 0);
    if (!isNaN(this.lastMoney) && Math.abs(m - this.lastMoney) >= 1) {
      const d = m - this.lastMoney;
      this.deltaAcc += d;
      const now = performance.now();
      // aggregate small fare trickles; show big jumps (purchases) immediately
      if (Math.abs(d) >= 1000 || now - this.deltaAt > 2500) {
        this.flashDelta(this.deltaAcc);
        this.deltaAcc = 0;
        this.deltaAt = now;
      }
    }
    this.lastMoney = m;
    // clock
    const hr = g.hour();
    const b = TIME_BLOCKS[blockAt(hr)];
    this.timeEl.textContent = `Dag ${g.day() + 1} · ${clock(hr)}`;
    this.partEl.textContent = b.name;
    this.partEl.dataset.block = b.id;
    // speed
    const sIdx = SPEEDS.indexOf(g.speed);
    this.speedBtns.forEach((btn, i) => {
      btn.classList.toggle('cm-on', i === sIdx);
      btn.setAttribute('aria-pressed', String(i === sIdx));
    });
    // level
    const lvl = g.level;
    const lo = xpForLevel(lvl),
      hi = xpForLevel(lvl + 1);
    const f = Math.max(0, Math.min(1, (g.xp - lo) / Math.max(1, hi - lo)));
    this.lvlNum.textContent = String(lvl);
    this.xpFill.style.width = `${(f * 100).toFixed(1)}%`;
    this.xpWrap.title = `Level ${lvl} — ${int(g.xp)} / ${int(hi)} XP (nog ${int(hi - g.xp)} XP tot level ${lvl + 1})`;
    // passengers + reputation
    let pax = 0,
      repW = 0,
      rep = 0;
    const repParts: string[] = [];
    for (const c of g.cities) {
      pax += c.stats.delivered;
      rep += c.reputation * c.def.population;
      repW += c.def.population;
      repParts.push(`${c.def.name}: ${Math.round(c.reputation)}`);
    }
    this.paxEl.textContent = int(pax);
    this.paxWrap.title = `Reizigers vandaag op hun bestemming gebracht. Totaal: ${int(g.totalDelivered)}. Klik voor statistieken.`;
    const r = repW ? rep / repW : 0;
    this.repEl.textContent = `${Math.round(r)}/100`;
    this.repWrap.classList.toggle('cm-warn', r < 35);
    this.repWrap.title = `Reputatie bij de inwoners (${repParts.join(', ')}). Hoger = meer subsidie en reizigers.`;
  }

  private flashDelta(d: number): void {
    if (Math.abs(d) < 1) return;
    const el = h('span', { class: `cm-delta ${d > 0 ? 'cm-up' : 'cm-down'}` }, `${d > 0 ? '▲ +' : '▼ '}${eurShort(d)}`);
    this.deltaHost.append(el);
    this.moneyEl.classList.remove('cm-pulse-up', 'cm-pulse-down');
    void this.moneyEl.offsetWidth;
    this.moneyEl.classList.add(d > 0 ? 'cm-pulse-up' : 'cm-pulse-down');
    setTimeout(() => el.remove(), 1600);
    while (this.deltaHost.children.length > 3) this.deltaHost.firstElementChild!.remove();
  }

  setSaveState(text: string, kind: 'ok' | 'busy' | 'err' | ''): void {
    this.saveState.textContent = text;
    this.saveState.dataset.kind = kind;
  }
}
