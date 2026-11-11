// Left toolbar: tools, build buttons per transport mode, panels.
import { MODE_LIST, ModeId } from '../config';
import type { GameUI } from './gameUI';
import { h, rgb } from './dom';

interface ToolBtn {
  el: HTMLButtonElement;
  active: () => boolean;
  locked?: () => number; // 0 = unlocked, else required level
}

export class Toolbar {
  el: HTMLElement;
  private ui: GameUI;
  private btns: ToolBtn[] = [];

  constructor(ui: GameUI) {
    this.ui = ui;
    this.el = h('nav', { class: 'cm-toolbar cm-glass', 'aria-label': 'Gereedschap' });
    const add = (icon: string, label: string, title: string, onclick: () => void, active: () => boolean, extra?: { color?: string; locked?: () => number }) => {
      const lockEl = h('span', { class: 'cm-tool-lock' });
      const el = h(
        'button',
        { class: 'cm-tool', title, 'aria-label': title, onclick, style: extra?.color ? `--c:${extra.color}` : undefined },
        h('span', { class: 'cm-tool-ico' }, icon),
        h('span', { class: 'cm-tool-label' }, label),
        lockEl,
      );
      this.el.append(el);
      this.btns.push({ el, active, locked: extra?.locked });
      return el;
    };
    const sep = () => this.el.append(h('div', { class: 'cm-tool-sep' }));

    add('🔍', 'Bekijken', 'Bekijken: klik op haltes, lijnen en voertuigen', () => ui.setTool('view'), () => ui.tool === 'view' && !ui.isPanel('lines'));
    add('🛣️', 'Wegen', 'Wegen: pas snelheid, rijrichting, rijstroken en kruispunten aan', () => ui.setTool('roads'), () => ui.tool === 'roads');
    add('🗺️', 'Lijnen', 'Overzicht van al je lijnen', () => ui.openLines(), () => ui.isPanel('lines'));
    sep();
    for (const m of MODE_LIST) {
      add(
        m.icon,
        m.name,
        `${m.name}lijn aanleggen`,
        () => ui.startBuilder(m.id as ModeId),
        () => ui.tool === 'build' && ui.builder?.mode === m.id,
        { color: rgb(m.color), locked: () => (ui.game.modeUnlocked(m.id) ? 0 : m.unlockLevel) },
      );
    }
    sep();
    add('🏙️', 'Regio', 'Steden & regio: ontgrendel steden, beheer snelwegen', () => ui.openRegion(), () => ui.isPanel('region'));
    add('📊', 'Financiën', 'Financiën: inkomsten en uitgaven', () => ui.openFinance(), () => ui.isPanel('finance'));
    add('📈', 'Statistiek', 'Statistieken: reizigers per uur en vervoerswijzen', () => ui.openStats(), () => ui.isPanel('stats'));
    add('⚙️', 'Instellingen', 'Instellingen: weergave en kaartlagen', () => ui.openSettings(), () => ui.isPanel('settings'));
  }

  update(): void {
    for (const b of this.btns) {
      const on = b.active();
      b.el.classList.toggle('cm-on', on);
      b.el.setAttribute('aria-pressed', String(on));
      if (b.locked) {
        const lvl = b.locked();
        b.el.classList.toggle('cm-locked', lvl > 0);
        const lockEl = b.el.querySelector('.cm-tool-lock')!;
        const txt = lvl > 0 ? `🔒 ${lvl}` : '';
        if (lockEl.textContent !== txt) lockEl.textContent = txt;
        const base = b.el.getAttribute('aria-label')!.replace(/ \(.*\)$/, '');
        b.el.title = lvl > 0 ? `${base} (vergrendeld — beschikbaar vanaf level ${lvl})` : base;
      }
    }
  }
}
