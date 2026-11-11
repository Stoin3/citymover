// CityMover entry point: wires the game core, renderer, save backend and UI,
// and runs the main loop.
import './style.css';
import { createGame } from './game/game';
import { createRenderer } from './render/renderer';
import { saveBackend } from './save/supabase';
import { startApp, Session } from './ui/app';

const uiRoot = document.getElementById('cm-root')!;
const mapEl = document.getElementById('map')!;

function runLoop(s: Session): void {
  let last = performance.now();
  let errors = 0;
  const loop = (now: number) => {
    const dt = Math.min(0.25, Math.max(0, (now - last) / 1000)); // clamp after tab switches
    last = now;
    try {
      s.game.tick(dt);
    } catch (e) {
      if (errors++ < 5) console.error('[main] game.tick failed', e);
    }
    try {
      s.renderer.frame();
    } catch (e) {
      if (errors++ < 5) console.error('[main] renderer.frame failed', e);
    }
    s.ui.frame(now);
    requestAnimationFrame(loop);
  };
  requestAnimationFrame(loop);
}

startApp(uiRoot, mapEl, { createGame, createRenderer, saveBackend })
  .then((s) => {
    // handy for debugging from the browser console
    (window as unknown as { cityMover: Session }).cityMover = s;
    runLoop(s);
  })
  .catch((e) => {
    console.error(e);
    uiRoot.textContent = 'CityMover kon niet starten: ' + (e instanceof Error ? e.message : String(e));
  });
