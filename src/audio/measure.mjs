import { chromium } from 'playwright';
import { writeFileSync, mkdirSync } from 'node:fs';

const OUT = new URL('./out/', import.meta.url);
mkdirSync(OUT, { recursive: true });

const browser = await chromium.launch({
  channel: 'chromium',
  args: ['--use-gl=angle', '--use-angle=metal', '--autoplay-policy=no-user-gesture-required'],
});
const page = await browser.newPage();
const cdp = await page.context().newCDPSession(page);
await cdp.send('Network.setCacheDisabled', { cacheDisabled: true });

const errors = [];
page.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') errors.push(`[${m.type()}] ${m.text()}`); });
page.on('pageerror', (e) => errors.push(`[pageerror] ${e.message}`));

await page.goto('http://localhost:5415/src/audio/harness.html', { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => window.__DONE === true, { timeout: 40000 }).catch(() => {});
await page.waitForTimeout(500);

const text = await page.$eval('#log', (el) => el.textContent);
const results = await page.evaluate(() => window.__RESULTS ?? null);
const err = await page.evaluate(() => window.__ERR ?? null);

console.log('\n===== SOUND MEASUREMENTS =====\n');
console.log(text);
if (err) console.log('HARNESS ERROR:', err);
console.log('\n===== CONSOLE ERRORS/WARNINGS =====');
console.log(errors.length ? errors.join('\n') : '(none)');

if (results?.png) {
  const b64 = results.png.replace(/^data:image\/png;base64,/, '');
  writeFileSync(new URL('./run-envelope.png', OUT), Buffer.from(b64, 'base64'));
  console.log('\nWrote envelope plot -> src/audio/out/run-envelope.png');
}
if (results?.rows) {
  writeFileSync(new URL('./metrics.json', OUT), JSON.stringify(results.rows, null, 2));
}

await browser.close();
process.exit(errors.filter((e) => e.includes('pageerror')).length ? 1 : 0);
