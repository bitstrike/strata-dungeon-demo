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
  const glErr = gl ? gl.getError() : 'no gl';  d.report = {
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
    minimap: miniRevealStats(),
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

/* how much of the minimap has actually been charted, and how much of the
 * on-screen sheet is ink (i.e. not blank paper) */
function miniRevealStats() {
  /* these are top-level let bindings in the game script: visible as bare
   * identifiers from here, but NOT as window properties */
  if (typeof miniMem === 'undefined' || !miniMem || !miniCanvas) return { error: 'no minimap canvases' };
  const w = miniCanvas.width, h = miniCanvas.height;
  const img = miniMem.getContext('2d').getImageData(0, 0, w, h).data;
  let inked = 0;
  for (let i = 3; i < img.length; i += 4) if (img[i] > 8) inked++;
  const onScreen = miniCanvas.getContext('2d').getImageData(0, 0, w, h).data;
  let drawn = 0;
  for (let i = 3; i < onScreen.length; i += 4) if (onScreen[i] > 8) drawn++;
  return {
    canvas: w + 'x' + h,
    scale: miniScale,
    chartedPx: inked,
    drawnPx: drawn,
    totalPx: w * h,
    seenCells: state.wasm ? state.wasm.maze_seen_count() : 0,
  };
}

/* how many inked pixels the door / stair / sconce sheet currently carries */
function miniInkPixels() {
  const w = miniCanvas.width, h = miniCanvas.height;
  const img = miniInk.getContext('2d').getImageData(0, 0, w, h).data;
  let n = 0;
  for (let i = 3; i < img.length; i += 4) if (img[i] > 8) n++;
  return n;
}

/* toggle a charted door and confirm the minimap re-inks it */
function miniDoorInkTest() {
  const E = state.wasm;
  let id = -1;
  for (let i = 0; i < state.W * state.H && id < 0; i++) {
    if (state.grid[i] === TILE.DOOR && state.seen[i]) id = i;
  }
  if (id < 0) return { error: 'no charted door' };
  const x = id % state.W, y = (id / state.W) | 0;
  const wasOpen = state.doors[id] > 0;
  state.doorTarget.set(id, wasOpen ? 0 : 1);
  for (let i = 0; i < 120; i++) { updateDoors(1 / 60); drawMinimap(); }
  const nowOpen = state.doors[id] > 0;
  return {
    cell: [x, y],
    wasOpen, nowOpen,
    toggled: wasOpen !== nowOpen,
    inkBefore: window.__diag.miniInkBefore,
    inkAfter: miniInkPixels(),
    inkChanged: window.__diag.miniInkBefore !== miniInkPixels(),
  };
}

/* which way the minimap arrow actually points.  The chart, the ink and the
 * torch pool are identical for every heading, so differencing two panels leaves
 * only the arrow.  The chevron reaches 1.6 cells out at its point and only 1.1
 * at its wings, so the direction it indicates is the one whose ink reaches
 * farthest from the player. */
function miniHeadingTest() {
  const S = miniScale;
  const w = miniCanvas.width, h = miniCanvas.height;
  const keep = state.yaw;
  const facings = [['N', 0], ['E', Math.PI / 2], ['S', Math.PI], ['W', -Math.PI / 2]];

  const boneSet = () => {
    const img = miniCanvas.getContext('2d').getImageData(0, 0, w, h).data;
    const px = state.px * S, py = state.py * S;
    const set = new Set();
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = (y * w + x) * 4;
        if (img[i] > 205 && img[i + 1] > 185 && img[i + 2] > 150 && img[i + 3] > 200) {
          const dx = x + 0.5 - px, dy = y + 0.5 - py;
          if (dx * dx + dy * dy > 6.25 * S * S) continue;   /* the arrow only */
          set.add(y * w + x);
        }
      }
    }
    return set;
  };

  const sets = {};
  for (const [facing, yaw] of facings) {
    state.yaw = yaw;
    updateBasis();
    drawMinimap();
    sets[facing] = boneSet();
  }
  state.yaw = keep;
  updateBasis();

  const opposite = { N: 'S', S: 'N', E: 'W', W: 'E' };
  const DIRS = { N: [0, -1], E: [1, 0], S: [0, 1], W: [-1, 0] };
  const out = [];
  for (const [facing] of facings) {
    /* drop pixels the opposite heading shares — that removes any stair or
     * sconce ink that happens to sit next to the player */
    const other = sets[opposite[facing]];
    const pts = [];
    for (const idx of sets[facing]) {
      if (other.has(idx)) continue;
      const x = idx % w, y = (idx / w) | 0;
      pts.push([x + 0.5 - state.px * S, y + 0.5 - state.py * S]);
    }
    if (pts.length < 4) { out.push({ facing, error: 'no exclusive arrow pixels' }); continue; }
    let best = null, bestReach = -1, runner = -1;
    for (const name of ['N', 'E', 'S', 'W']) {
      const [ux, uy] = DIRS[name];
      let reach = 0;
      for (const [dx, dy] of pts) reach = Math.max(reach, dx * ux + dy * uy);
      if (reach > bestReach) { runner = bestReach; bestReach = reach; best = name; }
      else runner = Math.max(runner, reach);
    }
    out.push({ facing, points: best, reach: +bestReach.toFixed(2), runnerUp: +runner.toFixed(2), pixels: pts.length, ok: best === facing });
  }
  return out;
}

/* clicking the view must reclaim the pointer, but not while a card is open */
function pointerRecaptureTest() {
  let calls = 0;
  const orig = canvas.requestPointerLock;
  canvas.requestPointerLock = function () { calls++; return undefined; };
  const hint = () => document.getElementById('relock').classList.contains('on');

  setLocked(false);                       // pretend the browser handed the cursor back
  const hintWhenUnlocked = hint();
  canvas.dispatchEvent(new MouseEvent('mousedown', { button: 0 }));
  const clickRecaptures = calls > 0;

  openOverlay('settings');
  const before = calls;
  canvas.dispatchEvent(new MouseEvent('mousedown', { button: 0 }));
  const blockedInOverlay = calls === before;
  const hintInOverlay = hint();
  closeOverlays();

  canvas.requestPointerLock = orig;
  return { clickRecaptures, blockedInOverlay, hintWhenUnlocked, hintInOverlay };
}

/* every Torch & sight widget has to carry a plain-language tooltip */
function tooltipTest() {
  const rows = Array.from(document.querySelectorAll('#fields .field'));
  const thin = [];
  for (const row of rows) {
    const btn = row.querySelector('.info');
    const input = row.querySelector('input');
    const title = input ? (input.getAttribute('title') || '') : '';
    const name = row.querySelector('label').textContent.replace(/\s+/g, ' ').trim().slice(0, 22);
    if (!btn || title.length < 60) thin.push(name);
  }
  return { widgets: rows.length, withInfo: document.querySelectorAll('#fields .info').length, tooThin: thin };
}

window.addEventListener('load', async () => {
  const D = window.__diag;
  try {
    await new Promise(r => setTimeout(r, 400));
    D.steps.push('after load: wasm=' + (state.wasm ? 'bound' : 'null') + ' gl=' + (gl ? 'ok' : 'null') + ' W=' + state.W);    if (!state.wasm) {
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
    /* walk a serpentine route, rendering each step so the torch actually
     * charts cells, and watch the minimap fill in as we go */
    {
      const snap = () => miniRevealStats();
      window.__diag.miniBefore = snap();
      keys.add('w');
      let seed = 12345;
      const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
      let lx = state.px, ly = state.py, stuck = 0;
      for (let i = 0; i < 3000; i++) {
        render(i * 0.016 + 0.01);
        move(1 / 60);
        updateDoors(1 / 60);
        drawMinimap();
        /* wander like a player would: keep walking, and only when genuinely
         * blocked pick one of the open headings */
        if (Math.hypot(state.px - lx, state.py - ly) < 1e-3) stuck++; else stuck = 0;
        lx = state.px; ly = state.py;
        if (stuck > 8) {
          stuck = 0;
          tryInteract();          // a shut door ahead is worth opening before turning
          const nx = state.px | 0, ny = state.py | 0;
          const opts = [];
          for (let k = 0; k < 4; k++) {
            if (!state.wasm.maze_solid(nx + DXF[k], ny + DYF[k])) opts.push(k);
          }
          if (opts.length) {
            const k = opts[(rnd() * opts.length) | 0];
            state.yaw = Math.atan2(DXF[k], -DYF[k]);
            updateBasis();
          }
        }
      }
      keys.delete('w');
      window.__diag.miniAfter = snap();
      /* blow the minimap up so the screenshot shows the charted map legibly */
      miniCanvas.style.maxWidth = 'none';
      miniCanvas.style.maxHeight = 'none';
      miniCanvas.style.width = (miniCanvas.width * 2) + 'px';
      miniCanvas.style.height = (miniCanvas.height * 2) + 'px';
      miniCanvas.style.imageRendering = 'pixelated';
    }
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
    /* turning: a lone tap lands one readable 20° nudge, holding the arrow keeps
     * sweeping like holding W keeps you walking, and releasing stops it dead */
    {
      /* wrap-aware angle difference: yaw is normalised to (-pi, pi], so a raw
       * subtraction can report a whole-turn artefact */
      const deg = (a) => +(a * 180 / Math.PI).toFixed(2);
      const delta = (a, b) => {
        let d = b - a;
        while (d > Math.PI) d -= 2 * Math.PI;
        while (d < -Math.PI) d += 2 * Math.PI;
        return deg(d);
      };
      const y0 = state.yaw;
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft' }));
      window.dispatchEvent(new KeyboardEvent('keyup', { key: 'ArrowLeft' }));   // a tap: press and let go
      for (let i = 0; i < 240; i++) { runTurn(1 / 60); render(0.5 + i * 0.016); }
      const y1 = state.yaw;                       // one tap = one 20° nudge
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft' }));
      for (let i = 0; i < 60; i++) runTurn(1 / 60);   // held for a full second
      const y2 = state.yaw;                       // ...and it kept sweeping
      for (let i = 0; i < 60; i++) runTurn(1 / 60);   // still held, nothing new pressed
      const y3 = state.yaw;
      window.dispatchEvent(new KeyboardEvent('keyup', { key: 'ArrowLeft' }));
      for (let i = 0; i < 60; i++) runTurn(1 / 60);   // released: motion stops
      const y4 = state.yaw;
      const rateDeg = +(CFG.turnRate * 180 / Math.PI).toFixed(1);
      window.__diag.turnTest = {
        tapDeg: delta(y0, y1),
        heldDeg: delta(y1, y2),
        stillHeldDeg: delta(y2, y3),
        afterReleaseDeg: delta(y3, y4),
        expectTapDeg: -20,
        /* holding presses the key once more, so the first second carries the
         * fresh 20° nudge plus a full second of sweeping */
        expectHeldDeg: -(20 + rateDeg),
        expectStillHeldDeg: -rateDeg,
      };
    }
    window.__diag.miniHeading = miniHeadingTest();
    window.__diag.pointer = pointerRecaptureTest();
    window.__diag.tooltips = tooltipTest();
    // open a door ahead if there is one
    window.__diag.miniInkBefore = miniInkPixels();
    const hit = tryInteract();
    window.__diag.interacted = hit;
    for (let i = 0; i < 120; i++) { updateDoors(1 / 60); drawMinimap(); }
    window.__diag.miniDoor = miniDoorInkTest();
    window.__diag.frames = state.fps;
    // render a few real frames so GL errors surface
    for (let i = 0; i < 5; i++) { render(performance.now() / 1000 + i * 0.1); drawMinimap(); updateHud(); }
  } catch (e) {
    window.__diag.errors.push('harness: ' + (e && e.stack ? e.stack.split('\\n')[0] : e));
  }
  const r = diagReport();
  r.wallTest = window.__diag.wallTest;
  r.turnTest = window.__diag.turnTest;
  r.miniBefore = window.__diag.miniBefore;
  r.miniAfter = window.__diag.miniAfter;
  r.miniDoor = window.__diag.miniDoor;
  r.miniHeading = window.__diag.miniHeading;
  r.pointer = window.__diag.pointer;
  r.tooltips = window.__diag.tooltips;
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
