/* ------------------------------------------------------------------------------------------
 * MIT License
 * ------------------------------------------------------------------------------------------ */
// Data-flow webview: lays out and draws the schematic, and owns every
// interaction on it - pan and zoom, hover and click highlight of nets,
// bus grouping, search, context menu. The extension side only supplies the
// graph and performs navigation.

import ELK from 'elkjs/lib/elk.bundled.js';
import {
    buildSchematic,
    DataFlow,
    esc,
    Layout,
    Measure,
    Pin,
    readLayout,
    renderSvg,
    Schematic,
    SrcRange,
    toElk,
} from './schematic';

interface VsCodeApi {
    postMessage(msg: unknown): void;
    getState(): unknown;
    setState(state: unknown): void;
}
declare function acquireVsCodeApi(): VsCodeApi;

interface NavEntry {
    library: string;
    entity: string;
}

interface Options {
    processes: boolean;
    buses: boolean;
    minBus: number;
    /** Expanded bus group keys, per entity path. */
    ungrouped: Record<string, string[]>;
}

interface Selection {
    nets: Set<string>;
    label: string;
    color: number;
}

const COLORS = 6;
const MIN_SCALE = 0.03;
const MAX_SCALE = 8;

const vscode = acquireVsCodeApi();
const elk = new ELK();

const opts: Options = {
    processes: true,
    buses: true,
    minBus: 3,
    ungrouped: {},
    ...(vscode.getState() as Partial<Options> | undefined),
};

let df: DataFlow | null = null;
let stack: NavEntry[] = [];
let sch: Schematic | null = null;
let lay: Layout | null = null;
let layoutToken = 0;
let selections: Selection[] = [];
let nextColor = 0;
let hoverKey = '';

const $ = <T extends Element>(id: string): T => document.getElementById(id) as unknown as T;
const viewport = $<HTMLDivElement>('viewport');
const svg = $<SVGSVGElement>('canvas');
const tip = $<HTMLDivElement>('tip');
const menu = $<HTMLDivElement>('menu');
const status = $<HTMLDivElement>('status');
const chips = $<HTMLDivElement>('chips');
const search = $<HTMLInputElement>('search');

function saveOptions(): void {
    vscode.setState(opts);
}

function ungroupedSet(): Set<string> {
    return new Set(df ? opts.ungrouped[df.entity_path] ?? [] : []);
}

/**
 * @brief Expands (on) or collapses the given bus groups and lays out again.
 * The view follows anchor, the cell the change was made on.
 */
function setUngrouped(keys: string[], on: boolean, anchor?: string): void {
    if (!df) {
        return;
    }
    const s = ungroupedSet();
    for (const k of keys) {
        if (on) {
            s.add(k);
        } else {
            s.delete(k);
        }
    }
    opts.ungrouped[df.entity_path] = [...s];
    saveOptions();
    void relayout(true, anchor);
}

// ----------------------------------------------------------------------------
// Layout pipeline
// ----------------------------------------------------------------------------

const measureCtx = document.createElement('canvas').getContext('2d') as CanvasRenderingContext2D;
const fontFamily = getComputedStyle(document.body).getPropertyValue('--vscode-editor-font-family') || 'monospace';
const measure: Measure = (text, bold) => {
    measureCtx.font = (bold ? 'bold ' : '') + '11px ' + fontFamily;
    return measureCtx.measureText(text).width;
};

function showStatus(text: string): void {
    status.textContent = text;
    status.hidden = text === '';
}

/** Id of the cell whose center is nearest to the viewport center. */
function centralCell(): string | undefined {
    if (!lay) {
        return undefined;
    }
    const cx = view.x + viewport.clientWidth / 2 / view.s;
    const cy = view.y + viewport.clientHeight / 2 / view.s;
    let best: string | undefined;
    let dist = Infinity;
    for (const [id, c] of lay.cells) {
        const d = Math.hypot(c.x + c.width / 2 - cx, c.y + c.height / 2 - cy);
        if (d < dist) {
            dist = d;
            best = id;
        }
    }
    return best;
}

/**
 * @brief Rebuilds model, layout and SVG from the current graph and options.
 * A newer call supersedes a layout still in flight. keepView holds the zoom
 * and keeps the anchor cell (default: the most central one) at its screen
 * position; otherwise the view fits the drawing.
 */
async function relayout(keepView: boolean, anchor?: string): Promise<void> {
    if (!df) {
        return;
    }
    const token = ++layoutToken;
    const pinned = keepView ? anchor ?? centralCell() : undefined;
    const before = pinned !== undefined ? lay?.cells.get(pinned) : undefined;
    let model: Schematic;
    let laid: Layout;
    try {
        model = buildSchematic(df, {
            processes: opts.processes,
            buses: opts.buses,
            minBus: opts.minBus,
            ungrouped: ungroupedSet(),
        });
        showStatus('laying out ' + model.cells.length + ' cells, ' + model.wires.length + ' wires...');
        await new Promise((r) => requestAnimationFrame(r));
        laid = readLayout(await elk.layout(toElk(model, measure)));
    } catch (err) {
        showStatus('schematic failed: ' + (err instanceof Error ? err.stack ?? err.message : String(err)));
        return;
    }
    if (token !== layoutToken) {
        return;
    }

    sch = model;
    lay = laid;
    svg.innerHTML = renderSvg(model, laid);
    hoverKey = '';
    for (const s of selections) {
        s.nets = new Set([...s.nets].filter((n) => model.nets.has(n)));
    }
    selections = selections.filter((s) => s.nets.size > 0);
    paintSelection();
    showStatus('');
    const after = pinned !== undefined ? laid.cells.get(pinned) : undefined;
    if (!keepView) {
        fitTo(null);
    } else if (before && after) {
        view.x += after.x - before.x;
        view.y += after.y - before.y;
        applyView();
    }
}

// ----------------------------------------------------------------------------
// Pan and zoom
// ----------------------------------------------------------------------------

/** World coordinate at the viewport's top-left corner, and screen pixels per world unit. */
const view = { x: 0, y: 0, s: 1 };

function applyView(): void {
    const w = viewport.clientWidth / view.s;
    const h = viewport.clientHeight / view.s;
    svg.setAttribute('viewBox', view.x + ' ' + view.y + ' ' + w + ' ' + h);
    svg.style.setProperty('--inv', String(1 / view.s));
    svg.classList.toggle('lod-far', view.s < 0.45);
    svg.classList.toggle('lod-very-far', view.s < 0.22);
    $<HTMLSpanElement>('zoom').textContent = Math.round(view.s * 100) + '%';
}

function zoomAt(factor: number, sx: number, sy: number): void {
    const s = Math.max(MIN_SCALE, Math.min(MAX_SCALE, view.s * factor));
    const wx = view.x + sx / view.s;
    const wy = view.y + sy / view.s;
    view.s = s;
    view.x = wx - sx / s;
    view.y = wy - sy / s;
    applyView();
}

/**
 * @brief Fits the view to box, or to the whole drawing when box is null.
 * Never zooms in past 100% for the whole drawing.
 */
function fitTo(box: DOMRect | null): void {
    if (!lay) {
        return;
    }
    const b = box ?? new DOMRect(0, 0, lay.width, lay.height);
    const pad = box ? 60 : 12;
    const vw = viewport.clientWidth;
    const vh = viewport.clientHeight;
    let s = Math.min((vw - 2 * pad) / Math.max(b.width, 1), (vh - 2 * pad) / Math.max(b.height, 1));
    s = Math.max(MIN_SCALE, Math.min(box ? 2 : 1, s));
    view.s = s;
    view.x = b.x + b.width / 2 - vw / 2 / s;
    view.y = b.y + b.height / 2 - vh / 2 / s;
    applyView();
}

viewport.addEventListener(
    'wheel',
    (ev) => {
        ev.preventDefault();
        const r = viewport.getBoundingClientRect();
        if (ev.ctrlKey || !ev.shiftKey) {
            zoomAt(Math.pow(1.0018, -ev.deltaY), ev.clientX - r.left, ev.clientY - r.top);
        } else {
            view.x += ev.deltaY / view.s;
            applyView();
        }
    },
    { passive: false }
);

let drag: { x: number; y: number; vx: number; vy: number; moved: boolean } | null = null;
let suppressClick = false;

viewport.addEventListener('pointerdown', (ev) => {
    if (ev.button !== 0 && ev.button !== 1) {
        return;
    }
    hideMenu();
    drag = { x: ev.clientX, y: ev.clientY, vx: view.x, vy: view.y, moved: false };
});

viewport.addEventListener('pointermove', (ev) => {
    if (drag) {
        const dx = ev.clientX - drag.x;
        const dy = ev.clientY - drag.y;
        if (!drag.moved && Math.hypot(dx, dy) > 4) {
            drag.moved = true;
            // Capture only once panning: a captured pointer retargets click and dblclick to the viewport.
            viewport.setPointerCapture(ev.pointerId);
            viewport.classList.add('panning');
            hideTip();
        }
        if (drag.moved) {
            view.x = drag.vx - dx / view.s;
            view.y = drag.vy - dy / view.s;
            applyView();
            return;
        }
    }
    onHover(ev);
});

viewport.addEventListener('pointerup', () => {
    suppressClick = drag?.moved ?? false;
    drag = null;
    viewport.classList.remove('panning');
});

viewport.addEventListener('pointerleave', () => {
    setHover(null, '');
    hideTip();
});

new ResizeObserver(() => applyView()).observe(viewport);

// ----------------------------------------------------------------------------
// Hit targets
// ----------------------------------------------------------------------------

type Target =
    | { kind: 'pin'; pin: Pin }
    | { kind: 'wire'; id: string }
    | { kind: 'cell'; id: string }
    | { kind: 'drill'; id: string }
    | { kind: 'none' };

function targetOf(el: EventTarget | null): Target {
    if (!(el instanceof Element) || !sch) {
        return { kind: 'none' };
    }
    const d = el.closest('[data-drill]');
    if (d) {
        return { kind: 'drill', id: d.getAttribute('data-drill') as string };
    }
    const p = el.closest('[data-p]');
    const pin = p ? sch.pins.get(p.getAttribute('data-p') as string) : undefined;
    if (pin) {
        return { kind: 'pin', pin };
    }
    const w = el.closest('[data-w]');
    if (w) {
        return { kind: 'wire', id: w.getAttribute('data-w') as string };
    }
    const c = el.closest('[data-c]');
    if (c) {
        return { kind: 'cell', id: c.getAttribute('data-c') as string };
    }
    return { kind: 'none' };
}

function netName(key: string): string {
    return sch?.nets.get(key)?.name ?? key;
}

function cellNets(id: string): string[] {
    const c = sch?.cells.find((x) => x.id === id);
    return c ? [...new Set(c.pins.flatMap((p) => p.nets))] : [];
}

function netsOf(t: Target): string[] {
    if (!sch) {
        return [];
    }
    switch (t.kind) {
        case 'pin':
            return t.pin.nets;
        case 'wire':
            return sch.wires.find((w) => w.id === t.id)?.nets ?? [];
        case 'cell':
        case 'drill':
            return cellNets(t.id);
        default:
            return [];
    }
}

function labelOf(t: Target): string {
    if (!sch) {
        return '';
    }
    const ns = netsOf(t);
    switch (t.kind) {
        case 'pin':
            return t.pin.bus ? t.pin.label : ns.length === 1 ? netName(ns[0]) : t.pin.label;
        case 'wire':
            return ns.length === 1 ? netName(ns[0]) : ns.length + ' nets';
        case 'cell':
        case 'drill':
            return sch.cells.find((c) => c.id === t.id)?.title ?? '';
        default:
            return '';
    }
}

// ----------------------------------------------------------------------------
// Highlight
// ----------------------------------------------------------------------------

function wirePaths(nets: Iterable<string>, cls: string): string {
    if (!sch || !lay) {
        return '';
    }
    const ids = new Set<string>();
    for (const n of nets) {
        (sch.netWires.get(n) ?? []).forEach((w) => ids.add(w));
    }
    let out = '';
    for (const id of ids) {
        const g = lay.wires.get(id);
        const w = sch.wires.find((x) => x.id === id);
        if (g && w) {
            out += '<path class="' + cls + (w.nets.length > 1 ? ' bus' : '') + '" d="' + g.d + '"/>';
        }
    }
    return out;
}

function pinsOf(nets: Iterable<string>): Set<string> {
    const out = new Set<string>();
    for (const n of nets) {
        (sch?.netPins.get(n) ?? []).forEach((p) => out.add(p));
    }
    return out;
}

function markPins(ids: Set<string>, cls: string): void {
    svg.querySelectorAll('.' + cls).forEach((e) => e.classList.remove(cls));
    for (const id of ids) {
        svg.querySelector('[data-p="' + CSS.escape(id) + '"]')?.classList.add(cls);
    }
}

function setHover(nets: string[] | null, key: string): void {
    if (key === hoverKey) {
        return;
    }
    hoverKey = key;
    const hov = svg.querySelector('#hov');
    if (!hov) {
        return;
    }
    hov.innerHTML = nets ? wirePaths(nets, 'hl') : '';
    markPins(nets ? pinsOf(nets) : new Set(), 'pin-hov');
}

function paintSelection(): void {
    const sel = svg.querySelector('#sel');
    if (!sel || !sch) {
        return;
    }
    sel.innerHTML = selections.map((s) => wirePaths(s.nets, 'sl c' + s.color)).join('');
    svg.querySelectorAll('[class*="pin-sel"]').forEach((e) => {
        e.classList.forEach((c) => c.startsWith('pin-sel') && e.classList.remove(c));
    });
    const touched = new Set<string>();
    for (const s of selections) {
        for (const id of pinsOf(s.nets)) {
            const el = svg.querySelector('[data-p="' + CSS.escape(id) + '"]');
            el?.classList.add('pin-sel', 'pin-sel-c' + s.color);
            const cell = sch.pins.get(id)?.cell;
            if (cell) {
                touched.add(cell);
            }
        }
    }
    svg.querySelectorAll('.cell').forEach((e) => {
        e.classList.toggle('touched', touched.has(e.getAttribute('data-c') ?? ''));
    });
    svg.classList.toggle('has-sel', selections.length > 0);
    renderChips();
}

function select(nets: string[], label: string, add: boolean): void {
    if (nets.length === 0) {
        return;
    }
    const key = [...nets].sort().join('\n');
    const same = selections.findIndex((s) => [...s.nets].sort().join('\n') === key);
    if (add) {
        if (same >= 0) {
            selections.splice(same, 1);
        } else {
            selections.push({ nets: new Set(nets), label, color: nextColor++ % COLORS });
        }
    } else {
        selections = same >= 0 && selections.length === 1 ? [] : [{ nets: new Set(nets), label, color: nextColor++ % COLORS }];
    }
    paintSelection();
}

function clearSelection(): void {
    selections = [];
    paintSelection();
}

function selectionBox(s: Selection): DOMRect | null {
    const els = svg.querySelectorAll<SVGGraphicsElement>('#sel .c' + s.color);
    let box: DOMRect | null = null;
    els.forEach((e) => {
        const b = e.getBBox();
        box = box
            ? new DOMRect(
                  Math.min(box.x, b.x),
                  Math.min(box.y, b.y),
                  Math.max(box.right, b.x + b.width) - Math.min(box.x, b.x),
                  Math.max(box.bottom, b.y + b.height) - Math.min(box.y, b.y)
              )
            : new DOMRect(b.x, b.y, b.width, b.height);
    });
    return box;
}

function renderChips(): void {
    chips.innerHTML = selections
        .map(
            (s, i) =>
                '<span class="chip" data-i="' + i + '" title="Click: zoom to selection">' +
                '<i class="sw c' + s.color + '"></i>' + esc(s.label) +
                (s.nets.size > 1 ? ' <em>' + s.nets.size + ' nets</em>' : '') +
                '<b data-x="' + i + '" title="Remove">x</b></span>'
        )
        .join('');
    chips.hidden = selections.length === 0;
}

chips.addEventListener('click', (ev) => {
    const el = ev.target as Element;
    const x = el.closest('[data-x]');
    if (x) {
        selections.splice(Number(x.getAttribute('data-x')), 1);
        paintSelection();
        return;
    }
    const chip = el.closest('[data-i]');
    const s = chip ? selections[Number(chip.getAttribute('data-i'))] : undefined;
    const box = s ? selectionBox(s) : null;
    if (box) {
        fitTo(box);
    }
});

// ----------------------------------------------------------------------------
// Tooltip
// ----------------------------------------------------------------------------

let tipTimer = 0;

function hideTip(): void {
    window.clearTimeout(tipTimer);
    tip.hidden = true;
}

function netLine(key: string): string {
    const n = sch?.nets.get(key);
    let s = esc(netName(key));
    if (n?.clock_domain) {
        s += ' <em>@' + esc(n.clock_domain) + '</em>';
    }
    if (n?.is_cdc) {
        s += ' <strong class="warn">CDC</strong>';
    }
    return s;
}

function netList(nets: string[]): string {
    const shown = nets.slice(0, 12).map(netLine);
    if (nets.length > 12) {
        shown.push('<em>+' + (nets.length - 12) + ' more</em>');
    }
    return shown.join('<br>');
}

function pinName(id: string): string {
    const p = sch?.pins.get(id);
    const c = sch?.cells.find((x) => x.id === p?.cell);
    if (!p || !c) {
        return id;
    }
    return c.kind === 'input' || c.kind === 'output' ? esc(p.label) : esc(c.title) + '.' + esc(p.label);
}

function tipHtml(t: Target): string {
    if (!sch) {
        return '';
    }
    switch (t.kind) {
        case 'pin': {
            const p = t.pin;
            const head = '<b>' + esc(p.label) + '</b> ' + (p.side === 'W' ? 'in' : 'out') + (p.type ? ' : ' + esc(p.type) : '');
            const members = p.bus ? '<div class="members">' + p.members.map(esc).join(' ') + '</div>' : '';
            const nc = p.dangling ? '<div class="dim">no other endpoint of this net is modelled here</div>' : '';
            return head + members + (p.nets.length ? '<hr>' + netList(p.nets) : '<div class="dim">unconnected</div>') + nc;
        }
        case 'wire': {
            const w = sch.wires.find((x) => x.id === t.id);
            return w ? '<b>' + pinName(w.src) + '</b> &gt; <b>' + pinName(w.dst) + '</b><hr>' + netList(w.nets) : '';
        }
        case 'cell':
        case 'drill': {
            const c = sch.cells.find((x) => x.id === t.id);
            if (!c) {
                return '';
            }
            const hint = t.kind === 'drill' ? 'click: open data flow of ' + esc(c.drill ?? '') : 'double-click: go to source';
            return '<b>' + esc(c.title) + '</b> ' + esc(c.subtitle) + '<div class="dim">' + hint + '</div>';
        }
        default:
            return '';
    }
}

function targetKey(t: Target): string {
    switch (t.kind) {
        case 'pin':
            return 'p' + t.pin.id;
        case 'wire':
        case 'cell':
        case 'drill':
            return t.kind[0] + t.id;
        default:
            return '';
    }
}

function onHover(ev: PointerEvent): void {
    if (!menu.hidden) {
        return;
    }
    const t = targetOf(ev.target);
    const key = targetKey(t);
    if (key !== hoverKey) {
        setHover(t.kind === 'none' ? null : netsOf(t), key);
        hideTip();
        if (t.kind !== 'none') {
            tipTimer = window.setTimeout(() => {
                tip.innerHTML = tipHtml(t);
                tip.hidden = false;
                placeFloating(tip, ev.clientX + 14, ev.clientY + 16);
            }, 350);
        }
    }
}

function placeFloating(el: HTMLElement, x: number, y: number): void {
    const r = el.getBoundingClientRect();
    el.style.left = Math.max(4, Math.min(x, window.innerWidth - r.width - 8)) + 'px';
    el.style.top = Math.max(4, y + r.height > window.innerHeight - 8 ? y - r.height - 24 : y) + 'px';
}

// ----------------------------------------------------------------------------
// Click, double-click, context menu
// ----------------------------------------------------------------------------

function navigate(pos: SrcRange | null | undefined): void {
    if (pos) {
        vscode.postMessage({ type: 'navigate', pos });
    }
}

function drill(cellId: string): void {
    const c = sch?.cells.find((x) => x.id === cellId);
    const path = c?.drill;
    if (!path) {
        return;
    }
    const dot = path.indexOf('.');
    vscode.postMessage({ type: 'drill', library: path.slice(0, dot), entity: path.slice(dot + 1) });
}

viewport.addEventListener('click', (ev) => {
    if (suppressClick) {
        suppressClick = false;
        return;
    }
    // The second click of a double-click belongs to the dblclick handler.
    if (ev.detail > 1) {
        return;
    }
    const t = targetOf(ev.target);
    if (t.kind === 'drill') {
        drill(t.id);
        return;
    }
    if (t.kind === 'none') {
        if (!(ev.ctrlKey || ev.metaKey || ev.shiftKey)) {
            clearSelection();
        }
        return;
    }
    select(netsOf(t), labelOf(t), ev.ctrlKey || ev.metaKey || ev.shiftKey);
});

viewport.addEventListener('dblclick', (ev) => {
    const t = targetOf(ev.target);
    if (t.kind === 'pin') {
        if (t.pin.bus && t.pin.group) {
            setUngrouped([t.pin.group], true, t.pin.cell);
        } else {
            navigate(t.pin.assoc ?? t.pin.decl);
        }
    } else if (t.kind === 'cell') {
        navigate(sch?.cells.find((c) => c.id === t.id)?.pos);
    }
});

interface MenuItem {
    label: string;
    run: () => void;
}

function hideMenu(): void {
    menu.hidden = true;
}

function menuItems(t: Target): MenuItem[] {
    if (!sch) {
        return [];
    }
    const items: MenuItem[] = [];
    const nets = netsOf(t);
    if (nets.length > 0) {
        items.push({ label: 'Highlight ' + (nets.length > 1 ? nets.length + ' nets' : netName(nets[0])), run: () => select(nets, labelOf(t), true) });
    }
    if (t.kind === 'pin') {
        const p = t.pin;
        if (p.assoc) {
            items.push({ label: 'Go to port map association', run: () => navigate(p.assoc) });
        }
        if (p.decl) {
            items.push({ label: 'Go to port declaration', run: () => navigate(p.decl) });
        }
        if (p.group && p.bus) {
            items.push({ label: 'Expand bus ' + p.label, run: () => setUngrouped([p.group as string], true, p.cell) });
        } else if (p.group) {
            items.push({ label: 'Collapse into bus', run: () => setUngrouped([p.group as string], false, p.cell) });
        }
    }
    if (t.kind === 'cell' || t.kind === 'drill') {
        const c = sch.cells.find((x) => x.id === t.id);
        if (c?.pos) {
            items.push({ label: c.kind === 'instance' ? 'Go to instantiation' : 'Go to source', run: () => navigate(c.pos) });
        }
        if (c?.entityPos) {
            items.push({ label: 'Go to entity declaration', run: () => navigate(c.entityPos) });
        }
        if (c?.drill) {
            items.push({ label: 'Open data flow of ' + c.drill, run: () => drill(c.id) });
        }
        const groups = [...new Set(c?.pins.filter((p) => p.group).map((p) => p.group as string))];
        if (groups.some((g) => !ungroupedSet().has(g))) {
            items.push({ label: 'Expand all buses of this cell', run: () => setUngrouped(groups, true, t.id) });
        }
        if (groups.some((g) => ungroupedSet().has(g))) {
            items.push({ label: 'Collapse all buses of this cell', run: () => setUngrouped(groups, false, t.id) });
        }
    }
    if (t.kind === 'none') {
        items.push({ label: 'Fit to view', run: () => fitTo(null) });
        if (selections.length > 0) {
            items.push({ label: 'Clear highlights', run: clearSelection });
        }
        if (ungroupedSet().size > 0) {
            items.push({
                label: 'Collapse all expanded buses',
                run: () => setUngrouped([...ungroupedSet()], false),
            });
        }
    }
    return items;
}

viewport.addEventListener('contextmenu', (ev) => {
    ev.preventDefault();
    hideTip();
    const items = menuItems(targetOf(ev.target));
    if (items.length === 0) {
        return;
    }
    menu.innerHTML = items.map((it, i) => '<div class="mi" data-mi="' + i + '">' + esc(it.label) + '</div>').join('');
    menu.hidden = false;
    placeFloating(menu, ev.clientX, ev.clientY);
    menu.onclick = (e) => {
        const mi = (e.target as Element).closest('[data-mi]');
        hideMenu();
        if (mi) {
            items[Number(mi.getAttribute('data-mi'))].run();
        }
    };
});

window.addEventListener('blur', hideMenu);

// ----------------------------------------------------------------------------
// Header: breadcrumb, search, options
// ----------------------------------------------------------------------------

function renderCrumbs(): void {
    const crumbs = $<HTMLElement>('crumbs');
    crumbs.innerHTML = stack
        .map(
            (e, i) =>
                (i > 0 ? '<span class="sep">/</span>' : '') +
                '<span class="crumb' + (i === stack.length - 1 ? ' current' : '') + '" data-i="' + i + '" title="' +
                esc(e.library + '.' + e.entity) + '">' + esc(e.entity) + '</span>'
        )
        .join('');
    $<HTMLButtonElement>('up').disabled = stack.length < 2;
}

$<HTMLElement>('crumbs').addEventListener('click', (ev) => {
    const c = (ev.target as Element).closest('[data-i]');
    if (!c) {
        return;
    }
    const i = Number(c.getAttribute('data-i'));
    if (i === stack.length - 1) {
        navigate(df?.entity_pos);
    } else {
        vscode.postMessage({ type: 'jump', index: i });
    }
});

$<HTMLButtonElement>('up').addEventListener('click', () => vscode.postMessage({ type: 'back' }));
$<HTMLButtonElement>('reload').addEventListener('click', () => vscode.postMessage({ type: 'reload' }));
$<HTMLButtonElement>('fit').addEventListener('click', () => fitTo(null));

const procsBox = $<HTMLInputElement>('procs');
const busesBox = $<HTMLInputElement>('buses');
const minBusBox = $<HTMLInputElement>('minbus');
procsBox.checked = opts.processes;
busesBox.checked = opts.buses;
minBusBox.value = String(opts.minBus);
minBusBox.disabled = !opts.buses;

procsBox.addEventListener('change', () => {
    opts.processes = procsBox.checked;
    saveOptions();
    void relayout(true);
});
busesBox.addEventListener('change', () => {
    opts.buses = busesBox.checked;
    minBusBox.disabled = !opts.buses;
    saveOptions();
    void relayout(true);
});
minBusBox.addEventListener('change', () => {
    opts.minBus = Math.max(2, Math.min(16, Number(minBusBox.value) || 3));
    minBusBox.value = String(opts.minBus);
    saveOptions();
    void relayout(true);
});

function searchMatches(q: string): string[] {
    if (!sch || q === '') {
        return [];
    }
    const low = q.toLowerCase();
    const nets = [...sch.nets].filter(([k, n]) => n.name.toLowerCase().includes(low) && sch?.netPins.has(k)).map(([k]) => k);
    for (const c of sch.cells) {
        if (c.title.toLowerCase().includes(low)) {
            nets.push(...c.pins.flatMap((p) => p.nets));
        }
    }
    return [...new Set(nets)];
}

search.addEventListener('input', () => {
    const m = searchMatches(search.value.trim());
    setHover(m.length ? m : null, 'search:' + search.value);
    search.classList.toggle('nomatch', search.value.trim() !== '' && m.length === 0);
});

search.addEventListener('keydown', (ev) => {
    if (ev.key === 'Enter') {
        const q = search.value.trim();
        const m = searchMatches(q);
        if (m.length > 0) {
            select(m, q, ev.shiftKey || ev.ctrlKey);
            setHover(null, '');
            const box = selectionBox(selections[selections.length - 1]);
            if (box) {
                fitTo(box);
            }
        }
    } else if (ev.key === 'Escape') {
        search.value = '';
        setHover(null, '');
        search.blur();
    }
});

window.addEventListener('keydown', (ev) => {
    if (ev.target === search) {
        return;
    }
    if (ev.key === 'Escape') {
        hideMenu();
        clearSelection();
    } else if (ev.key === '/' || (ev.key === 'f' && (ev.ctrlKey || ev.metaKey))) {
        ev.preventDefault();
        search.focus();
        search.select();
    } else if (ev.key === 'f' || ev.key === '0') {
        fitTo(null);
    } else if (ev.key === '+' || ev.key === '=') {
        zoomAt(1.25, viewport.clientWidth / 2, viewport.clientHeight / 2);
    } else if (ev.key === '-') {
        zoomAt(0.8, viewport.clientWidth / 2, viewport.clientHeight / 2);
    } else if (ev.key === 'Backspace' || (ev.key === 'ArrowUp' && ev.altKey)) {
        vscode.postMessage({ type: 'back' });
    }
});

// ----------------------------------------------------------------------------
// Extension messages
// ----------------------------------------------------------------------------

window.addEventListener('message', (ev: MessageEvent) => {
    const msg = ev.data as { type: string; df?: DataFlow; stack?: NavEntry[]; message?: string };
    if (msg.type === 'graph' && !Array.isArray(msg.df?.nets)) {
        showStatus('language server returned no data-flow graph (outdated vhdl_ls binary?)');
    } else if (msg.type === 'graph' && msg.df && msg.stack) {
        const same = df?.entity_path === msg.df.entity_path;
        df = msg.df;
        stack = msg.stack;
        if (!same) {
            selections = [];
        }
        renderCrumbs();
        void relayout(same);
    } else if (msg.type === 'loading') {
        showStatus('loading ' + (msg.message ?? '') + '...');
    } else if (msg.type === 'error') {
        showStatus(msg.message ?? 'error');
    }
});

vscode.postMessage({ type: 'ready' });
