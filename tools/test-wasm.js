/* Node smoke test for the maze WASM kernel (not part of the game). */
const fs = require('fs');

(async () => {
  let instance;
  const importObject = {
    env: {
      memset: (m, d, l) => {
        new Uint8Array(instance.exports.memory.buffer).fill(d, m, m + l);
      },
    },
  };
  const res = await WebAssembly.instantiate(fs.readFileSync('maze.wasm'), importObject);
  instance = res.instance;
  const E = instance.exports;

  const lines = fs.readFileSync('maze1.txt', 'utf8').split('\n');
  if (lines[lines.length - 1] === '') lines.pop();
  const W = 80, H = lines.length;

  E.maze_init(W, H);
  const map = { '\u2593': 0, ' ': 1, '\u2591': 2, '\u2567': 3, '\u2564': 4, '\u2261': 5 };
  for (let y = 0; y < H; y++)
    for (let x = 0; x < W; x++)
      E.maze_set_cell(x, y, map[lines[y][x]] ?? 0);

  E.maze_set_spacing(6, 3);
  E.maze_finalize();

  console.log('api', E.maze_api_version(), 'dims', E.maze_w(), E.maze_h(),
              'lightmap', E.maze_lm_w(), E.maze_lm_h(), 'scale', E.maze_lm_scale());
  console.log('torches', E.maze_torch_count(), 'doors', E.maze_door_count(),
              'shrines', E.maze_shrine_count(), 'walkable', E.maze_walkable_count());

  const lit = E.maze_compute_light(7, 7, 3, 2);
  console.log('lit sub-cells with player r=3, wall r=2:', lit);

  for (let y = 4; y < 12; y++) {
    let s = '';
    for (let x = 4; x < 14; x++) {
      const v = E.maze_light(x, y);
      s += v > 200 ? '#' : v > 120 ? '+' : v > 40 ? '.' : ' ';
    }
    console.log(s + '  | ' + lines[y].slice(4, 14));
  }

  console.log('LOS diag: light(9,9)=', E.maze_light(9, 9), ' light(10,10)=', E.maze_light(10, 10));
  console.log('solid(7,8)=', E.maze_solid(7, 8), ' solid(8,7)=', E.maze_solid(8, 7));

  // door toggle
  const dcell = E.maze_door_cell(0);
  const dx = dcell % W, dy = (dcell / W) | 0;
  console.log('first door at', dx, dy, 'open?', E.maze_door_get(dx, dy),
              '-> toggled', E.maze_door_toggle(dx, dy), 'solid now', E.maze_solid(dx, dy));

  const hits = E.maze_cast(7.5, 7.5, 0, -1, 0.66, 0, 320, 7);
  console.log('ray hits (320 cols, maxDist 7):', hits);
  const rays = new Float32Array(instance.exports.memory.buffer, E.off_rays(), 320 * 8);
  const dump = (c) => Array.from(rays.slice(c * 8, c * 8 + 8)).map(v => +v.toFixed(3));
  console.log('center ray [perp,u,meta,hx,hy,light,warm,swing]:', dump(160));
  console.log('left ray  :', dump(0));
  console.log('right ray :', dump(319));

  // collision: find a wall in the player's own row and try to walk into it
  let wx = -1, wy = -1;
  for (let x = 8; x < 20; x++)
    if (E.maze_solid(x, 7)) { wx = x; wy = 7; }
  const px0 = 7.5, py0 = 7.5;
  const blocked = E.maze_try_move(px0, py0, wx + 0.5, py0, 0.28);
  const nudge   = E.maze_try_move(px0, py0, wx - 0.5, py0, 0.28);
  const slideY  = E.maze_try_move(px0, py0, px0, py0 + 0.25, 0.28);
  console.log('wall at', wx, wy, '-> into wall', blocked, '(1 = x blocked)',
              ' stop at face', nudge, ' sideways', slideY);

  // torch placement sanity
  let shown = 0;
  for (let i = 0; i < E.maze_torch_count() && shown < 6; i++, shown++) {
    const w = E.maze_torch_wall(i), o = E.maze_torch_open(i);
    console.log('torch', i, 'open', o % W, (o / W) | 0, 'wall', w % W, (w / W) | 0, 'face', E.maze_torch_face(i));
  }

  // perf: 10k light recomputes + 10k casts
  const t0 = Date.now();
  for (let i = 0; i < 10000; i++) E.maze_compute_light(7 + (i % 40), 7 + ((i * 7) % 40), 3, 2);
  const t1 = Date.now();
  for (let i = 0; i < 10000; i++) E.maze_cast(7.5, 7.5, 0, -1, 0.66, 0, 640, 7);
  const t2 = Date.now();
  console.log('10k light recomputes:', t1 - t0, 'ms   10k casts(640 cols):', t2 - t1, 'ms');
})();
