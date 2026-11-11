// DEV-ONLY fake renderer: draws a schematic 2D map on a canvas so the UI can be tested.
import type { IGame, IRenderer, MapClick, MapMode, Overlay, PickInfo, Unsub } from '../../game/api';
import { MODES, ModeId } from '../../config';
import type { FakeCity } from './game';

export class FakeRenderer implements IRenderer {
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private game: IGame;
  private mode: MapMode = 'view';
  private sel: PickInfo | null = null;
  private draft: number[] = [];
  private draftMode: ModeId | null = null;
  private overlay: Overlay = 'none';
  private cbs = new Set<(c: MapClick) => void>();
  private cx = 0;
  private cy = 0;
  private scale = 0.26;

  constructor(container: HTMLElement, game: IGame) {
    this.game = game;
    this.canvas = document.createElement('canvas');
    this.canvas.style.cssText = 'width:100%;height:100%;display:block;background:#11151f';
    container.appendChild(this.canvas);
    this.ctx = this.canvas.getContext('2d')!;
    this.canvas.addEventListener('click', (e) => this.handleCanvasClick(e));
    (window as unknown as { __fakeRenderer: FakeRenderer }).__fakeRenderer = this;
  }
  private toScreen(x: number, y: number): [number, number] {
    const w = this.canvas.width,
      h = this.canvas.height;
    return [w / 2 + (x - this.cx) * this.scale, h / 2 - (y - this.cy) * this.scale];
  }
  private toWorld(px: number, py: number): [number, number] {
    const w = this.canvas.width,
      h = this.canvas.height;
    return [(px - w / 2) / this.scale + this.cx, -(py - h / 2) / this.scale + this.cy];
  }
  private handleCanvasClick(e: MouseEvent): void {
    const r = this.canvas.getBoundingClientRect();
    const [x, y] = this.toWorld(e.clientX - r.left, e.clientY - r.top);
    this.emit({ x, y, lon: 0, lat: 0, pick: this.pick(x, y) });
  }
  emit(c: MapClick): void {
    this.cbs.forEach((cb) => cb(c));
  }
  private pick(x: number, y: number): PickInfo {
    const tol = 14 / this.scale;
    for (const s of this.game.stops.values()) if (Math.hypot(s.x - x, s.y - y) < tol) return { kind: 'stop', stopId: s.d.id };
    if (this.mode === 'roads') {
      for (const c of this.game.cities) {
        const G = (c as unknown as FakeCity).G;
        for (let j = 0; j < G.nJ; j++) if (Math.hypot(G.jx[j] - x, G.jy[j] - y) < tol) return { kind: 'junction', city: c.index, junction: j };
        for (let e = 0; e < G.nE; e++) {
          const ax = G.jx[G.eA[e]], ay = G.jy[G.eA[e]], bx = G.jx[G.eB[e]], by = G.jy[G.eB[e]];
          const t = Math.max(0, Math.min(1, ((x - ax) * (bx - ax) + (y - ay) * (by - ay)) / ((bx - ax) ** 2 + (by - ay) ** 2)));
          if (Math.hypot(ax + t * (bx - ax) - x, ay + t * (by - ay) - y) < tol * 0.6) return { kind: 'edge', city: c.index, edge: e };
        }
      }
    }
    return { kind: 'map' };
  }
  setMode(mode: MapMode): void {
    this.mode = mode;
    this.canvas.style.cursor = mode === 'build' ? 'crosshair' : mode === 'roads' ? 'pointer' : 'default';
  }
  setSelection(sel: PickInfo | null): void {
    this.sel = sel;
  }
  setDraftLine(ids: number[], mode: ModeId | null): void {
    this.draft = ids;
    this.draftMode = mode;
  }
  setOverlay(o: Overlay): void {
    this.overlay = o;
  }
  onClick(cb: (c: MapClick) => void): Unsub {
    this.cbs.add(cb);
    return () => this.cbs.delete(cb);
  }
  flyToCity(id: string): void {
    const c = this.game.cityById(id) as unknown as FakeCity | undefined;
    if (c) {
      this.cx = c.cx;
      this.cy = c.cy;
    }
  }
  flyTo(x: number, y: number): void {
    this.cx = x;
    this.cy = y;
  }
  refresh(): void {}
  destroy(): void {
    this.canvas.remove();
  }
  frame(): void {
    const c = this.canvas;
    const dpr = 1;
    if (c.width !== c.clientWidth * dpr || c.height !== c.clientHeight * dpr) {
      c.width = c.clientWidth * dpr;
      c.height = c.clientHeight * dpr;
    }
    const ctx = this.ctx;
    ctx.fillStyle = '#121722';
    ctx.fillRect(0, 0, c.width, c.height);
    // blocks / land
    for (const city of this.game.cities) {
      const G = (city as unknown as FakeCity).G;
      ctx.fillStyle = 'rgba(70,90,120,0.10)';
      const [px, py] = this.toScreen(city.cx, city.cy);
      ctx.beginPath();
      ctx.arc(px, py, (city as unknown as FakeCity).radius * this.scale * 1.1, 0, Math.PI * 2);
      ctx.fill();
      // water
      ctx.strokeStyle = 'rgba(40,80,140,0.45)';
      ctx.lineWidth = 16;
      ctx.beginPath();
      for (let i = 0; i <= 40; i++) {
        const [sx, sy] = this.toScreen(city.cx - 1700 + i * 85, city.cy - 600 + Math.sin(i / 5) * 200);
        if (i) ctx.lineTo(sx, sy);
        else ctx.moveTo(sx, sy);
      }
      ctx.stroke();
      for (let e = 0; e < G.nE; e++) {
        const [ax, ay] = this.toScreen(G.jx[G.eA[e]], G.jy[G.eA[e]]);
        const [bx, by] = this.toScreen(G.jx[G.eB[e]], G.jy[G.eB[e]]);
        const cls = G.eCls[e];
        let col = cls <= 3 ? '#4a5470' : cls === 4 ? '#3a4259' : '#2c3245';
        if (this.overlay === 'congestion' || this.mode === 'roads') {
          const cg = (1 - Math.min(G.congestion(e * 2), G.congestion(e * 2 + 1))) / 0.93;
          col = cg < 0.3 ? '#3f9e62' : cg < 0.65 ? '#d19a3a' : '#c94b55';
        }
        const sel = this.sel?.kind === 'edge' && this.sel.edge === e;
        ctx.strokeStyle = sel ? '#4cc9f0' : col;
        ctx.lineWidth = sel ? 8 : cls <= 3 ? 6 : cls === 4 ? 4 : 2.5;
        ctx.beginPath();
        ctx.moveTo(ax, ay);
        ctx.lineTo(bx, by);
        ctx.stroke();
      }
      if (this.mode === 'roads')
        for (let j = 0; j < G.nJ; j++) {
          const [x, y] = this.toScreen(G.jx[j], G.jy[j]);
          const sel = this.sel?.kind === 'junction' && this.sel.junction === j;
          ctx.fillStyle = sel ? '#4cc9f0' : G.jCtrl[j] === 4 ? '#ffb547' : 'rgba(200,210,230,0.5)';
          ctx.beginPath();
          ctx.arc(x, y, sel ? 7 : 3.5, 0, Math.PI * 2);
          ctx.fill();
        }
      if (this.overlay === 'demand' && this.mode !== 'roads') {
        for (let i = 0; i < 18; i++) {
          const [x, y] = this.toScreen(city.cx + Math.sin(i * 2.3) * 1200, city.cy + Math.cos(i * 1.7) * 1100);
          const g = ctx.createRadialGradient(x, y, 0, x, y, 70);
          g.addColorStop(0, 'rgba(255,120,80,0.35)');
          g.addColorStop(1, 'rgba(255,120,80,0)');
          ctx.fillStyle = g;
          ctx.fillRect(x - 70, y - 70, 140, 140);
        }
      }
    }
    const drawPath = (ids: number[], color: string, width: number, dash: number[] = []) => {
      ctx.strokeStyle = color;
      ctx.lineWidth = width;
      ctx.setLineDash(dash);
      ctx.lineJoin = 'round';
      ctx.beginPath();
      ids.forEach((id, i) => {
        const s = this.game.stops.get(id);
        if (!s) return;
        const [x, y] = this.toScreen(s.x, s.y);
        if (i === 0) ctx.moveTo(x, y);
        else {
          const p = this.game.stops.get(ids[i - 1])!;
          const [px] = this.toScreen(p.x, p.y);
          ctx.lineTo(px, y);
          ctx.lineTo(x, y);
        }
      });
      ctx.stroke();
      ctx.setLineDash([]);
    };
    for (const l of this.game.lines.values()) {
      const sel = this.sel?.kind === 'line' && this.sel.lineId === l.d.id;
      if (sel) drawPath(l.d.stops, 'rgba(255,255,255,0.5)', 12);
      drawPath(l.d.stops, `rgb(${l.d.color})`, 6);
    }
    if (this.draftMode && this.draft.length) drawPath(this.draft, `rgb(${MODES[this.draftMode].color})`, 5, [10, 6]);
    for (const s of this.game.stops.values()) {
      const [x, y] = this.toScreen(s.x, s.y);
      const sel = this.sel?.kind === 'stop' && this.sel.stopId === s.d.id;
      ctx.fillStyle = '#fff';
      ctx.strokeStyle = `rgb(${MODES[s.d.mode].color})`;
      ctx.lineWidth = sel ? 5 : 3;
      ctx.beginPath();
      ctx.arc(x, y, sel ? 9 : 6, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
      if (this.scale > 0.2) {
        ctx.fillStyle = 'rgba(230,235,245,0.85)';
        ctx.font = '600 11px system-ui';
        ctx.fillText(s.d.name, x + 10, y - 8);
      }
    }
    // moving dots as vehicles
    const t = performance.now() / 1000;
    for (const l of this.game.lines.values()) {
      const ss = l.d.stops.map((id) => this.game.stops.get(id)).filter((s): s is NonNullable<typeof s> => !!s);
      if (ss.length < 2) continue;
      for (let k = 0; k < Math.min(l.d.fleet, 4); k++) {
        const f = ((t / 20 + k / Math.min(l.d.fleet, 4)) % 1) * (ss.length - 1);
        const i = Math.floor(f);
        const a = ss[i], b = ss[i + 1];
        const [ax, ay] = this.toScreen(a.x, a.y);
        const [bx, by] = this.toScreen(b.x, b.y);
        const u = f - i;
        // follow the L-shaped path: horizontal first, then vertical
        const x = u < 0.5 ? ax + (bx - ax) * u * 2 : bx;
        const y = u < 0.5 ? ay : ay + (by - ay) * ((u - 0.5) * 2);
        ctx.fillStyle = `rgb(${l.d.color})`;
        ctx.strokeStyle = '#fff';
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.roundRect(x - 7, y - 4, 14, 8, 3);
        ctx.fill();
        ctx.stroke();
      }
    }
  }
}

export function createFakeRenderer(container: HTMLElement, game: IGame): IRenderer {
  return new FakeRenderer(container, game);
}
