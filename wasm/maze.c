/* ============================================================================
 *  MAZEKEEPER  —  torchlit dungeon raycast kernel  (WebAssembly / wasm32)
 *
 *  Build:
 *    clang-15 --target=wasm32 -O2 -nostdlib \
 *        -Wl,--no-entry -Wl,--export-all -Wl,--allow-undefined \
 *        -Wl,--no-gc-sections -o maze.wasm maze.c
 *
 *  Design notes
 *  ------------
 *  Everything the renderer needs per frame lives in linear memory so the JS
 *  side can bind typed-array views onto it with zero copying:
 *
 *      grid[]      tile code per cell      (written by the host after parsing)
 *      door[]      1 = door cell swung open
 *      lightw[]    interleaved RG8 lightmap  -> uploaded straight to WebGL2
 *      seen[]      fog-of-war memory
 *      rays[]      per-column DDA results    -> uploaded straight to WebGL2
 *
 *  The DDA traversal terminates at the configured radial render distance, so
 *  the number of cells actually visited per frame is bounded by the nearby
 *  torch pools, not by the map size. The light pass likewise only visits
 *  sub-cells inside the union of the torch pools (tracked in a touched list).
 *
 *  The lightmap is stored at LMS x LMS sub-cells per map cell so the falloff
 *  reads as a smooth gradient instead of a blocky per-cell step, while
 *  occlusion is resolved once per map cell: a wall either blocks the beam or
 *  it does not.
 * ========================================================================== */

#include <stdint.h>

#define MAX_DIM      256
#define MAX_CELLS    (MAX_DIM * MAX_DIM)
#define LMS          4                                  /* sub-cells per cell */
#define MAX_SUB      (MAX_DIM * LMS * MAX_DIM * LMS)
#define MAX_TOUCHED  65536
#define MAX_COLS     4096
#define MAX_PROPS    4096          /* torches / shrines / doors            */

#define API_VERSION  1101

/* tile codes --------------------------------------------------------------- */
enum { T_WALL = 0, T_FLOOR = 1, T_DOOR = 2, T_UP = 3, T_DOWN = 4, T_SHRINE = 5 };

/* ------------------------------------------------------------------ state */
static int gW = 0, gH = 0, gLmW = 0, gLmH = 0;

static uint8_t g_grid[MAX_CELLS];
static uint8_t g_door[MAX_CELLS];
static uint8_t g_seen[MAX_CELLS];
static float   g_doorAnim[MAX_CELLS];      /* 0 = shut, 1 = fully open        */
static int8_t  g_doorAxis[MAX_CELLS];      /* 0 = leaf spans x when shut      */
static int8_t  g_doorHinge[MAX_CELLS];     /* 0 = hinged at the low corner    */

static uint8_t g_lightw[MAX_SUB * 2];      /* [light, warmth] per sub-cell    */

/* Sub-cells touched by the light pool on the previous frame.  Clearing and
 * walking this list instead of the whole lightmap is what keeps the per-frame
 * cost tied to the torch radii rather than to the map size. */
static int g_touched[MAX_TOUCHED];
static int g_touchedN = 0;

static float   g_rays[MAX_COLS * 8];      /* see maze_cast()                 */

static int g_torchN   = 0;
static int g_torchWall[MAX_PROPS];        /* wall cell the sconce is set in */
static int g_torchOpen[MAX_PROPS];        /* open cell the sconce lights    */
static int g_torchFace[MAX_PROPS];        /* 0=N 1=E 2=S 3=W               */

static int g_shrineN  = 0;
static int g_shrineCell[MAX_PROPS];
static int g_doorN    = 0;
static int g_doorCell[MAX_PROPS];

static int g_spacing = 6;                 /* "every 6 blocks a wall torch"  */
static int g_minGap  = 3;                 /* spacing filter, in cells       */
static int g_falloff = 2;                 /* light falloff exponent 1..4    */

/* --------------------------------------------------------------- helpers */
static __attribute__((always_inline)) inline int idx(int x, int y) { return y * gW + x; }
static __attribute__((always_inline)) inline int inside(int x, int y) {
    return (unsigned)x < (unsigned)gW && (unsigned)y < (unsigned)gH;
}
static __attribute__((always_inline)) inline int iabs(int v) { return v < 0 ? -v : v; }

/* Tiny polynomial sin/cos: keeps the module free of libm imports so it can be
 * instantiated with nothing but a memset shim.  Accuracy ~4e-6, which is far
 * below a texel. */
#define MK_PI 3.14159265358979324f
static __attribute__((always_inline)) inline float mk_sin(float x) {
    while (x >  MK_PI) x -= 2.0f * MK_PI;
    while (x < -MK_PI) x += 2.0f * MK_PI;
    float x2 = x * x;
    return x * (1.0f - x2 * (1.0f / 6.0f - x2 * (1.0f / 120.0f
             - x2 * (1.0f / 5040.0f - x2 * (1.0f / 362880.0f)))));
}
static __attribute__((always_inline)) inline float mk_cos(float x) {
    x += MK_PI * 0.5f;
    return mk_sin(x);
}

/* solid for movement purposes */
static int solid(int x, int y) {
    if (!inside(x, y)) return 1;
    int t = g_grid[idx(x, y)];
    if (t == T_WALL) return 1;
    if (t == T_DOOR && !g_door[idx(x, y)]) return 1;
    return 0;
}

/* line of sight: every cell strictly between A and B must be transparent.
 * The destination itself may be opaque (we still want to light wall faces). */
static int los(int x0, int y0, int x1, int y1) {
    int dx = iabs(x1 - x0);
    int dy = -iabs(y1 - y0);
    int sx = (x0 < x1) ? 1 : -1;
    int sy = (y0 < y1) ? 1 : -1;
    int err = dx + dy, e2;
    int guard = 2 * (gW + gH) + 8;
    int first = 1;                       /* the source cell is always allowed */

    for (;;) {
        if (x0 == x1 && y0 == y1) return 1;
        if (!inside(x0, y0)) return 0;
        if (!first) {
            int id = idx(x0, y0);
            int t = g_grid[id];
            if (t == T_WALL) return 0;
            if (t == T_DOOR && !g_door[id]) return 0;
        }
        first = 0;
        e2 = 2 * err;
        if (e2 >= dy) { err += dy; x0 += sx; }
        if (e2 <= dx) { err += dx; y0 += sy; }
        if (--guard <= 0) return 0;
    }
}

/* ------------------------------------------------------------- lifecycle */
int maze_api_version(void) { return API_VERSION; }

int maze_init(int w, int h) {
    if (w < 1) w = 1;
    if (h < 1) h = 1;
    if (w > MAX_DIM) w = MAX_DIM;
    if (h > MAX_DIM) h = MAX_DIM;
    gW = w; gH = h;
    gLmW = w * LMS; gLmH = h * LMS;
    for (int i = 0; i < MAX_CELLS; i++) {
        g_grid[i] = (uint8_t)T_WALL;
        g_door[i] = 0;
        g_seen[i] = 0;
        g_doorAnim[i] = 0.0f;
        g_doorAxis[i] = 0;
        g_doorHinge[i] = 0;
    }
    for (int i = 0; i < MAX_SUB * 2; i++) g_lightw[i] = 0;
    g_touchedN = 0;
    g_torchN = g_shrineN = g_doorN = 0;
    return 0;
}

int maze_w(void) { return gW; }
int maze_h(void) { return gH; }
int maze_lm_w(void) { return gLmW; }
int maze_lm_h(void) { return gLmH; }
int maze_lm_scale(void) { return LMS; }

/* linear-memory offsets so the host can bind views directly */
int off_grid(void)  { return (int)(uintptr_t)g_grid; }
int off_door(void)  { return (int)(uintptr_t)g_door; }
int off_light(void) { return (int)(uintptr_t)g_lightw; }
int off_seen(void)  { return (int)(uintptr_t)g_seen; }
int off_rays(void)  { return (int)(uintptr_t)g_rays; }
int off_door_anim(void)  { return (int)(uintptr_t)g_doorAnim; }
int off_door_axis(void)  { return (int)(uintptr_t)g_doorAxis; }
int off_door_hinge(void) { return (int)(uintptr_t)g_doorHinge; }

void maze_set_cell(int x, int y, int v) { if (inside(x, y)) g_grid[idx(x, y)] = (uint8_t)v; }
int  maze_cell(int x, int y)            { return inside(x, y) ? g_grid[idx(x, y)] : T_WALL; }
int  maze_solid(int x, int y)           { return solid(x, y); }

void maze_set_spacing(int spacing, int minGap) {
    g_spacing = (spacing < 0) ? 0 : spacing;
    g_minGap  = (minGap  < 1) ? 1 : minGap;
}

void maze_set_falloff(int curve) {
    if (curve < 1) curve = 1;
    if (curve > 4) curve = 4;
    g_falloff = curve;
}
int maze_falloff(void) { return g_falloff; }

/* Collect props and mount the wall sconces.
 * Walkable cells are counted in scan order; every `spacing`-th cell that has
 * an orthogonal wall neighbour gets a torch on that wall, subject to a minimum
 * separation so sconces never bunch up on a corner. */
void maze_finalize(void) {
    static const int DX[4] = { 0, 1, 0, -1 };
    static const int DY[4] = { -1, 0, 1, 0 };

    g_torchN = g_shrineN = g_doorN = 0;

    int n = 0;
    for (int y = 0; y < gH; y++) {
        for (int x = 0; x < gW; x++) {
            int id = idx(x, y);
            int t = g_grid[id];

            if (t == T_DOOR) {
                if (g_doorN < MAX_PROPS) g_doorCell[g_doorN++] = id;
                /* Derive the swing geometry from the corridor the door seals.
                 * axis 0 = leaf spans x when shut (it blocks N/S travel),
                 * axis 1 = leaf spans y when shut (blocks E/W travel). */
                int openNS = inside(x, y - 1) && g_grid[idx(x, y - 1)] != T_WALL
                          && inside(x, y + 1) && g_grid[idx(x, y + 1)] != T_WALL;
                int openEW = inside(x - 1, y) && g_grid[idx(x - 1, y)] != T_WALL
                          && inside(x + 1, y) && g_grid[idx(x + 1, y)] != T_WALL;

                int axis, hinge;
                if (openNS && !openEW) {
                    /* leaf spans x when shut; folds flat against the west or
                     * east neighbour, so hinge toward whichever side is wall */
                    axis = 0;
                    int wW = inside(x - 1, y) && g_grid[idx(x - 1, y)] == T_WALL;
                    int wE = inside(x + 1, y) && g_grid[idx(x + 1, y)] == T_WALL;
                    hinge = (wW && !wE) ? 0 : ((wE && !wW) ? 1 : ((x + y) & 1));
                } else {
                    /* leaf spans y when shut; folds against the north or south */
                    axis = 1;
                    int wN = inside(x, y - 1) && g_grid[idx(x, y - 1)] == T_WALL;
                    int wS = inside(x, y + 1) && g_grid[idx(x, y + 1)] == T_WALL;
                    hinge = (wN && !wS) ? 0 : ((wS && !wN) ? 1 : ((x + y) & 1));
                }
                g_doorAxis[id]  = (int8_t)axis;
                g_doorHinge[id] = (int8_t)hinge;
                g_doorAnim[id]  = 0.0f;
                continue;
            }
            if (t == T_SHRINE) { if (g_shrineN < MAX_PROPS) g_shrineCell[g_shrineN++] = id; continue; }
            if (t != T_FLOOR && t != T_UP && t != T_DOWN) continue;

            n++;
            if (g_spacing <= 0) continue;
            if ((n % g_spacing) != 0) continue;

            int face = -1;
            for (int k = 0; k < 4; k++) {
                int nx = x + DX[k], ny = y + DY[k];
                if (inside(nx, ny) && g_grid[idx(nx, ny)] == T_WALL) { face = k; break; }
            }
            if (face < 0) continue;

            int ok = 1;
            for (int i = 0; i < g_torchN; i++) {
                int c = g_torchOpen[i];
                int dx = (c % gW) - x, dy = (c / gW) - y;
                if (dx * dx + dy * dy < g_minGap * g_minGap) { ok = 0; break; }
            }
            if (!ok) continue;
            if (g_torchN >= MAX_PROPS) break;

            g_torchWall[g_torchN] = idx(x + DX[face], y + DY[face]);
            g_torchOpen[g_torchN] = id;
            g_torchFace[g_torchN] = face;
            g_torchN++;
        }
    }
}

int maze_torch_count(void)  { return g_torchN; }
int maze_shrine_count(void) { return g_shrineN; }
int maze_door_count(void)   { return g_doorN; }

int maze_torch_wall(int i) { return (i >= 0 && i < g_torchN) ? g_torchWall[i] : -1; }
int maze_torch_open(int i) { return (i >= 0 && i < g_torchN) ? g_torchOpen[i] : -1; }
int maze_torch_face(int i) { return (i >= 0 && i < g_torchN) ? g_torchFace[i] : -1; }
int maze_shrine_cell(int i){ return (i >= 0 && i < g_shrineN) ? g_shrineCell[i] : -1; }
int maze_door_cell(int i)  { return (i >= 0 && i < g_doorN)   ? g_doorCell[i] : -1; }

/* --------------------------------------------------------------- doors */
int maze_door_get(int x, int y) { return inside(x, y) ? g_door[idx(x, y)] : 0; }

int maze_door_toggle(int x, int y) {
    if (!inside(x, y)) return 0;
    int id = idx(x, y);
    if (g_grid[id] != T_DOOR) return 0;
    g_door[id] = g_door[id] ? 0 : 1;
    return g_door[id];
}

void maze_door_set(int x, int y, int v) {
    if (!inside(x, y)) return;
    int id = idx(x, y);
    if (g_grid[id] != T_DOOR) return;
    g_door[id] = v ? 1 : 0;
}

/* swing amount 0..1 for a door cell, mirrored from the host so the DDA and the
 * renderer agree on where the leaf currently is */
void maze_door_anim(int x, int y, float v) {
    if (!inside(x, y)) return;
    int id = idx(x, y);
    if (g_grid[id] != T_DOOR) return;
    if (v < 0.0f) v = 0.0f;
    if (v > 1.0f) v = 1.0f;
    g_doorAnim[id] = v;
}
float maze_door_anim_get(int x, int y) {
    return inside(x, y) ? g_doorAnim[idx(x, y)] : 0.0f;
}
int maze_door_axis(int x, int y) {
    return inside(x, y) ? g_doorAxis[idx(x, y)] : 0;   /* 0 = leaf spans x, 1 = spans y */
}
int maze_door_hinge(int x, int y) {
    return inside(x, y) ? g_doorHinge[idx(x, y)] : 0;
}

/* ------------------------------------------------------------- lighting
 * The lightmap is LMS x LMS sub-cells per map cell, so the falloff reads as a
 * smooth gradient and the pool tracks the player's exact position rather than
 * snapping to a cell.  Occlusion is resolved once per map cell (cached across
 * the sub-cells of a cell) because a wall either blocks the beam or it does not.
 * Occlusion is always cast from the source's own cell: a lamp in a corridor
 * never lights through the wall beside it. */
static void add_light(float cx, float cy, int radius, int warmVal) {
    if (radius < 0) radius = 0;
    int r = radius;

    const int ocx = (int)__builtin_floorf(cx);
    const int ocy = (int)__builtin_floorf(cy);

    int x0 = (ocx - r - 1) * LMS; if (x0 < 0) x0 = 0;
    int x1 = (ocx + r + 1) * LMS; if (x1 > gLmW - 1) x1 = gLmW - 1;
    int y0 = (ocy - r - 1) * LMS; if (y0 < 0) y0 = 0;
    int y1 = (ocy + r + 1) * LMS; if (y1 > gLmH - 1) y1 = gLmH - 1;

    const float invR   = 1.0f / (float)(r + 0.85f);
    const float invLms = 1.0f / (float)LMS;

    int lastCell = -1, lastLos = 0;

    for (int sy = y0; sy <= y1; sy++) {
        for (int sx = x0; sx <= x1; sx++) {
            float fx = ((float)sx + 0.5f) * invLms - cx;
            float fy = ((float)sy + 0.5f) * invLms - cy;
            float d  = __builtin_sqrtf(fx * fx + fy * fy);
            float t  = 1.0f - d * invR;
            if (t <= 0.0f) continue;
            /* falloff curve: 1 = linear, 2 = ease-out (default), 3..4 = a
             * tighter, more directional pool */
            float v;
            switch (g_falloff) {
                case 1:  v = t; break;
                case 3:  v = t * t; break;
                case 4:  v = t * t * t; break;
                default: v = t * (2.0f - t); break;
            }
            int iv = (int)(v * 255.0f);
            if (iv <= 0) continue;

            int ccx = sx / LMS, ccy = sy / LMS;
            int cid = ccy * gW + ccx;
            if (cid != lastCell) { lastCell = cid; lastLos = los(ocx, ocy, ccx, ccy); }
            if (!lastLos) continue;

            int p = (sy * gLmW + sx) * 2;
            if (g_lightw[p] == 0 && g_touchedN < MAX_TOUCHED) g_touched[g_touchedN++] = sy * gLmW + sx;

            if (iv > g_lightw[p]) {
                g_lightw[p]     = (uint8_t)iv;
                g_lightw[p + 1] = (uint8_t)warmVal;
            } else if (iv == g_lightw[p] && warmVal > g_lightw[p + 1]) {
                g_lightw[p + 1] = (uint8_t)warmVal;
            }
        }
    }
}

/* Recompute the light pool.  Only sub-cells inside the union of the torch
 * pools are ever visited or cleared, so the work scales with the configured
 * radii and is independent of the 80x80 (or 256x256) map size.
 * px/py are the player's world position (cell units, fractional allowed). */
int maze_compute_light(float px, float py, int playerR, int wallR) {
    for (int i = 0; i < g_touchedN; i++) {
        int p = g_touched[i] * 2;
        g_lightw[p] = 0;
        g_lightw[p + 1] = 0;
    }
    g_touchedN = 0;

    const int pcx = (int)__builtin_floorf(px);
    const int pcy = (int)__builtin_floorf(py);

    if (playerR > 0) add_light(px, py, playerR, 185);

    if (wallR > 0) {
        int reach = playerR + wallR + 2;
        for (int i = 0; i < g_torchN; i++) {
            int c = g_torchOpen[i];
            int tx = c % gW, ty = c / gW;
            /* skip sconces well outside the reach of the player's own lamp */
            if (playerR > 0) {
                int dx = tx - pcx, dy = ty - pcy;
                if (dx * dx + dy * dy > reach * reach) continue;
            }
            add_light((float)tx + 0.5f, (float)ty + 0.5f, wallR, 255);
        }
    }

    int lit = 0;
    for (int i = 0; i < g_touchedN; i++) if (g_lightw[g_touched[i] * 2]) lit++;
    return lit;
}

int maze_lightmap_light(int sx, int sy) {
    if ((unsigned)sx >= (unsigned)gLmW || (unsigned)sy >= (unsigned)gLmH) return 0;
    return g_lightw[(sy * gLmW + sx) * 2];
}
int maze_lightmap_warm(int sx, int sy) {
    if ((unsigned)sx >= (unsigned)gLmW || (unsigned)sy >= (unsigned)gLmH) return 0;
    return g_lightw[(sy * gLmW + sx) * 2 + 1];
}
int maze_light(int x, int y) {
    if (!inside(x, y)) return 0;
    return maze_lightmap_light(x * LMS + LMS / 2, y * LMS + LMS / 2);
}
int maze_warm(int x, int y) {
    if (!inside(x, y)) return 0;
    return maze_lightmap_warm(x * LMS + LMS / 2, y * LMS + LMS / 2);
}

int maze_mark_seen(void) {
    int fresh = 0;
    for (int i = 0; i < g_touchedN; i++) {
        int s = g_touched[i];
        if (!g_lightw[s * 2]) continue;
        int cid = (s / gLmW) / LMS * gW + (s % gLmW) / LMS;
        if (!g_seen[cid]) { g_seen[cid] = 1; fresh++; }
    }
    return fresh;
}
int maze_seen(int x, int y) { return inside(x, y) ? g_seen[idx(x, y)] : 0; }
void maze_forget(void) { for (int i = 0; i < MAX_CELLS; i++) g_seen[i] = 0; }
int maze_seen_count(void) {
    int k = 0;
    for (int i = 0; i < gW * gH; i++) if (g_seen[i]) k++;
    return k;
}

/* ------------------------------------------------- DDA raycast traversal */
/* Leaf of a hinged door, evaluated at its current swing angle.
 *   axis 0 : leaf spans x when shut (seals a N/S corridor)
 *   axis 1 : leaf spans y when shut (seals an E/W corridor)
 * shut_dir and open_dir are orthonormal, so cos/sin blending is an exact
 * rotation about the hinge corner. */
static void door_leaf(int id, int x, int y, float anim,
                      float *ax, float *ay, float *bx, float *by)
{
    int hinge = g_doorHinge[id];
    int axis  = g_doorAxis[id];
    float s   = (hinge == 0) ? 1.0f : -1.0f;

    float hx = (float)x + (float)hinge;
    float hy = (float)y + (float)hinge;

    float sx, sy, ox, oy;
    if (axis == 0) { sx = s;  sy = 0.0f; ox = 0.0f; oy = s; }
    else           { sx = 0.0f; sy = s;  ox = s;    oy = 0.0f; }

    float th = anim * 1.5707963267948966f;
    float c  = mk_cos(th);
    float sn = mk_sin(th);

    *ax = hx;
    *ay = hy;
    *bx = hx + c * sx + sn * ox;
    *by = hy + c * sy + sn * oy;
}

/* Writes 8 floats per column into g_rays:
 *   0 perp   depth along the view axis, negative when nothing was hit.  The
 *            camera plane is perpendicular to dir, so this is true view-space
 *            depth and wall heights come out undistorted.
 *   1 texU   u along the hit face, 0..1
 *   2 meta   bit0 side (0 x-side, 1 y-side), bits1..3 texture variant,
 *            bit4 hit cell is a door, bit5 leaf is caught mid-swing
 *   3 hit cell x,  4 hit cell y
 *   5 light  0..255 sampled just in front of the face
 *   6 warmth 0..255
 *   7 swing  door swing 0..1 (0 for plain walls)
 */
int maze_cast(float px, float py,
              float dirX, float dirY,
              float planeX, float planeY,
              int cols, float maxDist)
{
    if (cols > MAX_COLS) cols = MAX_COLS;
    if (cols < 1) cols = 1;
    if (maxDist < 1.0f) maxDist = 1.0f;

    const float invCols = 2.0f / (float)cols;
    int hits = 0;

    for (int c = 0; c < cols; c++) {
        float camX = (float)c * invCols - 1.0f;
        float rdx  = dirX + planeX * camX;
        float rdy  = dirY + planeY * camX;
        float rayLen = __builtin_sqrtf(rdx * rdx + rdy * rdy);

        int mapX = (int)px, mapY = (int)py;

        float deltaX = (rdx == 0.0f) ? 1e30f : __builtin_fabsf(1.0f / rdx);
        float deltaY = (rdy == 0.0f) ? 1e30f : __builtin_fabsf(1.0f / rdy);

        int   stepX, stepY;
        float sideDistX, sideDistY;

        if (rdx < 0.0f) { stepX = -1; sideDistX = (px - (float)mapX) * deltaX; }
        else            { stepX =  1; sideDistX = ((float)mapX + 1.0f - px) * deltaX; }
        if (rdy < 0.0f) { stepY = -1; sideDistY = (py - (float)mapY) * deltaY; }
        else            { stepY =  1; sideDistY = ((float)mapY + 1.0f - py) * deltaY; }

        int   side = 0, hit = 0, cellType = T_WALL, variant = 0, swinging = 0;
        float perp = -1.0f, texU = 0.0f;
        int   guard = 4096;

        while (guard-- > 0) {
            float entry;
            if (sideDistX < sideDistY) { entry = sideDistX; sideDistX += deltaX; mapX += stepX; side = 0; }
            else                       { entry = sideDistY; sideDistY += deltaY; mapY += stepY; side = 1; }

            /* maxDist is radial distance, not the unnormalised ray parameter. */
            float cand = (side == 0) ? (sideDistX - deltaX) : (sideDistY - deltaY);
            if (cand * rayLen > maxDist) break;

            if (!inside(mapX, mapY)) break;

            int id = idx(mapX, mapY);
            int t  = g_grid[id];

            if (t == T_WALL || (t == T_DOOR && !g_door[id])) {
                cellType = t;
                hit = 1;
                perp  = cand;
                unsigned hv = ((unsigned)mapX * 73856093u) ^ ((unsigned)mapY * 19349663u);
                variant = (int)(hv & 3u);
                break;
            }

            /* A door that is mid-swing is a real rotated panel: test the ray
             * against the leaf so you can watch it swing open and see the
             * corridor appear through the gap.  Everything here stays in the
             * DDA's own ray-parameter units so the wall heights agree. */
            if (t == T_DOOR) {
                float anim = g_doorAnim[id];
                if (anim > 0.02f && anim < 0.98f) {
                    float exitD = (sideDistX < sideDistY) ? sideDistX : sideDistY;
                    float ax, ay, bx, by;
                    door_leaf(id, mapX, mapY, anim, &ax, &ay, &bx, &by);

                    float ex = bx - ax, ey = by - ay;
                    float den = rdx * ey - ex * rdy;
                    if (den > 1e-6f || den < -1e-6f) {
                        float qx = ax - px, qy = ay - py;
                        float tt = (qx * ey - ex * qy) / den;
                        float u  = (qx * rdy - rdx * qy) / den;
                        if (u >= 0.0f && u <= 1.0f && tt >= entry && tt <= exitD) {
                            cellType = T_DOOR;
                            hit = 1;
                            swinging = 1;
                            side  = (ex * ex > ey * ey) ? 0 : 1;
                            perp  = tt;
                            texU  = u;
                            unsigned hv = ((unsigned)mapX * 73856093u) ^ ((unsigned)mapY * 19349663u);
                            variant = (int)(hv & 3u);
                            break;
                        }
                    }
                }
            }
        }

        float light = 0.0f, warm = 0.0f, swing = 0.0f;

        if (hit) {
            hits++;
            if (perp < 1e-4f) perp = 1e-4f;

            if (!swinging) {
                float wallX = (side == 0) ? (py + perp * rdy) : (px + perp * rdx);
                wallX -= __builtin_floorf(wallX);
                texU = wallX;
                if (side == 0 && rdx > 0.0f) texU = 1.0f - texU;
                if (side == 1 && rdy < 0.0f) texU = 1.0f - texU;
            }

            /* sample the lightmap a hair in front of the face so a wall gets
             * the light that is actually falling on it */
            float hxw = px + rdx * perp;
            float hyw = py + rdy * perp;
            if (side == 0) hxw -= (rdx > 0.0f) ? 0.04f : -0.04f;
            else           hyw -= (rdy > 0.0f) ? 0.04f : -0.04f;

            int sx = (int)(hxw * LMS), sy = (int)(hyw * LMS);
            if (sx < 0) sx = 0;
            if (sx >= gLmW) sx = gLmW - 1;
            if (sy < 0) sy = 0;
            if (sy >= gLmH) sy = gLmH - 1;
            int p = (sy * gLmW + sx) * 2;
            light = (float)g_lightw[p];
            warm  = (float)g_lightw[p + 1];

            swing = (cellType == T_DOOR) ? g_doorAnim[idx(mapX, mapY)] : 0.0f;
        }

        int meta = side | (variant << 1) | ((cellType == T_DOOR) ? 16 : 0) | (swinging ? 32 : 0);
        int o = c * 8;
        g_rays[o + 0] = perp;
        g_rays[o + 1] = texU;
        g_rays[o + 2] = (float)meta;
        g_rays[o + 3] = (float)(hit ? mapX : -1);
        g_rays[o + 4] = (float)(hit ? mapY : -1);
        g_rays[o + 5] = light;
        g_rays[o + 6] = warm;
        g_rays[o + 7] = swing;
    }
    return hits;
}

/* Is there a clear shot from the player's cell to an open cell? Used to gate
 * distant torch-glow sprites so you never see a flame through a wall. */
int maze_can_see(int x0, int y0, int x1, int y1) {
    if (!inside(x0, y0) || !inside(x1, y1)) return 0;
    return los(x0, y0, x1, y1);
}

int maze_walkable_count(void) {
    int n = gW * gH, k = 0;
    for (int i = 0; i < n; i++) {
        int t = g_grid[i];
        if (t == T_FLOOR || t == T_UP || t == T_DOWN || t == T_SHRINE) k++;
        else if (t == T_DOOR && g_door[i]) k++;
    }
    return k;
}

/* Circle-vs-grid collision.  Each candidate cell is treated as its full unit
 * square (closest-point test), so a shoulder cannot poke through a corner.
 * Tries the whole move first, then each axis on its own so the player slides
 * along a wall instead of sticking to it.  Returns a bitmask:
 * bit0 = x blocked, bit1 = y blocked.  0 means the move was clean. */
static int circle_hits_cell(float cx, float cy, float r, int cellX, int cellY) {
    if (!solid(cellX, cellY)) return 0;
    float px = cx, py = cy;
    if (px < (float)cellX) px = (float)cellX;
    if (px > (float)cellX + 1.0f) px = (float)cellX + 1.0f;
    if (py < (float)cellY) py = (float)cellY;
    if (py > (float)cellY + 1.0f) py = (float)cellY + 1.0f;
    float dx = cx - px, dy = cy - py;
    return (dx * dx + dy * dy) < r * r;
}

int maze_try_move(float ox, float oy, float nx, float ny, float radius) {
    if (radius < 0.0f) radius = 0.0f;

    int c0 = (int)__builtin_floorf(ny - radius), c1 = (int)__builtin_floorf(ny + radius);
    int r0 = (int)__builtin_floorf(nx - radius), r1 = (int)__builtin_floorf(nx + radius);
    int oc0 = (int)__builtin_floorf(oy - radius), oc1 = (int)__builtin_floorf(oy + radius);
    int or0 = (int)__builtin_floorf(ox - radius), or1 = (int)__builtin_floorf(ox + radius);

    /* A leaf that is caught mid-swing is a physical panel: it blocks the cells
     * it currently sweeps across, so you have to wait for it or shoulder it. */
    int swingHit = 0;
    for (int cy = c0 - 1; cy <= c1 + 1 && !swingHit; cy++) {
        for (int cx = r0 - 1; cx <= r1 + 1; cx++) {
            if (!inside(cx, cy)) continue;
            int id = idx(cx, cy);
            if (g_grid[id] != T_DOOR) continue;
            float a = g_doorAnim[id];
            if (a <= 0.05f || a >= 0.95f) continue;
            float ax, ay, bx, by;
            door_leaf(id, cx, cy, a, &ax, &ay, &bx, &by);
            float ex = bx - ax, ey = by - ay;
            float len2 = ex * ex + ey * ey;
            float t = (len2 > 1e-6f) ? ((nx - ax) * ex + (ny - ay) * ey) / len2 : 0.0f;
            if (t < 0.0f) t = 0.0f;
            if (t > 1.0f) t = 1.0f;
            float dx = nx - (ax + ex * t), dy = ny - (ay + ey * t);
            if (dx * dx + dy * dy < (radius + 0.06f) * (radius + 0.06f)) { swingHit = 1; break; }
        }
    }
    if (swingHit) return 3;

    int fits = 1;
    for (int cy = c0; cy <= c1 && fits; cy++)
        for (int cx = r0; cx <= r1; cx++)
            if (circle_hits_cell(nx, ny, radius, cx, cy)) { fits = 0; break; }
    if (fits) return 0;

    int okX = 1, okY = 1;
    for (int cy = c0; cy <= c1 && okX; cy++)
        for (int cx = r0; cx <= r1; cx++)
            if (circle_hits_cell(nx, oy, radius, cx, cy)) { okX = 0; break; }
    for (int cy = oc0; cy <= oc1 && okY; cy++)
        for (int cx = or0; cx <= or1; cx++)
            if (circle_hits_cell(ox, ny, radius, cx, cy)) { okY = 0; break; }

    return (okX ? 0 : 1) | (okY ? 0 : 2);
}
