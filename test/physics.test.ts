import { describe, expect, it } from 'vitest';
import {
  DECELERATION,
  bound,
  chooseDetent,
  dampingRatio,
  nearest,
  parseSnap,
  project,
  rubberBand,
  scrimOpacity,
  settled,
  shouldDragContent,
  stepSpring,
  velocity,
  type SpringParams,
  type SpringState,
} from '../src/physics';

const DEFAULT: SpringParams = { stiffness: 400, damping: 40, mass: 1 };

/** Runs a spring at 60 fps until it settles; returns the path and frame count. */
function run(s: SpringState, target: number, p = DEFAULT, maxFrames = 600) {
  const path: number[] = [];
  let frames = 0;
  while (!settled(s, target) && frames < maxFrames) {
    stepSpring(s, target, 1 / 60, p);
    path.push(s.x);
    frames++;
  }
  return { path, frames };
}

describe('projection', () => {
  it('adds v * d / (1 - d) with d = 0.998', () => {
    expect(DECELERATION).toBe(0.998);
    expect(project(100, 1)).toBeCloseTo(100 + 499, 6);
    expect(project(300, -2)).toBeCloseTo(300 - 998, 6);
  });

  it('is the identity at zero velocity', () => {
    expect(project(240, 0)).toBe(240);
  });

  it('matches the sum of a decaying per-ms velocity', () => {
    let y = 0;
    let v = 1.5;
    for (let i = 0; i < 20000; i++) {
      v *= DECELERATION;
      y += v;
    }
    expect(project(0, 1.5)).toBeCloseTo(y, 3);
  });
});

describe('release velocity (100 ms window)', () => {
  it('uses only samples inside the last 100 ms', () => {
    const q = [
      { t: 0, y: 0 },
      { t: 50, y: 500 }, // old fast movement, outside the window at t=200
      { t: 120, y: 510 },
      { t: 200, y: 590 },
    ];
    expect(velocity(q, 200)).toBeCloseTo(80 / 80, 6);
  });

  it('is 0 when the finger rested before lifting', () => {
    const q = [
      { t: 0, y: 0 },
      { t: 16, y: 40 },
    ];
    expect(velocity(q, 300)).toBe(0);
  });

  it('is 0 with fewer than two samples', () => {
    expect(velocity([], 10)).toBe(0);
    expect(velocity([{ t: 5, y: 1 }], 10)).toBe(0);
  });

  it('is negative for an upward flick', () => {
    const q = [
      { t: 100, y: 400 },
      { t: 116, y: 370 },
      { t: 132, y: 330 },
    ];
    expect(velocity(q, 132)).toBeCloseTo(-70 / 32, 6);
  });
});

describe('detent choice', () => {
  // A 800 px sheet with detents at 25%, 60% and 100% of its height.
  const H = 800;
  const Y = [H - 200, H - 480, 0]; // y positions, lowest first: 600, 320, 0

  it('picks the detent nearest the projected point, not the release point', () => {
    // Released right next to the middle detent, but flicked upward.
    expect(nearest(Y, 330)).toBe(1);
    expect(chooseDetent(Y, 330, -0.8, { closed: H })).toBe(2);
    // Same place, flicked down: lands on the lowest detent.
    expect(chooseDetent(Y, 330, 0.45, { closed: H })).toBe(0);
  });

  it('stays on the nearest detent for a slow release', () => {
    expect(chooseDetent(Y, 300, 0, { closed: H })).toBe(1);
    expect(chooseDetent(Y, 40, 0.02, { closed: H })).toBe(2);
  });

  it('a hard flick up from the bottom skips the middle detent', () => {
    expect(chooseDetent(Y, 600, -2, { closed: H })).toBe(2);
  });
});

describe('dismiss rules', () => {
  const H = 800;
  const Y = [600, 320, 0];

  it('dismisses a downward flick over 0.5 px/ms from the lowest detent', () => {
    expect(chooseDetent(Y, 610, 0.6, { closed: H, dismissible: true })).toBe(-1);
    expect(chooseDetent(Y, 610, 0.1, { closed: H, dismissible: true })).toBe(0);
  });

  it('dismisses when the projection ends below 50% of the lowest detent', () => {
    // Lowest detent shows 200 px, so the line is at 100 px visible (y = 700).
    expect(chooseDetent(Y, 705, 0, { closed: H, dismissible: true })).toBe(-1);
    expect(chooseDetent(Y, 690, 0, { closed: H, dismissible: true })).toBe(0);
    // Released above the line but projected past it.
    expect(chooseDetent(Y, 640, 0.2, { closed: H, dismissible: true })).toBe(-1);
  });

  it('a moderate flick from the top lands on a lower detent instead of closing', () => {
    expect(chooseDetent(Y, 20, 0.6, { closed: H, dismissible: true })).toBe(1);
  });

  it('a very hard flick from the top still closes via projection', () => {
    expect(chooseDetent(Y, 20, 3, { closed: H, dismissible: true })).toBe(-1);
  });

  it('never dismisses when not dismissible', () => {
    expect(chooseDetent(Y, 780, 4, { closed: H })).toBe(0);
    expect(chooseDetent(Y, 780, 4, { closed: H, dismissible: false })).toBe(0);
  });
});

describe('rubber band', () => {
  it('is zero at the limit and for negative input', () => {
    expect(rubberBand(0, 800)).toBe(0);
    expect(rubberBand(-10, 800)).toBe(0);
  });

  it('follows (1 - 1/(x*0.55/dim + 1)) * dim', () => {
    expect(rubberBand(800, 800)).toBeCloseTo((1 - 1 / 1.55) * 800, 6);
    expect(rubberBand(100, 800)).toBeCloseTo((1 - 1 / (100 * 0.55 / 800 + 1)) * 800, 6);
  });

  it('grows monotonically, slower than the finger, and never reaches dim', () => {
    let prev = 0;
    for (let x = 10; x <= 20000; x *= 1.5) {
      const r = rubberBand(x, 800);
      expect(r).toBeGreaterThan(prev);
      expect(r).toBeLessThan(x);
      expect(r).toBeLessThan(800);
      prev = r;
    }
  });

  it('bound() follows inside the limits and resists outside', () => {
    expect(bound(300, 0, 600, 800)).toBe(300);
    expect(bound(-100, 0, 600, 800)).toBeCloseTo(-rubberBand(100, 800), 6);
    expect(bound(700, 0, 600, 800)).toBeCloseTo(600 + rubberBand(100, 800), 6);
    expect(bound(-100, 0, 600, 800)).toBeGreaterThan(-100);
  });
});

describe('spring', () => {
  it('settles on the target with the default constants', () => {
    const s = { x: 600, v: 0 };
    const { frames } = run(s, 0);
    expect(settled(s, 0)).toBe(true);
    expect(Math.abs(s.x)).toBeLessThan(0.5);
    expect(frames).toBeLessThan(90); // under 1.5 s at 60 fps
  });

  it('defaults are critically damped: no overshoot', () => {
    expect(dampingRatio(DEFAULT)).toBeCloseTo(1, 6);
    const { path } = run({ x: 600, v: 0 }, 0);
    expect(Math.min(...path)).toBeGreaterThan(-0.5);
  });

  it('an underdamped spring overshoots, then settles', () => {
    const p = { stiffness: 400, damping: 12, mass: 1 };
    expect(dampingRatio(p)).toBeLessThan(1);
    const s = { x: 600, v: 0 };
    const { path } = run(s, 0, p);
    expect(Math.min(...path)).toBeLessThan(-20);
    expect(settled(s, 0)).toBe(true);
  });

  it('carries the release velocity: an upward flick keeps moving up first', () => {
    // At the target already, but released moving up at 2 px/ms.
    const s = { x: 320, v: -2000 };
    stepSpring(s, 320, 1 / 60, DEFAULT);
    expect(s.x).toBeLessThan(320);
    run(s, 320);
    expect(Math.abs(s.x - 320)).toBeLessThan(0.5);
  });

  it('is stable for a long frame (capped) and stiff settings', () => {
    const s = { x: 600, v: 0 };
    stepSpring(s, 0, 5, { stiffness: 1000, damping: 20, mass: 0.5 });
    expect(Number.isFinite(s.x)).toBe(true);
    expect(Math.abs(s.x)).toBeLessThan(600);
    run(s, 0, { stiffness: 1000, damping: 20, mass: 0.5 });
    expect(settled(s, 0)).toBe(true);
  });

  it('heavier mass settles slower', () => {
    const light = run({ x: 600, v: 0 }, 0, { stiffness: 400, damping: 40, mass: 1 }).frames;
    const heavy = run({ x: 600, v: 0 }, 0, { stiffness: 400, damping: 40, mass: 3 }).frames;
    expect(heavy).toBeGreaterThan(light);
  });
});

describe('snap parsing', () => {
  it('reads percentages, px, bare px and fractions, sorted', () => {
    expect(parseSnap('100% 25% 60%', 800)).toEqual([200, 480, 800]);
    expect(parseSnap('320px 0.5', 800)).toEqual([320, 400]);
    expect(parseSnap('120 100%', 800)).toEqual([120, 800]);
  });

  it('clamps to the available height and drops duplicates and junk', () => {
    expect(parseSnap('50% 400px 2000px nope -3', 800)).toEqual([400, 800]);
  });

  it('falls back to 50% 90%, or the full height when nothing parses', () => {
    expect(parseSnap(null, 1000)).toEqual([500, 900]);
    expect(parseSnap('nope', 600)).toEqual([600]);
  });
});

describe('scrim', () => {
  const Y = [600, 320, 0];
  it('fades in from closed to the lowest detent by default', () => {
    expect(scrimOpacity(800, Y, -1, 800)).toBe(0);
    expect(scrimOpacity(700, Y, -1, 800)).toBeCloseTo(0.5, 6);
    expect(scrimOpacity(600, Y, -1, 800)).toBe(1);
    expect(scrimOpacity(0, Y, -1, 800)).toBe(1);
  });

  it('with backdrop-from = 1 it is clear at 60% and full at 100%', () => {
    expect(scrimOpacity(600, Y, 1, 800)).toBe(0);
    expect(scrimOpacity(320, Y, 1, 800)).toBe(0);
    expect(scrimOpacity(160, Y, 1, 800)).toBeCloseTo(0.5, 6);
    expect(scrimOpacity(0, Y, 1, 800)).toBe(1);
  });
});

describe('nested scroll handoff', () => {
  it('drags the sheet below the top detent in either direction', () => {
    expect(shouldDragContent(false, 0, -10)).toBe(true);
    expect(shouldDragContent(false, 120, 10)).toBe(true);
  });

  it('at the top detent, scrolls content unless it is at scrollTop 0 and moving down', () => {
    expect(shouldDragContent(true, 0, 10)).toBe(true);
    expect(shouldDragContent(true, 0, -10)).toBe(false);
    expect(shouldDragContent(true, 40, 10)).toBe(false);
  });
});
