import { useEffect, useRef } from 'react';
import gsap from 'gsap';

const REDUCED = () =>
  typeof window !== 'undefined' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

/**
 * The draw assembles, then decays.
 *
 * Every thread is drawn in at full strength round by round, so the field arrives
 * whole and equal. Then a wave travels from the rim inward: each round settles to
 * its resting weight as the players eliminated in it recede. What is left standing
 * is the one path that reached the centre, and it lights last.
 */
export function useReveal(root: React.RefObject<SVGSVGElement | null>, key: string) {
  const done = useRef(false);
  const seen = useRef(false);

  useEffect(() => {
    const svg = root.current;
    if (!svg) return;
    done.current = false;

    const threads = Array.from(svg.querySelectorAll<SVGPathElement>('.thread'));
    const lit = Array.from(svg.querySelectorAll<SVGPathElement>('.lit-thread'));
    const names = Array.from(svg.querySelectorAll<SVGTextElement>('.rim-name'));
    const rings = svg.querySelector('.rings');
    const ringLabels = svg.querySelector('.ring-labels');
    const core = svg.querySelector('.core');

    const resting = new Map<SVGPathElement, number>();
    for (const t of threads) resting.set(t, Number(t.getAttribute('stroke-opacity') ?? 1));

    const settle = () => {
      for (const t of threads) {
        gsap.set(t, { strokeDasharray: 'none', strokeDashoffset: 0, strokeOpacity: resting.get(t)! });
      }
      gsap.set(lit, { strokeDasharray: 'none', strokeDashoffset: 0, opacity: 1 });
      gsap.set([names, rings, ringLabels, core], { opacity: 1 });
      done.current = true;
    };

    if (REDUCED()) {
      settle();
      return;
    }

    // The first arrival earns the full ceremony. Every switch after it is
    // navigation, and navigation should feel instant.
    const tl = gsap.timeline({ onComplete: settle });
    tl.timeScale(seen.current ? 2.9 : 1);
    seen.current = true;

    gsap.set([rings, ringLabels], { opacity: 0 });
    gsap.set(core, { opacity: 0 });
    gsap.set(names, { opacity: 0 });
    gsap.set(lit, { opacity: 0 });

    for (const t of threads) {
      const len = t.getTotalLength();
      gsap.set(t, { strokeDasharray: len, strokeDashoffset: len, strokeOpacity: 0.9 });
    }

    tl.to([rings, ringLabels], { opacity: 1, duration: 0.8, ease: 'power1.out' }, 0);

    // Names sweep in around the rim.
    tl.to(names, { opacity: 1, duration: 0.5, stagger: { each: 0.006, from: 'start' } }, 0.15);

    // The field assembles, round by round, growing inward.
    for (let r = 1; r <= 8; r++) {
      const group = threads.filter((t) => Number(t.dataset.round) === r);
      if (!group.length) continue;
      tl.to(
        group,
        { strokeDashoffset: 0, duration: 0.62, ease: 'power2.inOut', stagger: { each: 0.0035, from: 'random' } },
        0.35 + (r - 1) * 0.17,
      );
    }

    const assembled = 0.35 + 7 * 0.17 + 0.62;

    // The decay wave: each round settles to its resting weight, rim first.
    for (let r = 1; r <= 8; r++) {
      const group = threads.filter((t) => Number(t.dataset.round) === r);
      if (!group.length) continue;
      tl.to(
        group,
        {
          strokeOpacity: (_i: number, target: Element) => resting.get(target as SVGPathElement)!,
          duration: 0.7,
          ease: 'power2.out',
        },
        assembled + 0.25 + (r - 1) * 0.09,
      );
    }

    const decayed = assembled + 0.25 + 7 * 0.09 + 0.7;

    // The surviving path lights last, rim to centre.
    for (const [i, p] of lit.entries()) {
      const len = p.getTotalLength();
      gsap.set(p, { strokeDasharray: len, strokeDashoffset: len, opacity: 1 });
      tl.to(p, { strokeDashoffset: 0, duration: 0.34, ease: 'none' }, decayed - 0.35 + i * 0.2);
    }

    tl.fromTo(
      core,
      { opacity: 0, transformOrigin: '50% 50%', scale: 0.3 },
      { opacity: 1, scale: 1, duration: 0.9, ease: 'elastic.out(1, 0.55)' },
      decayed - 0.35 + lit.length * 0.2,
    );

    const skip = () => {
      if (!done.current) tl.progress(1);
    };
    svg.addEventListener('pointerdown', skip);

    return () => {
      svg.removeEventListener('pointerdown', skip);
      tl.kill();
    };
  }, [root, key]);

  return done;
}
