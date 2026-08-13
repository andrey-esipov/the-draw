/**
 * Lifts the pre-boot hold painted by index.html.
 *
 * It comes down on the first frame there is actually something to look at, not
 * on a timer, so nobody is ever shown an empty stage and told it is the piece.
 */
export function bootDone(): void {
  const el = document.getElementById('boot');
  if (!el || el.classList.contains('is-gone')) return;
  el.classList.add('is-gone');
  window.setTimeout(() => el.remove(), 700);
}
