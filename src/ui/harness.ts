// DEV-ONLY: mounts the UI against stub game/renderer/save modules.
// Open /ui-harness.html?screen=game&panel=line  (screens: flow, login, local, continue, picker, loading, game)
import '../style.css';
import { FakeGame, createFakeGame } from './__stubs__/game';
import { createFakeRenderer } from './__stubs__/renderer';
import { createFakeBackend } from './__stubs__/save';
import { startApp, Session } from './app';
import { GameUI } from './gameUI';
import { loginScreen, continueScreen, cityPickerScreen, loadingScreen } from './screens';
import { initOverlays, levelUpModal, helpOverlay, toast } from './overlays';
import { LinePanel, StopPanel, LinesListPanel } from './linePanels';
import { RoadPanel, JunctionPanel } from './roadPanels';
import { xpForLevel } from '../config';

const q = new URLSearchParams(location.search);
const screenName = q.get('screen') ?? 'game';
const panel = q.get('panel') ?? '';
const level = Number(q.get('level') ?? '0');
const uiRoot = document.getElementById('cm-root')!;
const mapEl = document.getElementById('map')!;

function loop(s: Session): void {
  let last = performance.now();
  const f = (now: number) => {
    const dt = Math.min(0.25, (now - last) / 1000);
    last = now;
    s.game.tick(dt);
    s.renderer.frame();
    s.ui.frame(now);
    requestAnimationFrame(f);
  };
  requestAnimationFrame(f);
}

async function main(): Promise<void> {
  const fakeSave = new FakeGame().serialize();
  if (screenName === 'flow') {
    const backend = createFakeBackend({ cloud: q.get('cloud') === '1', loggedIn: false, save: q.get('save') === '1' ? fakeSave : null });
    loop(await startApp(uiRoot, mapEl, { createGame: createFakeGame, createRenderer: createFakeRenderer, saveBackend: backend }));
    return;
  }
  if (screenName !== 'game') {
    uiRoot.classList.add('cm-pregame');
    const screens = document.createElement('div');
    screens.className = 'cm-screens';
    uiRoot.append(screens);
    initOverlays(uiRoot);
    if (screenName === 'login') await loginScreen(screens, createFakeBackend({ cloud: true, loggedIn: false, save: null }));
    else if (screenName === 'local') await loginScreen(screens, createFakeBackend({ cloud: false, loggedIn: false, save: null }));
    else if (screenName === 'continue') await continueScreen(screens, fakeSave, 'speler');
    else if (screenName === 'picker') await cityPickerScreen(screens);
    else if (screenName === 'loading') loadingScreen(screens, 'Amsterdam').status('Wegennet opbouwen… (12.430 wegen)');
    return;
  }
  // direct game screen
  try {
    if (panel !== 'help') localStorage.setItem('cm-help-seen', '1');
    else localStorage.removeItem('cm-help-seen');
  } catch {
    /* ignore */
  }
  const game = new FakeGame();
  if (level) game.xp = xpForLevel(level) + 120;
  mapEl.hidden = false;
  const renderer = createFakeRenderer(mapEl, game);
  const ui = new GameUI(uiRoot, game, renderer, createFakeBackend({ cloud: q.get('cloud') === '1', loggedIn: true, save: null }));
  (window as unknown as { __ui: GameUI }).__ui = ui;
  const firstLine = [...game.lines.keys()][0];
  const firstStop = [...game.stops.keys()][2];
  switch (panel) {
    case 'line':
      ui.openPanel(new LinePanel(ui, firstLine));
      break;
    case 'lines':
      ui.openPanel(new LinesListPanel(ui));
      break;
    case 'stop':
      ui.openPanel(new StopPanel(ui, firstStop));
      break;
    case 'road':
      ui.setTool('roads');
      ui.openPanel(new RoadPanel(ui, 0, 2 * 12 * 2 + 9));
      break;
    case 'junction':
      ui.setTool('roads');
      ui.openPanel(new JunctionPanel(ui, 0, 5 * 12 + 5));
      break;
    case 'region':
      ui.openRegion();
      break;
    case 'finance':
      ui.openFinance();
      break;
    case 'stats':
      ui.openStats();
      break;
    case 'settings':
      ui.openSettings();
      break;
    case 'builder':
      ui.startBuilder('bus');
      break;
    case 'levelup':
      levelUpModal(3, ['Tram', 'Rotondes']);
      break;
    case 'help':
      helpOverlay();
      break;
  }
  if (q.get('toast')) {
    toast('Bus 2 heeft te weinig voertuigen voor de ochtendspits.', 'warn');
    toast('Ongeluk in Delft: auto reed te hard op de Westvest', 'bad', { icon: '💥', action: { label: 'Bekijk', run: () => {} } });
  }
  loop({ game, renderer, ui });
}

void main();
