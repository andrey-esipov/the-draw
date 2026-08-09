import { chromium } from 'playwright';

const browser = await chromium.launch({ channel: 'chromium', args: ['--use-gl=angle', '--use-angle=metal'] });
const page = await browser.newPage();
const cdp = await page.context().newCDPSession(page);
await cdp.send('Network.setCacheDisabled', { cacheDisabled: true });
const errs = [];
page.on('pageerror', (e) => errs.push('[pageerror] ' + e.message));
page.on('console', (m) => { if (m.type() === 'error' && !/favicon/.test(m.text())) errs.push('[console.error] ' + m.text()); });

await page.goto('http://localhost:5415/src/audio/verify.html', { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => window.__VDONE === true, { timeout: 20000 }).catch(() => {});
await page.waitForTimeout(300);
const out = await page.$eval('#out', (el) => el.textContent);
console.log('\n===== CONTRACT VERIFICATION =====\n' + out);
console.log('\nconsole/page errors (excl. favicon):', errs.length ? '\n' + errs.join('\n') : '(none)');
await browser.close();
