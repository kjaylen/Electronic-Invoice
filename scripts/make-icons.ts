/**
 * Draws the app icons (the brand mark: a folded sheet with a tick) as PNGs for
 * the installable web app. Run after changing the mark: npm run icons
 *
 *   web/public/icon-192.png, icon-512.png       rounded square
 *   web/public/icon-maskable-512.png            full-bleed, mark inside the safe zone
 *   web/public/apple-touch-icon.png             180x180, full-bleed (iOS rounds it)
 */

import { writeFileSync, mkdirSync } from 'node:fs';
import { PNG } from 'pngjs';

type RGB = [number, number, number];
const INK: RGB = [0x16, 0x09, 0x23];
const SHEET: RGB = [0xfb, 0xf8, 0xf1];
const FOLD: RGB = [0xe7, 0xdc, 0xc6];
const BRAND: RGB = [0x6d, 0x2d, 0x93];
const LIME: RGB = [0x7b, 0xf5, 0x83];

function inPolygon(x: number, y: number, pts: Array<[number, number]>): boolean {
  let inside = false;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const [xi, yi] = pts[i]!;
    const [xj, yj] = pts[j]!;
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

function segmentDistance(x: number, y: number, [ax, ay]: [number, number], [bx, by]: [number, number]): number {
  const dx = bx - ax;
  const dy = by - ay;
  const t = Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / (dx * dx + dy * dy)));
  return Math.hypot(x - (ax + t * dx), y - (ay + t * dy));
}

function inRoundRect(x: number, y: number, x0: number, y0: number, x1: number, y1: number, r: number): boolean {
  if (x < x0 || x > x1 || y < y0 || y > y1) return false;
  const cx = Math.max(x0 + r, Math.min(x1 - r, x));
  const cy = Math.max(y0 + r, Math.min(y1 - r, y));
  return Math.hypot(x - cx, y - cy) <= r;
}

/** Colour of the mark at (x, y) in its 32x32 design space, or null for transparent. */
function markColor(x: number, y: number, fullBleed: boolean): RGB | null {
  const background = fullBleed ? true : inRoundRect(x, y, 1, 1, 31, 31, 8);
  if (!background) return null;
  const d = Math.hypot(x - 25, y - 25);
  if (d <= 5) return d <= 3.4 ? LIME : INK;
  if (segmentDistance(x, y, [11.5, 18.2], [14.5, 21.2]) <= 1.2 || segmentDistance(x, y, [14.5, 21.2], [20.5, 14.8]) <= 1.2) return BRAND;
  if (inPolygon(x, y, [[19, 7.5], [19, 12.5], [24, 12.5]])) return FOLD;
  if (inPolygon(x, y, [[8, 7.5], [19, 7.5], [24, 12.5], [24, 25.5], [8, 25.5]])) return SHEET;
  return INK;
}

function draw(size: number, options: { fullBleed: boolean; scale: number }): Buffer {
  const png = new PNG({ width: size, height: size });
  const ss = 4; // 4x4 supersampling for smooth edges
  for (let py = 0; py < size; py++) {
    for (let px = 0; px < size; px++) {
      let r = 0, g = 0, b = 0, a = 0;
      for (let sy = 0; sy < ss; sy++) {
        for (let sx = 0; sx < ss; sx++) {
          // Map the pixel into design space, shrinking the mark around the centre by `scale`.
          const u = ((px + (sx + 0.5) / ss) / size) * 32;
          const v = ((py + (sy + 0.5) / ss) / size) * 32;
          const x = 16 + (u - 16) / options.scale;
          const y = 16 + (v - 16) / options.scale;
          const inside = x >= 0 && x <= 32 && y >= 0 && y <= 32;
          const c = inside ? markColor(x, y, options.fullBleed) : options.fullBleed ? INK : null;
          if (c) {
            r += c[0];
            g += c[1];
            b += c[2];
            a += 1;
          }
        }
      }
      const i = (py * size + px) * 4;
      const n = ss * ss;
      png.data[i] = a ? Math.round(r / a) : 0;
      png.data[i + 1] = a ? Math.round(g / a) : 0;
      png.data[i + 2] = a ? Math.round(b / a) : 0;
      png.data[i + 3] = Math.round((a / n) * 255);
    }
  }
  return PNG.sync.write(png);
}

const out = new URL('../web/public/', import.meta.url);
mkdirSync(out, { recursive: true });
writeFileSync(new URL('icon-192.png', out), draw(192, { fullBleed: false, scale: 1 }));
writeFileSync(new URL('icon-512.png', out), draw(512, { fullBleed: false, scale: 1 }));
// Maskable icons are cropped to a circle or squircle: keep the mark inside the central 80%.
writeFileSync(new URL('icon-maskable-512.png', out), draw(512, { fullBleed: true, scale: 0.72 }));
writeFileSync(new URL('apple-touch-icon.png', out), draw(180, { fullBleed: true, scale: 0.86 }));
console.log('icons written to web/public');
