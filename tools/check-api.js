/* Verify that every WASM export index.html calls actually exists. */
const fs = require('fs');
const path = require('path');
const root = path.resolve(__dirname, '..');

const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
const code = html.slice(html.lastIndexOf('<script>') + 8, html.lastIndexOf('</script>'));

const used = new Set();
const re = /\bE\.([a-zA-Z_0-9]+)\(|\bstate\.wasm\.([a-zA-Z_0-9]+)\(/g;
let m;
while ((m = re.exec(code))) used.add(m[1] || m[2]);

const mod = WebAssembly.compileSync ? WebAssembly.compileSync(fs.readFileSync(path.join(root, 'maze.wasm')))
                                    : null;

(async () => {
  const mo = await WebAssembly.compile(fs.readFileSync(path.join(root, 'maze.wasm')));
  const exp = new Set(WebAssembly.Module.exports(mo).map(e => e.name));
  const missing = [...used].filter(n => !exp.has(n));
  console.log('js call sites:', used.size, ' missing exports:', missing.length ? missing.join(' ') : 'none');
  const inst = await WebAssembly.instantiate(mo, { env: { memset: () => {} } });
  const E = inst.exports;
  console.log('memory pages', E.memory.buffer.byteLength / 65536, ' api', E.maze_api_version());
  const offs = ['off_grid', 'off_door', 'off_seen', 'off_light', 'off_rays',
                'off_door_anim', 'off_door_axis', 'off_door_hinge']
                .map(n => n + '=' + E[n]());
  console.log(offs.join(' '));
  // sanity: the views the page builds must stay inside the linear memory
  E.maze_init(80, 80);
  const cells = 80 * 80;
  const end = Math.max(E.off_grid() + cells, E.off_door() + cells, E.off_seen() + cells,
                       E.off_door_anim() * 1 + cells * 4, E.off_light() + E.maze_lm_w() * E.maze_lm_h() * 2,
                       E.off_rays() + 4096 * 8);
  console.log('highest byte used by a view:', end, 'of', E.memory.buffer.byteLength,
              end <= E.memory.buffer.byteLength ? 'OK' : 'OVERFLOW');
})();
