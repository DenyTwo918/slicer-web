/*
 * Slicer nativní kernely (WASM SIMD).
 * Kompilace: zig cc -target wasm32-unknown-unknown -O3 -msimd128 -nostdlib -Wl,--no-entry -Wl,--export-all native/slice.c -o public/wasm/slice.wasm
 *
 * Všechny funkce pracují s raw pamětí (pointry), JS spravuje scratch buffery.
 * Žádné libc importy — memcpy/memset jsou definované zde.
 */

typedef unsigned char u8;
typedef unsigned int u32;

/* --- libc náhrady (abychom neimportovali env) --- */
void* memcpy(void* dst, const void* src, u32 n) {
  u8* d = (u8*)dst;
  const u8* s = (const u8*)src;
  for (u32 i = 0; i < n; i++) d[i] = s[i];
  return dst;
}

void* memset(void* dst, int c, u32 n) {
  u8* d = (u8*)dst;
  for (u32 i = 0; i < n; i++) d[i] = (u8)c;
  return dst;
}

/* --- Box dilate: vyplní obdélník (2r+1)^2 kolem každého set pixelu. --- */
__attribute__((export_name("dilate_box")))
void dilate_box(const u8* src, u8* out, int W, int H, int r) {
  for (int y = 0; y < H; y++) {
    const u8* srow = src + (u32)y * W;
    for (int x = 0; x < W; x++) {
      if (!srow[x]) continue;
      int x0 = x - r; if (x0 < 0) x0 = 0;
      int x1 = x + r; if (x1 >= W) x1 = W - 1;
      int y0 = y - r; if (y0 < 0) y0 = 0;
      int y1 = y + r; if (y1 >= H) y1 = H - 1;
      for (int yy = y0; yy <= y1; yy++) {
        u8* row = out + (u32)yy * W;
        for (int xx = x0; xx <= x1; xx++) row[xx] = 1;
      }
    }
  }
}

/* --- Hollow: vnitřek (4 směry do vzdálenosti d plné) → pryč, zbytek zachován. --- */
__attribute__((export_name("hollow_shell")))
void hollow_shell(const u8* src, u8* out, int W, int H, int d) {
  for (int y = 0; y < H; y++) {
    const u8* srow = src + (u32)y * W;
    u8* orow = out + (u32)y * W;
    for (int x = 0; x < W; x++) {
      int idx = y * W + x;
      u8 s = srow[x];
      if (!s) { orow[x] = 0; continue; }
      int x0 = x - d, x1 = x + d, y0 = y - d, y1 = y + d;
      int filled = 1;
      if (x0 < 0 || x1 >= W || y0 < 0 || y1 >= H) {
        filled = 0;
      } else if (!src[idx - d] || !src[idx + d] || !src[idx - (u32)d * W] || !src[idx + (u32)d * W]) {
        filled = 0;
      }
      orow[x] = filled ? 0 : s;
    }
  }
}

/* --- AA: 3×3 box blur na binární vrstvu → šedá 0..255 (round(sum/9*255)). --- */
__attribute__((export_name("aa_blur")))
void aa_blur(const u8* src, u8* out, int W, int H) {
  for (int y = 0; y < H; y++) {
    int y0 = y - 1; if (y0 < 0) y0 = 0;
    int y1 = y + 1; if (y1 >= H) y1 = H - 1;
    int rowBase = y * W;
    for (int x = 0; x < W; x++) {
      int x0 = x - 1; if (x0 < 0) x0 = 0;
      int x1 = x + 1; if (x1 >= W) x1 = W - 1;
      int sum = 0;
      for (int yy = y0; yy <= y1; yy++) {
        const u8* row = src + (u32)yy * W;
        for (int xx = x0; xx <= x1; xx++) sum += row[xx];
      }
      out[rowBase + x] = (u8)((sum * 255 + 4) / 9);
    }
  }
}

/* --- Vyplnění kruhu (plné, in-place). --- */
__attribute__((export_name("fill_circle")))
void fill_circle(u8* layer, int cx, int cy, int r, int W, int H) {
  int r2 = r * r;
  int x0 = cx - r; if (x0 < 0) x0 = 0;
  int x1 = cx + r; if (x1 >= W) x1 = W - 1;
  int y0 = cy - r; if (y0 < 0) y0 = 0;
  int y1 = cy + r; if (y1 >= H) y1 = H - 1;
  for (int y = y0; y <= y1; y++) {
    u8* row = layer + (u32)y * W;
    for (int x = x0; x <= x1; x++) {
      int dx = x - cx, dy = y - cy;
      if (dx * dx + dy * dy <= r2) row[x] = 1;
    }
  }
}

/* --- Vyplnění kruhu jen do prázdna (podpory neprocházejí modelem). --- */
__attribute__((export_name("fill_circle_if_empty")))
void fill_circle_if_empty(u8* layer, u8* mask, const u8* orig, int cx, int cy, int r, int W, int H) {
  int r2 = r * r;
  int x0 = cx - r; if (x0 < 0) x0 = 0;
  int x1 = cx + r; if (x1 >= W) x1 = W - 1;
  int y0 = cy - r; if (y0 < 0) y0 = 0;
  int y1 = cy + r; if (y1 >= H) y1 = H - 1;
  for (int y = y0; y <= y1; y++) {
    u8* rowL = layer + (u32)y * W;
    u8* rowM = mask + (u32)y * W;
    const u8* rowO = orig + (u32)y * W;
    for (int x = x0; x <= x1; x++) {
      int dx = x - cx, dy = y - cy;
      if (dx * dx + dy * dy <= r2 && !rowO[x]) { rowL[x] = 1; rowM[x] = 1; }
    }
  }
}

/* --- Vyplnění horizontálního intervalu [x0,x1] na řádku row (in-place). --- */
__attribute__((export_name("fill_span")))
void fill_span(u8* img, int row, int x0, int x1, int W) {
  u8* r = img + (u32)row * W;
  for (int x = x0; x <= x1; x++) r[x] = 1;
}

/* --- Plnění vrstvy z depth map (WebGPU slicing): solid = front+wall < z < back-wall.
 *     front/back jsou float pole v mm (W*H). out = 0/1. --- */
__attribute__((export_name("fill_between")))
void fill_between(const float* front, const float* back, u8* out, float z, float wall, int W, int H) {
  const u32 n = (u32)W * (u32)H;
  for (u32 i = 0; i < n; i++) {
    float f = front[i] + wall;
    float b = back[i] - wall;
    out[i] = (f < z && z < b) ? 1 : 0;
  }
}
