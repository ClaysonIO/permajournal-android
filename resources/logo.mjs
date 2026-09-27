// Source of truth for the Permajournal logo: a year-grid of days whose filled
// cells spell a "P". `node resources/render-icons.mjs` regenerates the PNGs.
export const BRAND = '#4f6bd8';

const P = ['11110', '10001', '11110', '10000', '10000'];

/** Grid cells centred at (cx, cy) spanning `size` px. */
export function grid(cx, cy, size, on = '#fff', offOpacity = 0.25) {
  const n = 5;
  const gap = size * 0.05;
  const cell = (size - gap * (n - 1)) / n;
  const r = cell * 0.22;
  const x0 = cx - size / 2;
  const y0 = cy - size / 2;
  let out = '';
  for (let row = 0; row < n; row++) {
    for (let col = 0; col < n; col++) {
      const filled = P[row][col] === '1';
      out += `<rect x="${(x0 + col * (cell + gap)).toFixed(2)}" y="${(y0 + row * (cell + gap)).toFixed(2)}" width="${cell.toFixed(2)}" height="${cell.toFixed(2)}" rx="${r.toFixed(2)}" fill="${on}"${filled ? '' : ` fill-opacity="${offOpacity}"`}/>`;
    }
  }
  return out;
}

const svg = (w, h, body) => `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">${body}</svg>`;

/** Square app icon with rounded corners. */
export const iconSvg = (s) => svg(s, s, `<rect width="${s}" height="${s}" rx="${s * 0.22}" fill="${BRAND}"/>${grid(s / 2, s / 2, s * 0.56)}`);
/** Round legacy launcher icon. */
export const roundSvg = (s) => svg(s, s, `<circle cx="${s / 2}" cy="${s / 2}" r="${s / 2}" fill="${BRAND}"/>${grid(s / 2, s / 2, s * 0.5)}`);
/** Adaptive-icon foreground: 108dp canvas, art inside the 66dp safe zone. */
export const foregroundSvg = (s) => svg(s, s, grid(s / 2, s / 2, s * (44 / 108)));
/** Launch screen. */
export const splashSvg = (w, h) => svg(w, h, `<rect width="${w}" height="${h}" fill="${BRAND}"/>${grid(w / 2, h / 2, Math.min(w, h) * 0.28)}`);
