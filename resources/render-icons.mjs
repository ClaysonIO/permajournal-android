// Renders Android launcher icons, splash screens and the web favicon from logo.mjs.
// Usage: node resources/render-icons.mjs   (needs `playwright` with a Chromium available)
import { chromium } from 'playwright';
import { writeFileSync } from 'node:fs';
import { foregroundSvg, iconSvg, roundSvg, splashSvg } from './logo.mjs';

const res = new URL('../android/app/src/main/res/', import.meta.url).pathname;
const densities = { mdpi: 1, hdpi: 1.5, xhdpi: 2, xxhdpi: 3, xxxhdpi: 4 };
const splash = { mdpi: [320, 480], hdpi: [480, 800], xhdpi: [720, 1280], xxhdpi: [960, 1600], xxxhdpi: [1280, 1920] };

const browser = await chromium.launch(process.env.CHROMIUM ? { executablePath: process.env.CHROMIUM } : {});
const page = await browser.newPage();
async function render(markup, w, h, path, transparent = true) {
  await page.setViewportSize({ width: w, height: h });
  await page.setContent(`<html><body style="margin:0;background:transparent">${markup}</body></html>`);
  await page.screenshot({ path, omitBackground: transparent, clip: { x: 0, y: 0, width: w, height: h } });
}

for (const [d, k] of Object.entries(densities)) {
  await render(iconSvg(48 * k), 48 * k, 48 * k, `${res}mipmap-${d}/ic_launcher.png`);
  await render(roundSvg(48 * k), 48 * k, 48 * k, `${res}mipmap-${d}/ic_launcher_round.png`);
  await render(foregroundSvg(108 * k), 108 * k, 108 * k, `${res}mipmap-${d}/ic_launcher_foreground.png`);
  const [w, h] = splash[d];
  await render(splashSvg(w, h), w, h, `${res}drawable-port-${d}/splash.png`, false);
  await render(splashSvg(h, w), h, w, `${res}drawable-land-${d}/splash.png`, false);
}
await render(splashSvg(480, 320), 480, 320, `${res}drawable/splash.png`, false);
writeFileSync(new URL('../public/logo.svg', import.meta.url), iconSvg(64));
await browser.close();
console.log('icons rendered');
