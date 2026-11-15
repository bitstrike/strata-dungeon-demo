#!/usr/bin/env node
/* Inline the WASM build (and the default maze) into index.html so the game
 * runs straight from file:// with no server.
 *
 *   node tools/build-html.js            # embed maze.wasm + maze1.txt
 *   node tools/build-html.js --check    # report sizes only
 */
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const htmlPath = path.join(root, 'index.html');
const wasmPath = path.join(root, 'maze.wasm');
const mapPath = path.join(root, 'maze1.txt');
const flamePath = path.join(root, 'assets', 'torch-flame-atlas.png');

const check = process.argv.includes('--check');

const html = fs.readFileSync(htmlPath, 'utf8');
const wasm = fs.readFileSync(wasmPath);
const map = fs.existsSync(mapPath) ? fs.readFileSync(mapPath, 'utf8') : '';
/* baked by tools/make-flame-atlas.sh from assets/torch-flame.png */
const flame = fs.existsSync(flamePath) ? fs.readFileSync(flamePath) : null;

const b64 = wasm.toString('base64');

function tag(id, text) {
  return `<script id="${id}" type="text/plain">${text}</script>`;
}

/* the maze is inlined base64 too: a raw UTF-8 block would be fine, but a
 * stray "</script" sequence in a map file would break the page */
const mapB64 = Buffer.from(map, 'utf8').toString('base64');
const flameB64 = flame ? flame.toString('base64') : '';

const newWasm = tag('mazeWasmB64', b64);
const newMap = tag('mazeFallback', mapB64);
const newFlame = tag('torchFlameB64', flameB64);

function swapTag(src, id, replacement) {
  const start = src.indexOf(`<script id="${id}"`);
  if (start < 0) throw new Error(`index.html has no <script id="${id}">`);
  const end = src.indexOf('</script>', start);
  if (end < 0) throw new Error(`unterminated <script id="${id}">`);
  return src.slice(0, start) + replacement + src.slice(end + '</script>'.length);
}

let out = swapTag(html, 'mazeWasmB64', newWasm);
out = swapTag(out, 'mazeFallback', newMap);
out = swapTag(out, 'torchFlameB64', newFlame);

if (check) {
  console.log(`wasm  ${wasm.length} bytes -> base64 ${b64.length} chars`);
  console.log(`map   ${map.length} bytes -> base64 ${mapB64.length} chars`);
  console.log(`flame ${flame ? flame.length + ' bytes -> base64 ' + flameB64.length + ' chars' : 'no assets/torch-flame-atlas.png (procedural flame)'}`);
  console.log(`index.html would be ${Buffer.byteLength(out, 'utf8')} bytes`);
  process.exit(0);
}

fs.writeFileSync(htmlPath, out);
console.log(`embedded maze.wasm (${wasm.length} B), ${map ? 'maze1.txt' : 'no map'} and `
  + `${flame ? 'flame atlas (' + flame.length + ' B)' : 'no flame atlas'} into index.html (${Buffer.byteLength(out, 'utf8')} B)`);
