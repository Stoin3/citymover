// Application flow: login → continue/new → city picker → loading → game.
import type { IGame, IRenderer, SaveBackend, SaveData } from '../game/api';
import { CITY_BY_ID } from '../data/cities';
import { loginScreen, continueScreen, cityPickerScreen, loadingScreen } from './screens';
import { GameUI } from './gameUI';
import { initOverlays } from './overlays';
import { clear, h } from './dom';

export interface AppDeps {
  createGame: (save: SaveData | null, startCityId: string, onStatus: (s: string) => void) => Promise<IGame>;
  createRenderer: (container: HTMLElement, game: IGame) => IRenderer;
  saveBackend: SaveBackend;
}

export interface Session {
  game: IGame;
  renderer: IRenderer;
  ui: GameUI;
}

/**
 * Runs the pre-game flow and resolves once a game is running.
 * `uiRoot` hosts screens and the overlay UI, `mapEl` is the renderer container.
 */
export async function startApp(uiRoot: HTMLElement, mapEl: HTMLElement, deps: AppDeps): Promise<Session> {
  const { saveBackend: backend } = deps;
  clear(uiRoot);
  uiRoot.classList.add('cm-pregame');
  const screens = h('div', { class: 'cm-screens' });
  uiRoot.append(screens);
  initOverlays(uiRoot); // toasts + confirm dialogs on pre-game screens
  mapEl.hidden = true;

  let user = await backend.getUser().catch(() => null);
  if (!backend.isCloud() || !user) {
    await loginScreen(screens, backend);
    user = await backend.getUser().catch(() => null);
  }

  let save: SaveData | null = null;
  try {
    save = await backend.load();
  } catch (e) {
    console.warn('[ui] load failed', e);
  }

  for (;;) {
    let startCity = '';
    let useSave: SaveData | null = null;
    if (save) {
      const label = backend.isCloud() && user ? user.email.split('@')[0] : '';
      const choice = await continueScreen(screens, save, label);
      if (choice === 'continue') useSave = save;
    }
    if (!useSave) startCity = await cityPickerScreen(screens);

    const cityName = useSave ? (CITY_BY_ID.get(useSave.startCity)?.name ?? 'Spel') : (CITY_BY_ID.get(startCity)?.name ?? startCity);
    const result = await loadGame(uiRoot, screens, mapEl, deps, useSave, startCity, cityName);
    if (result === 'back') continue;
    return result;
  }
}

function loadGame(uiRoot: HTMLElement, screens: HTMLElement, mapEl: HTMLElement, deps: AppDeps, save: SaveData | null, startCity: string, cityName: string): Promise<Session | 'back'> {
  return new Promise((resolve) => {
    const attempt = async () => {
      const ld = loadingScreen(screens, cityName);
      try {
        const game = await deps.createGame(save, startCity, (s) => ld.status(s));
        ld.status('Kaart wordt opgebouwd…');
        // show map before creating the renderer so it has a size
        clear(uiRoot);
        uiRoot.classList.remove('cm-pregame');
        mapEl.hidden = false;
        await new Promise((r) => requestAnimationFrame(() => r(null)));
        const renderer = deps.createRenderer(mapEl, game);
        const ui = new GameUI(uiRoot, game, renderer, deps.saveBackend, { isNewGame: !save, onLogout: () => location.reload() });
        if (!save) void ui.save(false); // claim the slot for the new game
        resolve({ game, renderer, ui });
      } catch (e) {
        console.error('[ui] game start failed', e);
        mapEl.hidden = true;
        const msg = e instanceof Error ? e.message : String(e);
        ld.error(`Laden mislukt: ${msg}`, attempt, save ? undefined : () => resolve('back'));
      }
    };
    void attempt();
  });
}
