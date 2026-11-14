#!/usr/bin/env node
/* Visual pass: build a page that is left in a specific UI state, then screenshot
 * it with chromium so the settings tooltips and the minimap arrow can be judged
 * by eye rather than by numbers.
 *
 *   node tools/visual-check.js            # build /tmp/maze-visual.html
 *   node tools/visual-check.js --run      # build + screenshot to /tmp/maze-visual.png
 *   node tools/visual-check.js --mini     # gameplay HUD only, minimap upscaled
 */
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const root = path.resolve(__dirname, '..');
const mini = process.argv.includes('--mini');
const tag = mini ? '-mini' : '';
const out = '/tmp/maze-visual' + tag + '.html';
const shot = '/tmp/maze-visual' + tag + '.png';

const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');

const script = `
<script>
window.addEventListener('load', async () => {
  try {
    await new Promise(r => setTimeout(r, 1200));
    if (!started) document.getElementById('start').click();

    /* walk a little so the chart has something on it */
    keys.add('w');
    for (let i = 0; i < 900; i++) { render(i * 0.016 + 0.01); move(1 / 60); updateDoors(1 / 60); drawMinimap(); }
    keys.delete('w');
    /* face east: the heading used to read mirrored on the chart */
    state.yaw = Math.PI / 2;
    updateBasis();
    for (let i = 0; i < 6; i++) { render(20 + i * 0.016); drawMinimap(); updateHud(); }

    /* open settings and hold a tooltip open over the two flame widgets */
    openOverlay('settings');
    const btn = document.getElementById('i_playerR');
    if (!btn) throw new Error('settings fields were never built');
    btn.dispatchEvent(new MouseEvent('mouseenter'));
    btn.focus();

    /* make the chart legible in the shot */
    const mini = document.getElementById('minimap');
    mini.style.maxWidth = 'none';
    mini.style.maxHeight = 'none';
    mini.style.width = (mini.width * 2) + 'px';
    mini.style.height = (mini.height * 2) + 'px';
    mini.style.imageRendering = 'pixelated';

    document.getElementById('diagstate').textContent = JSON.stringify({
      yawDeg: +(state.yaw * 180 / Math.PI).toFixed(1),
      cardinal: document.getElementById('cardinal').textContent,
      tipOpen: document.getElementById('tipbox').classList.contains('on'),
      tipText: document.getElementById('tipbox').textContent.slice(0, 90),
      infoButtons: document.querySelectorAll('#fields .info').length,
      seen: state.wasm ? state.wasm.maze_seen_count() : 0,
      errors: window.__diag ? window.__diag.errors.slice(0, 4) : [],
    });
  } catch (e) {
    document.getElementById('diagstate').textContent = 'VISUAL ERROR ' + (e && e.stack ? e.stack : e);
  }
});
</script>
`;

const prelude = `
<script>
window.__diag = { errors: [] };
window.addEventListener('error', (e) => window.__diag.errors.push('pageerror: ' + (e.message || e)), true);
</script>
<pre id="diagstate" style="position:fixed;left:8px;bottom:8px;z-index:20;font:11px ui-monospace,monospace;color:#ffd27a;background:rgba(0,0,0,.7);padding:6px 8px;max-width:70vw;white-space:pre-wrap"></pre>
`;

/* gameplay-only variant: draw the compass for every heading, then leave the
 * player facing east with the chart blown up so the arrow can be eyeballed */
const scriptMini = `
<script>
window.addEventListener('load', async () => {
  try {
    await new Promise(r => setTimeout(r, 1200));
    if (!started) document.getElementById('start').click();

    keys.add('w');
    for (let i = 0; i < 900; i++) { render(i * 0.016 + 0.01); move(1 / 60); updateDoors(1 / 60); drawMinimap(); }
    keys.delete('w');

    for (const y of [0, Math.PI / 2, Math.PI, -Math.PI / 2]) {
      state.yaw = y; updateBasis(); drawMinimap();
    }
    state.yaw = Math.PI / 2; updateBasis();
    for (let i = 0; i < 6; i++) { render(20 + i * 0.016); drawMinimap(); updateHud(); }

    const mini = document.getElementById('minimap');
    drawMinimap();
    /* snapshot the chart into a fixed, enlarged <img> so the layout cannot hide it */
    const shot = document.createElement('img');
    shot.src = mini.toDataURL();
    shot.style.cssText = 'position:fixed;right:8px;top:8px;z-index:30;' +
      'width:' + (mini.width * 4) + 'px;height:' + (mini.height * 4) + 'px;' +
      'image-rendering:pixelated;border:2px solid #6cf;background:#000';
    document.body.appendChild(shot);

    document.getElementById('diagstate').textContent = JSON.stringify({
      yawDeg: +(state.yaw * 180 / Math.PI).toFixed(1),
      cardinal: document.getElementById('cardinal').textContent,
      locked: !!locked,
      seen: state.wasm ? state.wasm.maze_seen_count() : 0,
      errors: window.__diag ? window.__diag.errors.slice(0, 4) : [],
    });
  } catch (e) {
    document.getElementById('diagstate').textContent = 'VISUAL ERROR ' + (e && e.stack ? e.stack : e);
  }
});
</script>
`;

const openTag = html.match(/<body[^>]*>/);
if (!openTag) throw new Error('no <body>');
const bodyStart = openTag.index + openTag[0].length;
const idx = html.lastIndexOf('</body>');
if (idx < 0) throw new Error('no </body>');
fs.writeFileSync(out, html.slice(0, bodyStart) + prelude + html.slice(bodyStart, idx) + (mini ? scriptMini : script) + html.slice(idx));
console.log('wrote', out, fs.statSync(out).size, 'bytes');

if (process.argv.includes('--run')) {
  const flags = ['--headless=new', '--use-gl=angle', '--use-angle=swiftshader',
                 '--enable-unsafe-swiftshader', '--no-sandbox', '--disable-dev-shm-usage',
                 '--virtual-time-budget=9000', '--window-size=1280,800',
                 '--enable-logging=stderr', '--v=0'];
  const dom = execFileSync('chromium', [...flags, '--dump-dom', 'file://' + out], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  const m = dom.match(/<pre id="diagstate"[^>]*>([\s\S]*?)<\/pre>/);
  console.log(m ? m[1].replace(/&quot;/g, '"').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>') : 'NO STATE FOUND');
  execFileSync('chromium', [...flags, '--screenshot=' + shot, 'file://' + out], { stdio: 'ignore' });
  console.log('screenshot ->', shot);
}
