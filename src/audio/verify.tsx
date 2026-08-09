// Contract verification: disabled = zero AudioContext; first click unlocks exactly one;
// the toggle renders and reflects state. Instruments window.AudioContext with a counter.

import { createRoot } from 'react-dom/client';
import { createElement } from 'react';
import { sound, SoundToggle } from './sound';

let ctxCount = 0;
const RealCtx = window.AudioContext;
class Counting extends RealCtx { constructor() { super(); ctxCount++; } }
(window as unknown as { AudioContext: typeof AudioContext }).AudioContext = Counting as unknown as typeof AudioContext;

const log: string[] = [];
const check = (label: string, cond: boolean) => log.push(`${cond ? 'PASS' : 'FAIL'}  ${label}`);

async function main() {
  // 1. Import + calling the API while disabled must never create a context.
  sound.hover(); sound.select(); sound.bed('wimbledon-men'); sound.slamChange();
  sound.runStart(); sound.advance(3); sound.crown();
  check('disabled: no AudioContext created after 7 API calls', ctxCount === 0);
  check('disabled: sound.enabled is false', sound.enabled === false);

  // 2. Mount the toggle — still no context (render must not init audio).
  const root = createRoot(document.getElementById('root')!);
  root.render(createElement(SoundToggle, { slam: 'wimbledon-men' }));
  await new Promise((r) => setTimeout(r, 60));
  const btn = document.querySelector('.snd-toggle') as HTMLButtonElement | null;
  check('toggle renders a .snd-toggle button', !!btn);
  check('toggle starts in "Silent" state', !!btn && /Silent/i.test(btn.textContent ?? ''));
  check('mounting toggle created no AudioContext', ctxCount === 0);

  // 3. First click (a user gesture) unlocks exactly one context and enables.
  btn!.click();
  await new Promise((r) => setTimeout(r, 250));
  check('after enable: exactly one AudioContext exists', ctxCount === 1);
  check('after enable: sound.enabled is true', sound.enabled === true);
  check('after enable: toggle shows "Sound" + is-on', /Sound/.test(btn!.textContent ?? '') && btn!.classList.contains('is-on'));

  // 4. A second enable cycle must not spawn a second context.
  sound.hover(); sound.bed('us-open-men'); sound.advance(5); sound.crown();
  btn!.click(); // disable
  await new Promise((r) => setTimeout(r, 60));
  btn!.click(); // re-enable
  await new Promise((r) => setTimeout(r, 120));
  check('toggle re-enable reuses the same context (still 1)', ctxCount === 1);

  document.getElementById('out')!.textContent = log.join('\n');
  (window as unknown as Record<string, unknown>).__V = { log, ctxCount, pass: log.every((l) => l.startsWith('PASS')) };
  (window as unknown as Record<string, unknown>).__VDONE = true;
}

main().catch((e) => {
  document.getElementById('out')!.textContent = 'ERROR ' + (e as Error).stack;
  (window as unknown as Record<string, unknown>).__VDONE = true;
});
