#!/usr/bin/env node
/* Headless smoke test: copy index.html, append a diagnostics harness that
 * boots the game, drives the player, and prints a JSON report into the DOM.
 *
 *   node tools/headless-check.js            # build the test page
 *   node tools/headless-check.js --run      # build + run chromium + print report
 */
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const root = path.resolve(__dirname, '..');
const out = '/tmp/maze-test.html';

const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');

/* installed before the game script so top-level errors are visible */
const prelude = `
<script>
window.__diag = { errors: [], boot: 'not-called', steps: [] };
window.addEventListener('error', (e) => window.__diag.errors.push('pageerror: ' + (e.message || e)), true);
window.addEventListener('unhandledrejection', (e) => window.__diag.errors.push('rejection: ' + (e.reason && e.reason.message || e.reason)));
const _ce = console.error;
console.error = function (...a) { window.__diag.errors.push('console: ' + a.map(String).join(' ')); _ce.apply(console, a); };
</script>
`;

const harness = `
<script>
/* ---- test harness, injected by tools/headless-check.js ---- */

function diagReport() {
  const d = window.__diag;
  const glErr = gl ? gl.getError() : 'no gl';
  d.report = {
    api: state.wasm ? state.wasm.maze_api_version() : null,
    dims: state.W + 'x' + state.H,
    lm: state.lmW + 'x' + state.lmH,
    torches: state.torches.length,
    doors: state.wasm ? state.wasm.maze_door_count() : 0,
    shrines: state.shrines.length,
    stairUp: state.stairUp.length,
    stairDown: state.stairDown.length,
    start: [state.px, state.py, state.yaw.toFixed(3)],
    seen: state.wasm ? state.wasm.maze_seen_count() : 0,
    litSubCells: state.wasm ? state.wasm.maze_compute_light(state.px, state.py, CFG.playerR, CFG.wallR) : 0,
    meshes: { wall: mWall.n / 8, floor: mFloor.n / 8, ceil: mCeil.n / 8, door: mDoor.n / 8, leaves: mLeaves.n / 8, sprite: mSprite.n / 6 },
    glError: glErr,
    glOk: !!gl,
    view: viewW + 'x' + viewH,
    fps: state.fps,
    started: started,
    bootErr: document.getElementById('bootErr').textContent,
    b64len: document.getElementById('mazeWasmB64').textContent.trim().length,
    steps: d.steps,
    errors: d.errors.slice(0, 8),
  };
  document.title = 'DIAG ' + JSON.stringify(d.report);
  const pre = document.createElement('pre');
  pre.id = 'diagjson';
  pre.textContent = JSON.stringify(d.report);
  document.body.appendChild(pre);
  return d.report;
}

window.__diagStep = function (keys, yaw, dt) {
  if (yaw) { state.yaw += yaw; updateBasis(); }
  for (const k of keys) window.dispatchEvent(new KeyboardEvent('keydown', { key: k }));
  for (let i = 0; i < 30; i++) { move(dt); updateDoors(dt); }
  for (const k of keys) window.dispatchEvent(new KeyboardEvent('keyup', { key: k }));
};

window.addEventListener('load', async () => {
  const D = window.__diag;
  try {
    await new Promise(r => setTimeout(r, 400));
    D.steps.push('after load: wasm=' + (state.wasm ? 'bound' : 'null') + ' gl=' + (gl ? 'ok' : 'null') + ' W=' + state.W);
    if (!state.wasm) {
      try { D.steps.push('acquireWasm api ' + await acquireWasm()); }
      catch (e) { D.steps.push('acquireWasm threw: ' + e.message); }
    }
    if (!gl) {
      try { initGL(); D.steps.push('initGL ok'); } catch (e) { D.steps.push('initGL threw: ' + e.message); }
    }
    if (!state.W) {
      try {
        const t = await loadDefaultMap();
        D.steps.push('map chars ' + t.length);
        loadMap(t, 'maze1.txt');
        D.steps.push('loadMap ok ' + state.W + 'x' + state.H);
      } catch (e) { D.steps.push('loadMap threw: ' + e.message); }
    }
    buildSettings(); buildCompass(); resize();
    document.getElementById('start').click();
    // a few seconds of simulated play
    window.__diagStep(['w'], 0, 1 / 60);
    window.__diagStep(['w'], Math.PI / 2, 1 / 60);
    window.__diagStep(['w', 'd'], 0, 1 / 60);
    window.__diagStep(['w'], -Math.PI / 2, 1 / 60);
    window.__diagStep(['s'], 0, 1 / 60);
    // walk straight into a wall and confirm we stop
    const before = [state.px, state.py];
    keys.add('w');
    for (let i = 0; i < 400; i++) { move(1 / 60); updateDoors(1 / 60); }
    keys.delete('w');
    window.__diag.wallTest = {
      before: [before[0].toFixed(2), before[1].toFixed(2)],
      after: [state.px.toFixed(2), state.py.toFixed(2)],
      insideWall: !!state.wasm.maze_solid(state.px | 0, state.py | 0),
    };
    // one arrow press = one turn; holding it (with key repeat) must not keep turning
    {
      const y0 = state.yaw;
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft' }));
      for (let i = 0; i < 240; i++) { runTurn(); render(0.5 + i * 0.016); }
      const y1 = state.yaw;
      for (let i = 0; i < 60; i++) {
        window.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', repeat: true }));
        runTurn();
      }
      const y2 = state.yaw;
      window.dispatchEvent(new KeyboardEvent('keyup', { key: 'ArrowLeft' }));
      const deg = (a) => +(a * 180 / Math.PI).toFixed(2);
      window.__diag.turnTest = {
        stepDeg: deg(y1 - y0),
        heldExtraDeg: deg(y2 - y1),
        expectedDeg: -20,
      };
    }
    // open a door ahead if there is one
    const hit = tryInteract();
    window.__diag.interacted = hit;
    for (let i = 0; i < 120; i++) { updateDoors(1 / 60); }
    window.__diag.frames = state.fps;
    // render a few real frames so GL errors surface
    for (let i = 0; i < 5; i++) { render(performance.now() / 1000 + i * 0.1); drawMinimap(); updateHud(); }
  } catch (e) {
    window.__diag.errors.push('harness: ' + (e && e.stack ? e.stack.split('\\n')[0] : e));
  }
  const r = diagReport();
  r.wallTest = window.__diag.wallTest;
  r.turnTest = window.__diag.turnTest;
  r.interacted = window.__diag.interacted;
  document.getElementById('diagjson').textContent = JSON.stringify(r);
  document.title = 'DIAG ' + JSON.stringify(r);
});
</script>
`;

/* insert right after the whole <body ...> open tag — slicing a fixed 5 chars
 * lands *inside* the tag and turns the prelude into attribute garbage */
const openTag = html.match(/<body[^>]*>/);
if (!openTag) throw new Error('no <body>');
const bodyStart = openTag.index + openTag[0].length;
const idx = html.lastIndexOf('</body>');
if (idx < 0) throw new Error('no </body>');
fs.writeFileSync(out, html.slice(0, bodyStart) + prelude + html.slice(bodyStart, idx) + harness + html.slice(idx));
console.log('wrote', out, fs.statSync(out).size, 'bytes');

if (process.argv.includes('--run')) {
  const flags = ['--headless=new', '--use-gl=angle', '--use-angle=swiftshader',
                 '--enable-unsafe-swiftshader', '--no-sandbox', '--disable-dev-shm-usage',
                 '--virtual-time-budget=12000', '--window-size=1280,800',
                 '--enable-logging=stderr', '--v=0'];
  const dom = execFileSync('chromium', [...flags, '--dump-dom', 'file://' + out], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  const m = dom.match(/<pre id="diagjson">([\s\S]*?)<\/pre>/);
  if (!m) { console.log('NO DIAG FOUND in DOM (length ' + dom.length + ')'); }
  else {
    const txt = m[1].replace(/&quot;/g, '"').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>');
    try { console.log(JSON.stringify(JSON.parse(txt), null, 2)); }
    catch (e) { console.log('RAW:', txt); }
  }
  execFileSync('chromium', [...flags.filter(f => f !== '--dump-dom'), '--screenshot=/tmp/maze-play.png', 'file://' + out],
              { encoding: 'utf8', stdio: ['ignore', 'ignore', 'ignore'] });
  console.log('screenshot -> /tmp/maze-play.png');
}
