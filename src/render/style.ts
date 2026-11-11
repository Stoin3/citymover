// Injected CSS for renderer-owned DOM (city markers). Classes are prefixed `cm-r-`.
const CSS = `
.cm-r-marker{display:flex;align-items:center;gap:5px;padding:4px 9px 4px 7px;border-radius:14px;
  font:600 12px/1.2 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;white-space:nowrap;cursor:pointer;
  box-shadow:0 2px 8px rgba(0,0,0,.35);user-select:none;width:max-content;position:relative;
  transition:opacity .2s ease, filter .12s ease}
.cm-r-marker:hover{filter:brightness(1.08);z-index:2}
.cm-r-marker::after{content:"";position:absolute;left:50%;bottom:-6px;margin-left:-6px;border:6px solid transparent;
  border-bottom:0;border-top-color:inherit}
.cm-r-marker .cm-r-ico{font-size:12px;line-height:1}
.cm-r-marker .cm-r-cost{font-weight:500;opacity:.9;font-size:11px}
.cm-r-unlocked{background:#ffffff;color:#13203a;border-color:#ffffff}
.cm-r-unlocked .cm-r-dot{width:8px;height:8px;border-radius:50%;background:#2dbd6e;box-shadow:0 0 0 2px rgba(45,189,110,.3)}
.cm-r-unlockable{background:#ffb703;color:#2a1a00;border-color:#ffb703;animation:cm-r-pulse 2s ease-in-out infinite}
.cm-r-unlockable.cm-r-noafford{background:#d9c08a;border-color:#d9c08a;animation:none}
.cm-r-locked{background:rgba(40,46,60,.82);color:#b9c0cc;border-color:rgba(40,46,60,.82);font-weight:500}
.cm-r-hidden{opacity:0;pointer-events:none}
@keyframes cm-r-pulse{0%,100%{box-shadow:0 2px 8px rgba(0,0,0,.35),0 0 0 0 rgba(255,183,3,.6)}
  50%{box-shadow:0 2px 8px rgba(0,0,0,.35),0 0 0 8px rgba(255,183,3,0)}}
`;

export function injectRendererStyle(): void {
  if (document.getElementById('cm-r-style')) return;
  const el = document.createElement('style');
  el.id = 'cm-r-style';
  el.textContent = CSS;
  document.head.appendChild(el);
}
