import {
  bound,
  chooseDetent,
  nearest,
  parseSnap,
  project,
  scrimOpacity,
  settled,
  shouldDragContent,
  stepSpring,
  velocity,
  type Sample,
  type SpringState,
} from './physics';

export type CloseReason = 'swipe' | 'escape' | 'scrim' | 'method';

export interface SheetDragDetail {
  phase: 'move' | 'end';
  /** visible height of the sheet, px */
  height: number;
  /** finger velocity over the last 100 ms, px/ms, positive = down */
  velocity: number;
  /** visible height the flick would come to rest at, px (can be negative) */
  projected: number;
  /** detent the sheet would go to if released now, -1 = dismiss */
  index: number;
  /** height available to the sheet, px */
  container: number;
}
export interface SheetSnapDetail {
  index: number;
  height: number;
}
export interface SheetOpenDetail {
  index: number;
}
export interface SheetCloseDetail {
  reason: CloseReason;
}

interface Drag {
  id: number;
  y0: number;
  p0: number;
  /** active: the sheet is following the finger */
  a: boolean;
  /** started on the scrolling content */
  c: boolean;
  q: Sample[];
}

const CSS = `:host{position:fixed;inset:0;z-index:var(--sheet-z,100);pointer-events:none;display:block}
dialog{position:absolute;inset:0;width:100%;height:100%;max-width:none;max-height:none;margin:0;padding:0;border:0;background:none;color:inherit;overflow:clip;pointer-events:none}
dialog:modal{position:fixed}
dialog::backdrop{background:none}
[part=scrim]{position:absolute;inset:0;background:var(--sheet-scrim,rgba(20,20,19,.4));opacity:0;pointer-events:auto;touch-action:none}
dialog:not(:modal) [part=scrim]{display:none}
[part=panel]{position:absolute;left:0;right:0;bottom:0;box-sizing:border-box;max-width:var(--sheet-max-width,640px);margin:0 auto;display:flex;flex-direction:column;background:var(--sheet-bg,#fff);color:var(--sheet-color,inherit);border-radius:var(--sheet-radius,16px) var(--sheet-radius,16px) 0 0;box-shadow:var(--sheet-shadow,0 0 0 1px rgba(20,20,19,.06),0 -6px 28px rgba(20,20,19,.12));padding-bottom:env(safe-area-inset-bottom,0px);transform:translate3d(0,200vh,0);will-change:transform;pointer-events:auto;touch-action:none;overscroll-behavior:contain;outline:0}
[part=panel]:after{content:"";position:absolute;top:100%;left:0;right:0;height:100vh;background:inherit}
[part=grip]{all:unset;position:relative;flex:none;display:grid;place-items:center;height:var(--sheet-grip-height,22px);cursor:grab;touch-action:none}
[part=grip]:before{content:"";position:absolute;inset:-14px 0 -8px}
[part=handle]{width:36px;height:5px;border-radius:9px;background:var(--sheet-handle,#c9c6bd)}
[part=grip]:focus-visible [part=handle]{outline:2px solid var(--sheet-focus,#2747d9);outline-offset:3px}
[part=header],[part=footer]{flex:none}
[part=footer]{position:relative;z-index:1;background:inherit}
[part=content]{flex:1;min-height:0;overflow-y:auto;overscroll-behavior:contain;touch-action:pan-y}
.d,.d [part=grip]{cursor:grabbing;user-select:none;-webkit-user-select:none}`;

const HTML =
  '<dialog part="dialog"><div part="scrim"></div><div part="panel"><button part="grip" type="button" aria-label="Resize sheet"><span part="handle"></span></button><div part="header"><slot name="header"></slot></div><div part="content"><slot></slot></div><div part="footer"><slot name="footer"></slot></div></div></dialog>';

const NO_DRAG = 'input,textarea,select,[contenteditable]:not([contenteditable=false]),[data-no-drag]';

/**
 * `<bottom-sheet>`: a bottom sheet with velocity projection, spring physics,
 * rubber banding, nested scroll handoff and a native `<dialog>` for modality.
 */
export class BottomSheet extends HTMLElement {
  static observedAttributes = ['open', 'snap', 'label', 'backdrop-from'];

  #d: HTMLDialogElement;
  #p: HTMLElement;
  #c: HTMLElement;
  #h: HTMLElement;
  #f: HTMLElement;
  #m: HTMLElement;
  /** available height, top detent height, detent y positions (lowest first) */
  #C = 0;
  #H = 0;
  #Y: number[] = [0];
  #s: SpringState = { x: 0, v: 0 };
  #t = 0;
  #i = 0;
  /** wanted detent, kept when the sheet opens before it has a size */
  #w = 0;
  #bf = -1;
  #hh = 0;
  #fh = 0;
  #kb = 0;
  #on = false;
  #shut = false;
  #why: CloseReason = 'method';
  #raf = 0;
  #last = 0;
  #g?: Drag;
  #mute = false;
  #ret: Element | null = null;
  #vvOn = false;

  constructor() {
    super();
    const r = this.attachShadow({ mode: 'open' });
    r.innerHTML = `<style>${CSS}</style>${HTML}`;
    const q = (s: string) => r.querySelector(`[part=${s}]`) as HTMLElement;
    const d = (this.#d = q('dialog') as HTMLDialogElement);
    const p = (this.#p = q('panel'));
    this.#c = q('content');
    this.#h = q('header');
    this.#f = q('footer');
    const m = (this.#m = q('scrim'));
    const g = q('grip');
    const stop = (e: Event) => e.preventDefault();

    p.addEventListener('pointerdown', this.#down);
    p.addEventListener('pointermove', this.#move);
    p.addEventListener('pointerup', this.#up);
    p.addEventListener('pointercancel', this.#up);
    p.addEventListener(
      'click',
      (e) => {
        if (this.#mute) {
          e.preventDefault();
          e.stopPropagation();
        }
      },
      true,
    );
    this.#c.addEventListener('touchmove', (e) => this.#g?.a && e.preventDefault(), { passive: false });
    m.addEventListener('click', () => this.#dismiss('scrim'));
    m.addEventListener('wheel', stop, { passive: false });
    m.addEventListener('touchmove', stop, { passive: false });
    g.addEventListener('click', () => this.snapTo(this.#i < this.#Y.length - 1 ? this.#i + 1 : 0));
    g.addEventListener('keydown', (e) => {
      const k = e.key;
      const n = this.#Y.length - 1;
      const i = k == 'ArrowUp' ? this.#i + 1 : k == 'ArrowDown' ? this.#i - 1 : k == 'End' ? n : k == 'Home' ? 0 : -1;
      if (i >= 0 && i <= n) {
        e.preventDefault();
        this.snapTo(i);
      }
    });
    d.addEventListener('cancel', stop);
    d.addEventListener('keydown', (e) => e.key == 'Escape' && this.#dismiss('escape'));
    // The browser can force-close a modal dialog (repeated Esc); keep state in sync.
    d.addEventListener('close', () => this.#on && !d.open && this.#finish('escape'));
    new ResizeObserver(() => this.#on && !this.#g?.a && this.#refit()).observe(d);
  }

  /** Detent heights in px, lowest first. */
  get detents(): number[] {
    return this.#Y.map((y) => this.#H - y);
  }
  /** Current (or target) detent index. */
  get index(): number {
    return this.#i;
  }
  get open(): boolean {
    return this.#on;
  }
  set open(v: boolean) {
    v ? this.show() : this.close();
  }

  /** Opens at detent `index` (default: the `initial` attribute, else 0). */
  show(index?: number): void {
    this.#open(index, false);
  }

  /** Animates the sheet away, then closes the dialog. */
  close(reason: CloseReason = 'method'): void {
    if (!this.#on) return;
    this.#on = false;
    this.#shut = true;
    this.#why = reason;
    this.removeAttribute('open');
    this.#p.inert = true;
    this.#go(this.#H);
  }

  /** Springs to detent `i`; opens the sheet there if it is closed. */
  snapTo(i: number): void {
    if (!this.#on) return this.show(i);
    this.#i = Math.min((this.#w = Math.max(0, i | 0)), this.#Y.length - 1);
    this.#go(this.#Y[this.#i]);
  }

  connectedCallback(): void {
    if (this.hasAttribute('open') && !this.#on) requestAnimationFrame(() => this.isConnected && this.#open(undefined, true));
  }

  disconnectedCallback(): void {
    this.#stop();
    this.#watch(false);
  }

  attributeChangedCallback(name: string, _: string | null, v: string | null): void {
    if (name == 'label') v == null ? this.#d.removeAttribute('aria-label') : this.#d.setAttribute('aria-label', v);
    else if (name == 'open') {
      if ((v != null) != this.#on && this.isConnected) v != null ? this.show() : this.close();
    } else if (this.#on && !this.#g?.a) this.#refit();
  }

  #b(name: string): boolean {
    const v = this.getAttribute(name);
    return v != null && v != 'false';
  }

  #n(name: string, d: number): number {
    return parseFloat(this.getAttribute(name)!) || d;
  }

  #open(index: number | undefined, instant: boolean): void {
    if (this.#on) {
      if (index != null) this.snapTo(index);
      return;
    }
    const resume = this.#shut;
    this.#on = true;
    this.#shut = false;
    this.#p.inert = false;
    if (!this.hasAttribute('open')) this.setAttribute('open', '');
    const d = this.#d;
    if (!d.open) {
      this.#ret = document.activeElement;
      // A non-modal sheet must not steal focus (it may open on page load).
      this.#b('modal') ? d.showModal() : d.setAttribute('open', '');
    }
    this.#watch(true);
    this.#w = Math.max(0, (index ?? this.#n('initial', 0)) | 0);
    this.#measure();
    if (!resume) this.#s = { x: this.#H, v: 0 };
    this.#emit<SheetOpenDetail>('sheet-open', { index: this.#i });
    if (instant) {
      this.#s.x = this.#t = this.#Y[this.#i];
      this.#paint();
    } else this.#go(this.#Y[this.#i]);
  }

  #dismiss(r: CloseReason): void {
    if (this.#b('dismissible')) this.close(r);
  }

  #finish(r: CloseReason): void {
    this.#stop();
    this.#on = this.#shut = false;
    this.removeAttribute('open');
    this.#watch(false);
    if (this.#d.open) this.#d.close();
    const a = this.#ret as HTMLElement | null;
    this.#ret = null;
    const f = document.activeElement;
    if (a?.isConnected && a.focus && (!f || f == document.body || this.contains(f))) a.focus({ preventScroll: true });
    this.#emit<SheetCloseDetail>('sheet-close', { reason: r });
  }

  /** Reads layout. Only on open, resize and keyboard changes, never per frame. */
  #measure(): void {
    const C = (this.#C = Math.max(0, this.#d.clientHeight - this.#kb));
    const hs = parseSnap(this.getAttribute('snap'), C);
    const H = (this.#H = hs[hs.length - 1]);
    this.#Y = hs.map((h) => H - h);
    this.#i = Math.min(this.#w, hs.length - 1);
    const b = this.getAttribute('backdrop-from');
    this.#bf =
      b == null
        ? -1
        : /%|px$/.test(b)
          ? nearest(this.#Y, H - parseSnap(b, C)[0])
          : Math.max(0, Math.min(parseInt(b) || 0, hs.length - 1));
    const s = this.#p.style;
    s.height = H + 'px';
    s.bottom = this.#kb + 'px';
    this.#hh = this.#h.offsetTop + this.#h.offsetHeight;
    this.#fh = this.#f.offsetHeight;
  }

  /** Re-measures and puts the sheet back on its detent (resize, snap change). */
  #refit(): void {
    this.#measure();
    if (this.#shut) return;
    if (this.#raf) this.#go(this.#Y[this.#i]);
    else {
      this.#s.x = this.#t = this.#Y[this.#i];
      this.#paint();
    }
  }

  /** Writes transforms and opacity only. */
  #paint(): void {
    const y = this.#s.x;
    this.#p.style.transform = `translate3d(0,${y}px,0)`;
    this.#m.style.opacity = '' + scrimOpacity(y, this.#Y, this.#bf, this.#H);
    // Sticky footer: ride the visible bottom edge, but never above the header.
    const f = Math.max(0, Math.min(y, this.#H - this.#fh - this.#hh));
    this.#f.style.transform = `translate3d(0,${-f}px,0)`;
  }

  #go(y: number): void {
    this.#t = y;
    if (matchMedia('(prefers-reduced-motion: reduce)').matches) {
      this.#stop();
      this.#s = { x: y, v: 0 };
      this.#paint();
      this.#done();
    } else if (!this.#raf) {
      this.#last = performance.now();
      this.#raf = requestAnimationFrame(this.#tick);
    }
  }

  #tick = (now: number): void => {
    const s = this.#s;
    stepSpring(s, this.#t, (now - this.#last) / 1000, {
      stiffness: this.#n('stiffness', 400),
      damping: this.#n('damping', 40),
      mass: this.#n('mass', 1),
    });
    this.#last = now;
    const end = settled(s, this.#t) || (this.#shut && s.x >= this.#H);
    if (end) this.#s = { x: this.#t, v: 0 };
    this.#paint();
    this.#raf = end ? 0 : requestAnimationFrame(this.#tick);
    if (end) this.#done();
  };

  #stop(): void {
    cancelAnimationFrame(this.#raf);
    this.#raf = 0;
  }

  #done(): void {
    if (this.#shut) this.#finish(this.#why);
    else this.#emit<SheetSnapDetail>('sheet-snap', { index: this.#i, height: this.#H - this.#Y[this.#i] });
  }

  #atTop(): boolean {
    const n = this.#Y.length - 1;
    return this.#i == n && Math.abs(this.#s.x - this.#Y[n]) < 2;
  }

  #down = (e: PointerEvent): void => {
    if (!this.#on || this.#g || (e.pointerType == 'mouse' && e.button)) return;
    if ((e.target as Element).closest?.(NO_DRAG)) return;
    this.#g = { id: e.pointerId, y0: e.clientY, p0: this.#s.x, a: false, c: e.composedPath().includes(this.#c), q: [] };
  };

  #move = (e: PointerEvent): void => {
    const g = this.#g;
    if (!g || e.pointerId != g.id) return;
    if (!g.a) {
      const dy = e.clientY - g.y0;
      if (Math.abs(dy) < 4) return;
      const c = this.#c;
      if (g.c && c.scrollHeight > c.clientHeight + 1 && !shouldDragContent(this.#atTop(), c.scrollTop, dy)) {
        this.#g = undefined;
        return;
      }
      g.a = true;
      g.y0 = e.clientY;
      g.p0 = this.#s.x;
      this.#stop();
      try {
        this.#p.setPointerCapture(e.pointerId);
      } catch {
        /* pointer already gone */
      }
      this.#p.classList.add('d');
    }
    const raw = g.p0 + e.clientY - g.y0;
    const n = this.#Y.length - 1;
    this.#s.x = bound(raw, this.#Y[n], this.#b('dismissible') ? this.#H : this.#Y[0], this.#C);
    this.#s.v = 0;
    g.q.push({ t: e.timeStamp, y: raw });
    if (g.q.length > 24) g.q.shift();
    this.#paint();
    this.#report('move', velocity(g.q, e.timeStamp));
  };

  #up = (e: PointerEvent): void => {
    const g = this.#g;
    if (!g || e.pointerId != g.id) return;
    this.#g = undefined;
    if (!g.a) return;
    this.#p.classList.remove('d');
    if (this.#p.hasPointerCapture(e.pointerId)) this.#p.releasePointerCapture(e.pointerId);
    this.#mute = true;
    setTimeout(() => (this.#mute = false));
    const v = e.type == 'pointercancel' ? 0 : velocity(g.q, e.timeStamp);
    const i = this.#report('end', v);
    // Feed the release velocity into the spring so the motion is continuous.
    this.#s.v = v * 1000;
    i < 0 ? this.close('swipe') : this.snapTo(i);
  };

  #report(phase: SheetDragDetail['phase'], v: number): number {
    const y = this.#s.x;
    const i = chooseDetent(this.#Y, y, v, { dismissible: this.#b('dismissible'), closed: this.#H });
    this.#emit<SheetDragDetail>('sheet-drag', {
      phase,
      height: this.#H - y,
      velocity: v,
      projected: this.#H - project(y, v),
      index: i,
      container: this.#C,
    });
    return i;
  }

  /** On-screen keyboard: lift the sheet above it and expand when a field inside has focus. */
  #vv = (): void => {
    const vv = visualViewport!;
    const kb = Math.max(0, Math.round(innerHeight - vv.height - vv.offsetTop));
    if (kb == this.#kb) return;
    this.#kb = kb;
    this.#measure();
    if (kb && this.matches(':focus-within')) {
      this.#w = this.#i = this.#Y.length - 1;
      setTimeout(() => document.activeElement?.scrollIntoView({ block: 'nearest' }), 50);
    }
    this.#go(this.#Y[this.#i]);
  };

  #watch(on: boolean): void {
    const vv = window.visualViewport;
    if (!vv || on == this.#vvOn) return;
    // Only a sheet pinned to the viewport needs to dodge the keyboard.
    if (on && !this.#b('modal') && getComputedStyle(this).position != 'fixed') return;
    this.#vvOn = on;
    const f = on ? 'addEventListener' : 'removeEventListener';
    vv[f]('resize', this.#vv);
    vv[f]('scroll', this.#vv);
    if (!on && this.#kb) {
      this.#kb = 0;
      this.#p.style.bottom = '0px';
    }
  }

  #emit<T>(type: string, detail: T): void {
    this.dispatchEvent(new CustomEvent(type, { detail, bubbles: true, composed: true }));
  }
}

export interface BottomSheetEventMap extends HTMLElementEventMap {
  'sheet-open': CustomEvent<SheetOpenDetail>;
  'sheet-close': CustomEvent<SheetCloseDetail>;
  'sheet-snap': CustomEvent<SheetSnapDetail>;
  'sheet-drag': CustomEvent<SheetDragDetail>;
}

declare global {
  interface HTMLElementTagNameMap {
    'bottom-sheet': BottomSheet;
  }
}

if (!customElements.get('bottom-sheet')) customElements.define('bottom-sheet', BottomSheet);
