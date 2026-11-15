/**
 * Pure physics for <bottom-sheet>. No DOM in here, so every rule is unit tested.
 *
 * Coordinates: `y` is the panel's translateY in px. 0 is the top detent, larger is lower
 * on screen, and `closed` is the y where nothing of the sheet is visible. Detents are
 * passed as y positions too. Velocities from pointer samples are px/ms (positive = down);
 * the spring works in px/s because its constants (stiffness 400, damping 40) are SI-style.
 */

export interface Sample {
  /** event timeStamp in ms */
  t: number;
  /** position in px */
  y: number;
}

export interface SpringParams {
  stiffness: number;
  damping: number;
  mass: number;
}

export interface SpringState {
  /** position, px */
  x: number;
  /** velocity, px/s */
  v: number;
}

/** iOS UIScrollView "normal" deceleration rate, per ms. */
export const DECELERATION = 0.998;
/** Only samples from the last 100 ms count towards release velocity. */
export const VELOCITY_WINDOW = 100;
/** Downward flick (px/ms) that dismisses from the lowest detent. */
export const DISMISS_VELOCITY = 0.5;
/** Rubber band constant, same as UIScrollView. */
export const RUBBER = 0.55;

/**
 * Where a flick would come to rest if it decayed like a scroll view:
 * the sum of v·d^n over every remaining ms is v·d/(1-d).
 */
export const project = (y: number, v: number, d = DECELERATION): number => y + (v * d) / (1 - d);

/**
 * Release velocity in px/ms from the samples inside the last `win` ms.
 * A finger that rested before lifting gives 0, so a slow placement never flings.
 */
export function velocity(samples: readonly Sample[], now: number, win = VELOCITY_WINDOW): number {
  const n = samples.length - 1;
  if (n < 1) return 0;
  const last = samples[n];
  if (now - last.t > win) return 0;
  let first = last;
  for (let j = n - 1; j >= 0 && now - samples[j].t <= win; j--) first = samples[j];
  const dt = last.t - first.t;
  return dt > 0 ? (last.y - first.y) / dt : 0;
}

/** Index of the detent closest to `y`. */
export function nearest(detents: readonly number[], y: number): number {
  let best = 0;
  for (let i = 1; i < detents.length; i++) {
    if (Math.abs(detents[i] - y) < Math.abs(detents[best] - y)) best = i;
  }
  return best;
}

export interface ChooseOptions {
  /** may the gesture close the sheet */
  dismissible?: boolean;
  /** y where the sheet is fully hidden */
  closed: number;
  /** deceleration rate, defaults to DECELERATION */
  d?: number;
}

/**
 * Where a released sheet goes. Returns a detent index, or -1 to dismiss.
 *
 * - The detent is chosen from the projected resting point, not the release point,
 *   so a flick carries the sheet past the detent you let go next to.
 * - Dismiss when the projection ends below 50% of the lowest detent's height,
 *   or on a downward flick faster than 0.5 px/ms that starts at or below the lowest detent.
 *   Higher up, a flick lands on its projected detent instead of closing the whole sheet.
 */
export function chooseDetent(detents: readonly number[], y: number, v: number, o: ChooseOptions): number {
  const p = project(y, v, o.d);
  if (o.dismissible) {
    const lowest = Math.max(...detents);
    if (v > DISMISS_VELOCITY && y >= lowest - 1) return -1;
    if (o.closed - p < (o.closed - lowest) / 2) return -1;
  }
  return nearest(detents, p);
}

/** Damped overshoot for dragging `x` px past a limit, never more than `dim`. */
export const rubberBand = (x: number, dim: number, c = RUBBER): number =>
  x <= 0 || dim <= 0 ? 0 : (1 - 1 / ((x * c) / dim + 1)) * dim;

/** Follows the finger between `min` and `max`, rubber bands beyond them. */
export const bound = (y: number, min: number, max: number, dim: number): number =>
  y < min ? min - rubberBand(min - y, dim) : y > max ? max + rubberBand(y - max, dim) : y;

/**
 * Advances a damped spring by `dt` seconds with semi-implicit Euler in fixed sub-steps
 * (velocity first, then position), which stays stable at rAF rates. Mutates and returns `s`.
 * Large gaps (a background tab) are capped at 64 ms so the sheet never teleports.
 */
export function stepSpring(s: SpringState, target: number, dt: number, p: SpringParams, h = 1 / 240): SpringState {
  let t = Math.min(Math.max(dt, 0), 0.064);
  while (t > 1e-9) {
    const k = t < h ? t : h;
    s.v += ((-p.stiffness * (s.x - target) - p.damping * s.v) / p.mass) * k;
    s.x += s.v * k;
    t -= k;
  }
  return s;
}

/** At rest: within half a pixel and slower than 20 px/s. */
export const settled = (s: SpringState, target: number): boolean =>
  Math.abs(s.x - target) < 0.5 && Math.abs(s.v) < 20;

/** Damping ratio: 1 is critical (fastest with no overshoot), below 1 bounces. */
export const dampingRatio = (p: SpringParams): number => p.damping / (2 * Math.sqrt(p.stiffness * p.mass));

/**
 * Parses a `snap` attribute into sorted detent heights (px) for an available height.
 * Tokens: `60%`, `320px`, a bare number > 1 (px) or a bare fraction <= 1 (`0.6`).
 */
export function parseSnap(spec: string | null | undefined, avail: number): number[] {
  const out: number[] = [];
  for (const t of (spec || '50% 90%').trim().split(/[\s,]+/)) {
    let h = parseFloat(t);
    if (!(h > 0)) continue;
    if (t.endsWith('%')) h = (h / 100) * avail;
    else if (!t.endsWith('px') && h <= 1) h *= avail;
    h = Math.min(h, avail);
    if (!out.some((o) => Math.abs(o - h) < 1)) out.push(h);
  }
  out.sort((a, b) => a - b);
  return out.length ? out : [avail];
}

/**
 * Scrim opacity for position `y`. With `from` < 0 it fades in between closed and the lowest
 * detent. With `from` = k it stays clear at detent k and below, and is full at detent k+1.
 * `detents` are y positions ordered lowest first (largest y first).
 */
export function scrimOpacity(y: number, detents: readonly number[], from: number, closed: number): number {
  const a = from < 0 ? closed : detents[from];
  const b = from < 0 ? detents[0] : detents[Math.min(from + 1, detents.length - 1)];
  if (a <= b) return y < a ? 1 : 0;
  const o = (a - y) / (a - b);
  return o < 0 ? 0 : o > 1 ? 1 : o;
}

/**
 * Nested scroll handoff: should a drag that starts on scrollable content move the sheet?
 * Yes below the top detent (it expands first, like iOS), or when the content is scrolled to
 * the top and the finger moves down. Otherwise the content scrolls.
 */
export const shouldDragContent = (atTop: boolean, scrollTop: number, dy: number): boolean =>
  !atTop || (scrollTop <= 0 && dy > 0);
