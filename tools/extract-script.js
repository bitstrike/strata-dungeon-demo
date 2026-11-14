#!/usr/bin/env node
/* Pull the last inline <script> out of index.html so it can be node --check'd. */
const fs = require('fs');
const path = require('path');

const htmlPath = process.argv[2] || 'index.html';
const outPath = process.argv[3] || '/tmp/game.js';

const html = fs.readFileSync(htmlPath, 'utf8');
const re = /<script\b([^>]*)>([\s\S]*?)<\/script>/g;
let m;
let last = null;
while ((m = re.exec(html))) {
  if (/\btype\s*=\s*["']text\/plain["']/.test(m[1])) continue;
  last = m[2];
}
if (last === null) {
  console.error('no inline script found');
  process.exit(1);
}
fs.writeFileSync(outPath, last);
console.log('wrote', outPath, last.split('\n').length, 'lines', last.length, 'bytes');
