import './style.css';
import '../src/bottom-sheet';
import type { BottomSheet, SheetDragDetail, SheetSnapDetail } from '../src/bottom-sheet';
import { dampingRatio } from '../src/physics';


const $ = <T extends Element = HTMLElement>(s: string, r: ParentNode = document) => r.querySelector(s) as T;
const $$ = <T extends Element = HTMLElement>(s: string, r: ParentNode = document) => [...r.querySelectorAll<T>(s)];
const sheet = (id: string) => document.getElementById(id) as BottomSheet;

/* ---------- theme: system / light / dark ---------- */
const THEMES = ['system', 'light', 'dark'] as const;
type Theme = (typeof THEMES)[number];
const themeBtn = $<HTMLButtonElement>('#theme');
let theme: Theme = (document.documentElement.dataset.theme as Theme) || 'system';
function setTheme(t: Theme, store = true) {
  theme = t;
  if (t === 'system') delete document.documentElement.dataset.theme;
  else document.documentElement.dataset.theme = t;
  themeBtn.textContent = t;
  themeBtn.setAttribute('aria-label', `Colour theme: ${t}. Change theme`);
  if (!store) return;
  try {
    t === 'system' ? localStorage.removeItem('sheet-theme') : localStorage.setItem('sheet-theme', t);
  } catch {
    /* storage can be blocked; the toggle still works for this visit */
  }
}
setTheme(theme, false);
themeBtn.addEventListener('click', () => setTheme(THEMES[(THEMES.indexOf(theme) + 1) % THEMES.length]));

/* ---------- copy buttons ---------- */
async function copy(text: string, btn: HTMLElement) {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.setAttribute('readonly', '');
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.append(ta);
    ta.select();
    document.execCommand('copy');
    ta.remove();
  }
  const label = btn.dataset.label ?? btn.textContent ?? '';
  btn.dataset.label = label;
  btn.textContent = 'Copied';
  clearTimeout(Number(btn.dataset.t));
  btn.dataset.t = String(setTimeout(() => (btn.textContent = label), 1400));
}
$$<HTMLButtonElement>('[data-copy]').forEach((b) => b.addEventListener('click', () => copy(b.dataset.copy!, b)));

/* ---------- the demo sheets (stage on wide screens, real modal on phones) ---------- */
const stage = sheet('stage-sheet');
const phone = sheet('phone-sheet');

function demoContent(): string {
  return `
  <div slot="header" class="sh-head">
    <h3>Drag me</h3>
    <div class="chips" role="group" aria-label="Go to detent"></div>
  </div>
  <div class="sh-body">
    <ul class="try">
      <li><span><b>Flick up hard</b> from the lowest detent. It skips the middle one, because the projection lands near the top.</span></li>
      <li><span><b>Pull past the top.</b> It resists more the further you go.</span></li>
      <li><span><b>Flick down</b> from the lowest detent to close it. A slow drag has to pass half its height.</span></li>
      <li><span><b>Tap the grabber</b> to step up a detent, or focus it and use the arrow keys.</span></li>
    </ul>
  </div>`;
}
stage.innerHTML = demoContent();
phone.innerHTML = demoContent();

$('#open-phone').addEventListener('click', () => phone.show());

const back = $<HTMLButtonElement>('#stage-back');
back.addEventListener('click', () => stage.show(1));
stage.addEventListener('sheet-close', () => (back.hidden = false));
stage.addEventListener('sheet-open', () => (back.hidden = true));

// Detent chips inside any sheet: data-snap="i" calls snapTo(i).
document.addEventListener('click', (e) => {
  const b = (e.target as Element).closest<HTMLElement>('[data-snap]');
  if (b) b.closest<BottomSheet>('bottom-sheet')?.snapTo(Number(b.dataset.snap));
});
function markChips(s: BottomSheet, i: number) {
  $$('[data-snap]', s).forEach((c) => c.setAttribute('aria-pressed', String(Number(c.dataset.snap) === i)));
}
for (const s of [stage, phone]) {
  s.addEventListener('sheet-snap', (e) => markChips(s, (e as CustomEvent<SheetSnapDetail>).detail.index));
  s.addEventListener('sheet-open', (e) => markChips(s, (e as CustomEvent<{ index: number }>).detail.index));
}

/* ---------- physics readout: live v, projected landing tick on a ruler, chosen detent ---------- */
type Rows = Record<'v' | 'h' | 'p' | 'to' | 'st', HTMLElement>;

class Readout {
  #rows: Rows;
  #cur: HTMLElement;
  #proj: HTMLElement;
  #marks: HTMLElement;
  #follow = 0;
  #C = 1;
  #pct: number[] = [];
  #busy = false;

  constructor(
    box: HTMLElement,
    private ruler: HTMLElement,
    private s: BottomSheet,
    private onActive?: (on: boolean) => void,
  ) {
    const row = (k: string, label: string) => `<div class="ro-row"><span>${label}</span><span data-r="${k}"></span></div>`;
    box.innerHTML = `${row('v', 'v')}${row('h', 'height')}${row('p', 'lands at')}${row('to', 'goes to')}<div class="ro-state" data-r="st">at rest</div>`;
    this.#rows = Object.fromEntries($$('[data-r]', box).map((el) => [el.dataset.r, el])) as Rows;
    let ticks = '';
    for (let i = 0; i <= 10; i++) {
      const major = i % 5 === 0;
      ticks += `<div class="r-tick${major ? ' major' : ''}" style="bottom:${i * 10}%">${i === 0 || i === 5 ? `<span>${i * 10}</span>` : ''}</div>`;
    }
    ruler.innerHTML = `${ticks}<div class="r-marks"></div><div class="r-cur" style="bottom:0"></div><div class="r-proj" style="bottom:0"></div>`;
    this.#marks = $('.r-marks', ruler);
    this.#cur = $('.r-cur', ruler);
    this.#proj = $('.r-proj', ruler);

    s.addEventListener('sheet-drag', (e) => this.#drag((e as CustomEvent<SheetDragDetail>).detail));
    s.addEventListener('sheet-snap', (e) => this.#rest((e as CustomEvent<SheetSnapDetail>).detail));
    s.addEventListener('sheet-close', () => this.#closed());
    s.addEventListener('sheet-open', () => requestAnimationFrame(() => this.#idle()));
    if (s.open) requestAnimationFrame(() => this.#idle());
    // The frame can change size (window resize); re-read once the sheet has refitted.
    new ResizeObserver(() => s.open && !this.#busy && requestAnimationFrame(() => this.#idle())).observe(s);
  }

  /** Detent marks from percentages, plus the dismiss line at half the lowest detent. */
  marks(pct: number[], dismissible: boolean) {
    this.#pct = pct;
    let html = pct.map((p) => `<div class="r-det" style="bottom:${p}%"><span>${p}%</span></div>`).join('');
    if (dismissible) html += `<div class="r-dismiss" style="bottom:${pct[0] / 2}%"><span>close</span></div>`;
    this.#marks.innerHTML = html;
  }

  #y(frac: number) {
    const h = this.ruler.offsetHeight;
    return `translateY(${-Math.max(0, Math.min(1, frac)) * h}px)`;
  }

  #set(height: number, v: number, projected: number, index: number) {
    const C = this.#C;
    const r = this.#rows;
    r.v.textContent = `${v > 0.005 ? '↓' : v < -0.005 ? '↑' : ' '} ${Math.abs(v).toFixed(2)} px/ms`;
    r.h.textContent = `${Math.round(height)} px`;
    r.p.textContent = `${Math.round(projected)} px`;
    r.to.textContent = index < 0 ? 'close' : `${this.#pct[index] ?? Math.round((this.s.detents[index] / C) * 100)}% · #${index}`;
    this.#cur.style.transform = this.#y(height / C);
    this.#proj.style.transform = this.#y(projected / C);
  }

  #drag(d: SheetDragDetail) {
    this.#C = d.container || 1;
    cancelAnimationFrame(this.#follow);
    this.#set(d.height, d.velocity, d.projected, d.index);
    this.#proj.classList.add('on');
    this.#rows.st.textContent = d.phase === 'move' ? 'dragging' : 'spring';
    this.#busy = true;
    this.onActive?.(true);
    if (d.phase === 'end') this.#track();
  }

  /** While the spring runs, follow the panel's real position (one read per frame). */
  #track() {
    const panel = this.s.shadowRoot!.querySelector('[part=panel]')!;
    const step = () => {
      const h = this.s.getBoundingClientRect().bottom - panel.getBoundingClientRect().top;
      this.#cur.style.transform = this.#y(h / this.#C);
      this.#rows.h.textContent = `${Math.max(0, Math.round(h))} px`;
      this.#follow = requestAnimationFrame(step);
    };
    this.#follow = requestAnimationFrame(step);
  }

  #rest(d: SheetSnapDetail) {
    cancelAnimationFrame(this.#follow);
    this.#rows.h.textContent = `${Math.round(d.height)} px`;
    this.#cur.style.transform = this.#y(d.height / this.#C);
    this.#rows.st.textContent = 'at rest';
    this.#busy = false;
    this.onActive?.(false);
  }

  #closed() {
    cancelAnimationFrame(this.#follow);
    this.#rows.h.textContent = '0 px';
    this.#cur.style.transform = this.#y(0);
    this.#rows.st.textContent = 'closed';
    this.#busy = false;
    this.onActive?.(false);
  }

  #idle() {
    this.#C = this.s.getBoundingClientRect().height || 1;
    const h = this.s.detents[this.s.index] ?? 0;
    this.#set(h, 0, h, this.s.index);
    this.#rows.st.textContent = 'at rest';
  }
}

const stageReadout = new Readout($('#readout'), $('#ruler'), stage);

const phoneBox = $('#phone-readout');
phoneBox.innerHTML = '<div class="readout mono"></div><div class="ruler"></div>';
let phoneHide = 0;
const phoneReadout = new Readout($('.readout', phoneBox), $('.ruler', phoneBox), phone, (on) => {
  clearTimeout(phoneHide);
  if (on) phoneBox.classList.add('on');
  else phoneHide = window.setTimeout(() => phoneBox.classList.remove('on'), 1600);
});
const canPopover = 'showPopover' in HTMLElement.prototype;
phone.addEventListener('sheet-open', () => {
  // A popover shown after showModal() stacks above the modal sheet in the top layer.
  if (canPopover && !phoneBox.matches(':popover-open')) phoneBox.showPopover();
});
phone.addEventListener('sheet-close', () => {
  if (canPopover && phoneBox.matches(':popover-open')) phoneBox.hidePopover();
});

/* ---------- tune and copy ---------- */
const T0 = { low: 25, mid: 60, top: 100, stiffness: 400, damping: 40, mass: 1, dismissible: true };
type Tune = typeof T0;
let T: Tune = { ...T0 };
const snippet = $('#snippet');
const zeta = $('#zeta');
const stageLines = $('#stage-lines');

const pcts = () => [...new Set([T.low, T.mid, T.top])].sort((a, b) => a - b);

function snippetText() {
  const snap = pcts().map((p) => `${p}%`).join(' ');
  return `<bottom-sheet\n  snap="${snap}"\n  stiffness="${T.stiffness}" damping="${T.damping}" mass="${T.mass}"${T.dismissible ? '\n  dismissible' : ''}>\n  <!-- your content -->\n</bottom-sheet>`;
}

function applyTune() {
  const p = pcts();
  const snap = p.map((v) => `${v}%`).join(' ');
  for (const s of [stage, phone]) {
    s.setAttribute('snap', snap);
    s.setAttribute('stiffness', String(T.stiffness));
    s.setAttribute('damping', String(T.damping));
    s.setAttribute('mass', String(T.mass));
    s.toggleAttribute('dismissible', T.dismissible);
    const chips = $('.chips', s);
    chips.innerHTML = p.map((v, i) => `<button class="chip" type="button" data-snap="${i}" aria-pressed="${i === s.index}">${v}%</button>`).join('');
  }
  for (const [k, v] of Object.entries(T)) {
    const o = document.querySelector(`[data-o="${k}"]`);
    if (o) o.textContent = k === 'mass' ? Number(v).toFixed(1) : ['low', 'mid', 'top'].includes(k) ? `${v}%` : String(v);
  }
  const z = dampingRatio(T);
  zeta.textContent = `ζ ${z.toFixed(2)} · ${z < 0.95 ? 'bouncy' : z <= 1.05 ? 'critically damped' : 'overdamped, slow'}`;
  snippet.textContent = snippetText();
  stageLines.innerHTML = p.map((v) => `<div class="stage-line" style="bottom:${v}%"><span>${v}%</span></div>`).join('');
  stageReadout.marks(p, T.dismissible);
  phoneReadout.marks(p, T.dismissible);
}

function syncInputs() {
  $$<HTMLInputElement>('[data-k]').forEach((i) => {
    const v = T[i.dataset.k as keyof Tune];
    if (i.type === 'checkbox') i.checked = Boolean(v);
    else i.value = String(v);
  });
}

$$<HTMLInputElement>('[data-k]').forEach((i) =>
  i.addEventListener('input', () => {
    const k = i.dataset.k as keyof Tune;
    T = { ...T, [k]: i.type === 'checkbox' ? i.checked : Number(i.value) };
    applyTune();
  }),
);
$('#copy-snippet').addEventListener('click', (e) => copy(snippetText(), e.currentTarget as HTMLElement));
$('#reset-tune').addEventListener('click', () => {
  T = { ...T0 };
  syncInputs();
  applyTune();
});
syncInputs();
applyTune();

/* ---------- examples ---------- */
$$<HTMLButtonElement>('[data-open]').forEach((b) => b.addEventListener('click', () => sheet(b.dataset.open!).show()));

// Snap points: log every sheet-snap.
const exSnap = sheet('ex-snap');
const snapPct = ['25%', '60%', '100%'];
exSnap.addEventListener('sheet-snap', (e) => {
  const d = (e as CustomEvent<SheetSnapDetail>).detail;
  $('#log-snap').textContent = `sheet-snap: index ${d.index}, ${Math.round(d.height)} px`;
  $('#snap-state').textContent = `detent ${d.index} · ${snapPct[d.index]}`;
  markChips(exSnap, d.index);
});
exSnap.addEventListener('sheet-open', () => markChips(exSnap, exSnap.index));

// Nested scroll: a long, real list.
const ELEMENTS: [string, string][] = [
  ['a', 'Hyperlink'], ['abbr', 'Abbreviation'], ['address', 'Contact information'], ['article', 'Self-contained composition'],
  ['aside', 'Tangential content'], ['audio', 'Sound content'], ['b', 'Bring attention to'], ['bdi', 'Bidirectional isolate'],
  ['blockquote', 'Extended quotation'], ['body', 'Document body'], ['br', 'Line break'], ['button', 'Clickable button'],
  ['canvas', 'Scriptable bitmap'], ['caption', 'Table caption'], ['cite', 'Title of a work'], ['code', 'Inline code'],
  ['col', 'Table column'], ['data', 'Machine-readable value'], ['datalist', 'Input suggestions'], ['dd', 'Description details'],
  ['del', 'Deleted text'], ['details', 'Disclosure widget'], ['dfn', 'Definition term'], ['dialog', 'Dialog box'],
  ['div', 'Generic container'], ['dl', 'Description list'], ['em', 'Stress emphasis'], ['fieldset', 'Group of form controls'],
  ['figcaption', 'Figure caption'], ['figure', 'Self-contained figure'], ['footer', 'Footer'], ['form', 'Form'],
  ['h1', 'Section heading'], ['header', 'Introductory content'], ['hr', 'Thematic break'], ['i', 'Idiomatic text'],
  ['iframe', 'Nested browsing context'], ['img', 'Image'], ['input', 'Form input'], ['ins', 'Inserted text'],
  ['kbd', 'Keyboard input'], ['label', 'Control label'], ['legend', 'Fieldset caption'], ['li', 'List item'],
  ['main', 'Main content'], ['mark', 'Highlighted text'], ['menu', 'List of commands'], ['meter', 'Scalar gauge'],
  ['nav', 'Navigation links'], ['ol', 'Ordered list'], ['optgroup', 'Option group'], ['option', 'Select option'],
  ['output', 'Calculation result'], ['p', 'Paragraph'], ['picture', 'Responsive image sources'], ['pre', 'Preformatted text'],
  ['progress', 'Task progress'], ['q', 'Inline quotation'], ['s', 'Strikethrough'], ['samp', 'Sample output'],
  ['search', 'Search controls'], ['section', 'Generic section'], ['select', 'Options picker'], ['slot', 'Shadow DOM slot'],
  ['small', 'Side comment'], ['source', 'Media source'], ['span', 'Generic inline container'], ['strong', 'Strong importance'],
  ['sub', 'Subscript'], ['summary', 'Disclosure summary'], ['sup', 'Superscript'], ['table', 'Table'],
  ['tbody', 'Table body'], ['td', 'Table cell'], ['template', 'Content template'], ['textarea', 'Multi-line text input'],
  ['tfoot', 'Table foot'], ['th', 'Table header cell'], ['thead', 'Table head'], ['time', 'Date or time'],
  ['tr', 'Table row'], ['track', 'Timed text track'], ['u', 'Unarticulated annotation'], ['ul', 'Unordered list'],
  ['var', 'Variable'], ['video', 'Video'], ['wbr', 'Line break opportunity'],
];
$('#el-list').innerHTML = ELEMENTS.map(([n, d]) => `<li><code>&lt;${n}&gt;</code><span>${d}</span></li>`).join('');
$('#el-count').textContent = `${ELEMENTS.length} rows`;

// Sticky header and footer: notification toggles.
const TOGGLES: [string, string, boolean][] = [
  ['Mentions', 'Someone mentions your name', true],
  ['Replies', 'Replies to your comments', true],
  ['Review requests', 'You are asked to review a change', true],
  ['Assigned issues', 'An issue is assigned to you', true],
  ['Failed builds', 'A build on your branch fails', true],
  ['Security alerts', 'A dependency has a known issue', true],
  ['Releases', 'A project you watch ships a release', false],
  ['Merged changes', 'Your pull request is merged', false],
  ['Discussions', 'New posts in threads you started', true],
  ['New followers', 'Someone follows you', false],
  ['Stars', 'Someone stars your repository', false],
  ['Weekly digest', 'One summary email on Monday', false],
  ['Product news', 'New features, at most monthly', false],
  ['Sign-in alerts', 'A new device signs in', true],
];
const toggles = $('#toggles');
toggles.innerHTML = TOGGLES.map(
  ([t, d, on], i) =>
    `<li><label><span>${t}<small>${d}</small></span><input type="checkbox" role="switch" data-t="${i}" ${on ? 'checked' : ''} /></label></li>`,
).join('');
const saved = TOGGLES.map((t) => t[2]);
const changes = () => $$<HTMLInputElement>('input', toggles).filter((i) => i.checked !== saved[Number(i.dataset.t)]).length;
const notifCount = $('#notif-count');
const updateCount = () => {
  const n = changes();
  notifCount.textContent = n ? `${n} change${n > 1 ? 's' : ''}` : 'No changes';
};
toggles.addEventListener('change', updateCount);
$('#notif-reset').addEventListener('click', () => {
  $$<HTMLInputElement>('input', toggles).forEach((i) => (i.checked = saved[Number(i.dataset.t)]));
  updateCount();
});
$('#notif-save').addEventListener('click', () => {
  const n = changes();
  $$<HTMLInputElement>('input', toggles).forEach((i) => (saved[Number(i.dataset.t)] = i.checked));
  updateCount();
  $('#log-sticky').textContent = n ? `Saved ${n} change${n > 1 ? 's' : ''}` : 'Saved, nothing changed';
  sheet('ex-sticky').close();
});

// Form with keyboard.
const form = $<HTMLFormElement>('#note-form');
const title = $<HTMLInputElement>('#note-title');
const body = $<HTMLTextAreaElement>('#note-body');
const err = $('#note-err');
const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
form.addEventListener('submit', (e) => {
  e.preventDefault();
  const t = title.value.trim();
  if (!t) {
    err.textContent = 'Give the note a title.';
    title.setAttribute('aria-invalid', 'true');
    title.focus();
    return;
  }
  const li = document.createElement('li');
  li.innerHTML = `<b>${esc(t)}</b>${body.value.trim() ? `<span>${esc(body.value.trim())}</span>` : ''}`;
  $('#notes').prepend(li);
  form.reset();
  err.textContent = '';
  title.removeAttribute('aria-invalid');
  sheet('ex-form').close();
});
title.addEventListener('input', () => {
  if (title.value.trim()) {
    err.textContent = '';
    title.removeAttribute('aria-invalid');
  }
});
$('#note-cancel').addEventListener('click', () => sheet('ex-form').close());

// Non-modal, map style. Grid units: 6 x 5 blocks; each block is 100 m.
const COLS = 6;
const ROWS = 5;
const YOU = { x: 1, y: 1 };
const STOPS = [
  { id: 'A', x: 3, y: 1 },
  { id: 'B', x: 5, y: 1 },
  { id: 'C', x: 2, y: 2 },
  { id: 'D', x: 4, y: 2 },
  { id: 'E', x: 1, y: 2 },
].map((s) => ({ ...s, blocks: Math.abs(s.x - YOU.x) + Math.abs(s.y - YOU.y) }));
const sorted = [...STOPS].sort((a, b) => a.blocks - b.blocks || a.id.localeCompare(b.id));
const W = 900;
const Hh = 600;
const px = (x: number) => (x / COLS) * W;
const py = (y: number) => (y / ROWS) * Hh;
const svg = $('#map-svg');
let blocks = '';
for (let c = 0; c < COLS; c++)
  for (let r = 0; r < ROWS; r++) {
    const park = c === 2 && r === 3;
    blocks += `<rect class="${park ? 'park' : 'blk'}" x="${px(c) + 14}" y="${py(r) + 14}" width="${W / COLS - 28}" height="${Hh / ROWS - 28}" rx="6" vector-effect="non-scaling-stroke"/>`;
  }
svg.innerHTML = `${blocks}<path class="route" id="route" d="" vector-effect="non-scaling-stroke"/>`;
const pins = $('#pins');
const pct = (x: number, n: number) => `${(x / n) * 100}%`;
pins.innerHTML =
  `<span class="pin you" style="left:${pct(YOU.x, COLS)};top:${pct(YOU.y, ROWS)}" aria-hidden="true"><i></i></span>` +
  STOPS.map((s) => `<button class="pin" type="button" data-stop="${s.id}" aria-pressed="false" aria-label="Stop ${s.id}" style="left:${pct(s.x, COLS)};top:${pct(s.y, ROWS)}"><i>${s.id}</i></button>`).join('');

const mapSheet = sheet('ex-map');
const walk = (b: number) => `${b} block${b === 1 ? '' : 's'} · ${b * 100} m · ${Math.ceil((b * 100) / 80)} min`;
mapSheet.innerHTML = `
  <div slot="header" class="sh-head"><h3 id="map-title">Tap a pin</h3><span class="mono small-text" id="map-dist">${STOPS.length} stops</span></div>
  <div class="map-sel"><p id="map-desc">Walking distance from the dot, along the streets. One block is 100 m.</p></div>
  <ul class="stops">${sorted.map((s) => `<li><button type="button" data-row="${s.id}"><span><b>${s.id}</b>Stop ${s.id}</span><span class="mono">${walk(s.blocks)}</span></button></li>`).join('')}</ul>`;

function selectStop(id: string) {
  const s = STOPS.find((t) => t.id === id)!;
  $$('[data-stop]').forEach((p) => p.setAttribute('aria-pressed', String(p.dataset.stop === id)));
  $$('[data-row]', mapSheet).forEach((r) => r.setAttribute('aria-current', String(r.dataset.row === id)));
  $('#map-title').textContent = `Stop ${id}`;
  $('#map-dist').textContent = walk(s.blocks);
  const leg = (n: number, dir: string) => (n ? `${n} block${n === 1 ? '' : 's'} ${dir}` : '');
  const legs = [leg(Math.abs(s.x - YOU.x), s.x >= YOU.x ? 'east' : 'west'), leg(Math.abs(s.y - YOU.y), s.y > YOU.y ? 'south' : 'north')].filter(Boolean);
  $('#map-desc').textContent = `Walk ${legs.join(', then ')}. The route is drawn on the map.`;
  $('#route').setAttribute('d', `M${px(YOU.x)} ${py(YOU.y)}H${px(s.x)}V${py(s.y)}`);
  if (mapSheet.index === 0) mapSheet.snapTo(1);
}
pins.addEventListener('click', (e) => {
  const b = (e.target as Element).closest<HTMLElement>('[data-stop]');
  if (b) selectStop(b.dataset.stop!);
});
mapSheet.addEventListener('click', (e) => {
  const b = (e.target as Element).closest<HTMLElement>('[data-row]');
  if (b) selectStop(b.dataset.row!);
});
