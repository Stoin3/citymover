// In-game UI orchestrator: HUD, toolbar, side panel, click routing, events, autosave.
import type { IGame, IRenderer, MapClick, Overlay, SaveBackend, Unsub, MapMode } from '../game/api';
import { MODES, ModeId } from '../config';
import { h, eur, isTyping } from './dom';
import { Hud, SPEEDS } from './hud';
import { Toolbar } from './toolbar';
import { Panel } from './panel';
import { toast, levelUpModal, helpOverlay, initOverlays } from './overlays';
import { LineBuilderPanel, LinePanel, LinesListPanel, StopPanel } from './linePanels';
import { RoadPanel, JunctionPanel } from './roadPanels';
import { RegionPanel } from './regionPanel';
import { FinancePanel, StatsPanel, SettingsPanel, ledgerResult } from './infoPanels';

export type Tool = MapMode;

const LS = {
  help: 'cm-help-seen',
  maxEntities: 'cm-max-entities',
  overlay: 'cm-overlay',
};
function lsGet(k: string): string | null {
  try {
    return localStorage.getItem(k);
  } catch {
    return null;
  }
}
function lsSet(k: string, v: string): void {
  try {
    localStorage.setItem(k, v);
  } catch {
    /* ignore */
  }
}

const AUTOSAVE_MS = 60_000;

export class GameUI {
  game: IGame;
  renderer: IRenderer;
  backend: SaveBackend;
  root: HTMLElement;
  tool: Tool = 'view';
  panel: Panel | null = null;
  overlay: Overlay = 'none';
  cityLoadStatus = new Map<string, string>();

  private hud: Hud;
  private toolbar: Toolbar;
  private panelHost: HTMLElement;
  private modeHint: HTMLElement;
  private unsubs: Unsub[] = [];
  private lastHud = 0;
  private lastPanel = 0;
  private lastSpeed = 1;
  private saving = false;
  private lastSaveAt = 0;
  private autosaveTimer = 0;
  private keyHandler: (e: KeyboardEvent) => void;
  private onLogout: () => void;

  constructor(root: HTMLElement, game: IGame, renderer: IRenderer, backend: SaveBackend, opts: { onLogout?: () => void; isNewGame?: boolean } = {}) {
    this.root = root;
    this.game = game;
    this.renderer = renderer;
    this.backend = backend;
    this.onLogout = opts.onLogout ?? (() => location.reload());

    root.classList.add('cm-game');
    this.hud = new Hud(this);
    this.toolbar = new Toolbar(this);
    this.panelHost = h('div', { class: 'cm-panel-host' });
    this.modeHint = h('div', { class: 'cm-mode-hint cm-glass', hidden: true });
    root.append(this.hud.el, this.toolbar.el, this.panelHost, this.modeHint);
    initOverlays(root);

    // settings
    const me = Number(lsGet(LS.maxEntities));
    if (me >= 2000 && me <= 40000) game.maxEntities = me;
    const ov = lsGet(LS.overlay) as Overlay | null;
    if (ov && ['none', 'congestion', 'safety', 'demand'].includes(ov)) this.setOverlay(ov);
    renderer.setMode('view');

    // events
    this.unsubs.push(
      renderer.onClick((c) => this.handleClick(c)),
      game.on('toast', (t) => toast(t.msg, t.kind)),
      game.on('accident', (a) => {
        const city = game.cities[a.city];
        toast(`Ongeluk${city ? ` in ${city.def.name}` : ''}: ${a.cause}`, 'bad', { icon: '💥', action: { label: 'Bekijk', run: () => renderer.flyTo(a.x, a.y, 16.5) } });
      }),
      game.on('levelup', (l) => {
        levelUpModal(l.level, l.unlocked);
        this.toolbar.update();
      }),
      game.on('day', (d) => {
        const r = ledgerResult(d.ledger);
        toast(`Dag ${d.day} afgesloten — resultaat ${eur(r)} (kaartverkoop ${eur(d.ledger.fares)}, subsidie ${eur(d.ledger.subsidy)})`, r >= 0 ? 'good' : 'warn', { icon: '🌙', ms: 8000, action: { label: 'Financiën', run: () => this.openFinance() } });
        void this.save(false);
      }),
      game.on('changed', (c) => {
        if (this.panel) this.panel.onChanged(c.what);
        this.toolbar.update();
      }),
      game.on('cityLoading', (c) => {
        if (c.status === null) this.cityLoadStatus.delete(c.id);
        else this.cityLoadStatus.set(c.id, c.status);
      }),
    );

    this.keyHandler = (e) => this.onKey(e);
    window.addEventListener('keydown', this.keyHandler);
    this.autosaveTimer = window.setInterval(() => void this.save(false), AUTOSAVE_MS);
    window.addEventListener('beforeunload', this.onUnload);

    this.hud.update();
    this.toolbar.update();
    this.hud.setSaveState(opts.isNewGame ? '' : 'Geladen ✓', 'ok');
    if (!lsGet(LS.help)) {
      const prev = game.speed;
      game.speed = 0;
      helpOverlay(() => {
        lsSet(LS.help, '1');
        game.speed = prev || 1;
      });
    }
  }

  private onUnload = () => {
    // best effort: local backends save synchronously enough
    if (!this.backend.isCloud()) void this.backend.save(this.game.serialize());
  };

  // ------------------------------------------------------------ loop
  /** call every animation frame (after game.tick + renderer.frame) */
  frame(now = performance.now()): void {
    if (now - this.lastHud > 250) {
      this.lastHud = now;
      this.hud.update();
      this.toolbar.update();
    }
    if (now - this.lastPanel > 500) {
      this.lastPanel = now;
      const p = this.panel;
      if (p) {
        if (!p.isValid()) this.closePanel(p);
        else p.update();
      }
    }
  }

  // ------------------------------------------------------------ speed / tools
  setSpeed(s: number): void {
    if (s > 0) this.lastSpeed = s;
    this.game.speed = s;
    this.hud.update();
  }
  togglePause(): void {
    this.setSpeed(this.game.speed === 0 ? this.lastSpeed || 1 : 0);
  }

  get builder(): LineBuilderPanel | null {
    return this.panel instanceof LineBuilderPanel ? this.panel : null;
  }

  isPanel(key: string): boolean {
    return this.panel?.key === key;
  }

  setTool(t: Tool): void {
    if (t === 'build') return; // use startBuilder
    if (this.builder) this.closePanel(this.builder);
    this.tool = t;
    this.renderer.setMode(t);
    if (t === 'roads') {
      this.showModeHint('🛣️ Wegen bewerken — klik op een weg of kruispunt');
      if (this.overlay === 'none') this.renderer.setOverlay('congestion');
    } else {
      this.showModeHint(null);
      this.renderer.setOverlay(this.overlay);
      if (this.panel instanceof RoadPanel || this.panel instanceof JunctionPanel) this.closePanel(this.panel);
    }
    this.toolbar.update();
  }

  private showModeHint(text: string | null): void {
    this.modeHint.hidden = !text;
    this.modeHint.textContent = text ?? '';
  }

  startBuilder(mode: ModeId, editLineId: number | null = null, initial: number[] = []): void {
    const def = MODES[mode];
    if (!this.game.modeUnlocked(mode)) {
      toast(`${def.icon} ${def.name} is beschikbaar vanaf level ${def.unlockLevel}.`, 'info', { icon: '🔒' });
      return;
    }
    if (this.builder && this.builder.mode === mode && editLineId === null && !initial.length) {
      // toggle off
      this.closePanel(this.builder);
      return;
    }
    this.tool = 'build';
    this.showModeHint(`${def.icon} ${def.name}lijn aanleggen — klik op de kaart om haltes te plaatsen. Esc = annuleren.`);
    this.renderer.setOverlay(this.overlay === 'none' && (mode === 'bus' || mode === 'tram' || mode === 'metro') ? 'demand' : this.overlay);
    this.openPanel(new LineBuilderPanel(this, mode, editLineId, initial));
  }

  // ------------------------------------------------------------ panels
  openPanel(p: Panel): void {
    if (this.panel && this.panel.key === p.key && !(p instanceof LineBuilderPanel)) {
      this.panel.rebuild();
      return;
    }
    if (this.panel) this.closePanel(this.panel, true);
    this.panel = p;
    this.panelHost.append(p.el);
    p.mount();
    p.el.classList.add('cm-in');
    document.body.classList.add('cm-panel-open');
    this.renderer.setSelection(p.selection());
    this.toolbar.update();
  }

  closePanel(p: Panel | null = this.panel, replacing = false): void {
    if (!p || p !== this.panel) return;
    this.panel = null;
    p.onClose();
    p.el.remove();
    document.body.classList.remove('cm-panel-open');
    this.renderer.setSelection(null);
    if (p instanceof LineBuilderPanel) {
      // leaving the builder (also when replaced by the new line's panel)
      this.tool = 'view';
      this.renderer.setMode('view');
      this.renderer.setOverlay(this.overlay);
      this.showModeHint(null);
    }
    void replacing;
    this.toolbar.update();
  }

  openLine(id: number): void {
    if (this.tool === 'build') this.tool = 'view';
    this.openPanel(new LinePanel(this, id));
  }
  openStop(id: number): void {
    this.openPanel(new StopPanel(this, id));
  }
  openLines(): void {
    if (this.isPanel('lines')) return this.closePanel();
    this.openPanel(new LinesListPanel(this));
  }
  openRegion(focus: { city?: string; highway?: string } = {}): void {
    if (this.panel instanceof RegionPanel) {
      if (!focus.city && !focus.highway) return this.closePanel();
      this.panel.setFocus(focus);
      this.renderer.setSelection(this.panel.selection());
      return;
    }
    this.openPanel(new RegionPanel(this, focus));
  }
  openFinance(): void {
    if (this.isPanel('finance')) return this.closePanel();
    this.openPanel(new FinancePanel(this));
  }
  openStats(): void {
    if (this.isPanel('stats')) return this.closePanel();
    this.openPanel(new StatsPanel(this));
  }
  openSettings(): void {
    if (this.isPanel('settings')) return this.closePanel();
    this.openPanel(new SettingsPanel(this));
  }
  showHelp(): void {
    helpOverlay(() => lsSet(LS.help, '1'));
  }

  setOverlay(o: Overlay): void {
    this.overlay = o;
    this.renderer.setOverlay(o);
    lsSet(LS.overlay, o);
  }
  setMaxEntities(n: number): void {
    this.game.maxEntities = n;
    lsSet(LS.maxEntities, String(n));
  }

  // ------------------------------------------------------------ map clicks
  handleClick(c: MapClick): void {
    const p = c.pick;
    if (this.tool === 'build' && this.builder) {
      this.builder.handleClick(c);
      return;
    }
    switch (p.kind) {
      case 'stop':
        this.openStop(p.stopId);
        break;
      case 'line':
      case 'vehicle':
        this.openLine(p.lineId);
        break;
      case 'city':
        this.openRegion({ city: p.cityId });
        break;
      case 'highway':
        this.openRegion({ highway: p.key });
        break;
      case 'edge':
        if (this.tool === 'roads' || this.game.cities[p.city]) this.openPanel(new RoadPanel(this, p.city, p.edge));
        break;
      case 'junction':
        this.openPanel(new JunctionPanel(this, p.city, p.junction));
        break;
      case 'map':
      default: {
        // clicking empty map closes inspection panels (not tool panels)
        const k = this.panel?.key ?? '';
        if (/^(line|stop|edge|junction):/.test(k)) this.closePanel();
        else this.renderer.setSelection(this.panel?.selection() ?? null);
      }
    }
  }

  // ------------------------------------------------------------ keyboard
  private onKey(e: KeyboardEvent): void {
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    if (document.querySelector('.cm-modal-back')) return;
    if (e.key === 'Escape') {
      if (isTyping()) {
        (document.activeElement as HTMLElement).blur();
        return;
      }
      if (this.panel) this.closePanel();
      else if (this.tool !== 'view') this.setTool('view');
      return;
    }
    if (isTyping()) return;
    if (e.key === ' ' || e.code === 'Space') {
      e.preventDefault();
      this.togglePause();
    } else if (e.key >= '1' && e.key <= '4') {
      this.setSpeed(SPEEDS[Number(e.key)]);
    } else if (e.key === 'b' || e.key === 'B') {
      this.startBuilder('bus');
    } else if (e.key === 'r' || e.key === 'R') {
      this.setTool('roads');
    } else if (e.key === 'v' || e.key === 'V') {
      this.setTool('view');
    }
  }

  // ------------------------------------------------------------ saving
  async save(manual: boolean): Promise<void> {
    if (this.saving) return;
    this.saving = true;
    this.hud.setSaveState('Opslaan…', 'busy');
    try {
      const err = await this.backend.save(this.game.serialize());
      if (err) {
        this.hud.setSaveState('Fout bij opslaan', 'err');
        toast(`Opslaan mislukt: ${err}`, 'bad');
      } else {
        this.lastSaveAt = Date.now();
        this.hud.setSaveState('Opgeslagen ✓', 'ok');
        if (manual) toast('Spel opgeslagen.', 'good', { ms: 2000, icon: '💾' });
      }
    } catch (ex) {
      this.hud.setSaveState('Fout bij opslaan', 'err');
      toast(`Opslaan mislukt: ${ex instanceof Error ? ex.message : String(ex)}`, 'bad');
    } finally {
      this.saving = false;
      this.hud.saveBtn.title = this.lastSaveAt ? `Nu opslaan (laatst: ${new Date(this.lastSaveAt).toLocaleTimeString('nl-NL', { hour: '2-digit', minute: '2-digit' })})` : 'Nu opslaan';
    }
  }

  async logout(): Promise<void> {
    await this.save(false);
    if (this.backend.isCloud()) await this.backend.signOut();
    this.destroy();
    this.onLogout();
  }

  destroy(): void {
    for (const u of this.unsubs) u();
    this.unsubs = [];
    window.removeEventListener('keydown', this.keyHandler);
    window.removeEventListener('beforeunload', this.onUnload);
    clearInterval(this.autosaveTimer);
  }
}
