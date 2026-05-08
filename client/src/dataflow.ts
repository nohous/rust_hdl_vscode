/* ------------------------------------------------------------------------------------------
 * MIT License
 * ------------------------------------------------------------------------------------------ */
'use strict';
import {
    OutputChannel,
    Position,
    Range,
    Uri,
    ViewColumn,
    WebviewPanel,
    window,
    workspace,
} from 'vscode';
import { LanguageClient } from 'vscode-languageclient/node';

// netlistsvg is a Node-side renderer. We invoke it in the extension
// process (not in the webview) so we don't have to bundle ELK as
// browser code; the resulting SVG is plain markup the webview can
// just inject.
// eslint-disable-next-line @typescript-eslint/no-var-requires
const netlistsvg: {
    render: (
        skin: string,
        netlist: unknown,
        done: (err: unknown, svg: string) => void
    ) => void;
} = require('netlistsvg');

// Webpack rule (`type: 'asset/source'`) inlines the skin XML as a
// string. Avoids shipping node_modules.
// eslint-disable-next-line @typescript-eslint/no-var-requires
const defaultSkin: string = require('netlistsvg/lib/default.svg');

export const DATA_FLOW_REQUEST = 'vhdl/dataFlow';

export interface DataFlowParams {
    library: string;
    entity: string;
}

/// The yosys payload comes back as an arbitrary JSON object. We don't
/// fully type it on the client - we hand it to netlistsvg and mine a
/// few `vhdl_*_pos` fields out for click navigation.
export type YosysPayload = {
    modules?: Record<string, ModuleData>;
};

interface ModuleData {
    cells?: Record<string, CellData>;
    vhdl_entity_pos?: VhdlPos;
}

interface CellData {
    type?: string;
    vhdl_instance_pos?: VhdlPos;
    vhdl_entity_pos?: VhdlPos;
}

interface VhdlPos {
    file: string;
    start: { line: number; character: number };
    end: { line: number; character: number };
}

interface NavigateMessage {
    type: 'navigate';
    pos: VhdlPos;
}

interface DrillMessage {
    type: 'drill';
    library: string;
    entity: string;
}

interface BackMessage {
    type: 'back';
}

interface JumpMessage {
    type: 'jump';
    /// Truncate the nav stack so this index becomes the new top.
    index: number;
}

interface ReloadMessage {
    type: 'reload';
}

interface SetGranularityMessage {
    type: 'granularity';
    value: Granularity;
}

type IncomingMessage =
    | NavigateMessage
    | DrillMessage
    | BackMessage
    | JumpMessage
    | ReloadMessage
    | SetGranularityMessage;

interface NavEntry {
    library: string;
    entity: string;
}

/// View granularity. `all` = current behavior (instances + processes).
/// `modulesOnly` hides process cells and any nets that lose all
/// endpoints once processes are gone.
type Granularity = 'all' | 'modulesOnly';

/// Keyed by the *initial* entity (the bottom of the nav stack). Same
/// starting point reuses an existing panel; different starting point
/// opens a new one. Drilling never opens a new panel - it pushes onto
/// the active panel's stack.
const panels = new Map<string, DataFlowPanel>();

/// Filter the yosys payload according to the requested granularity.
/// `modulesOnly` removes process cells. The cell's connection bits
/// disappear with it; netnames keep their bit list (unaffected) so
/// nets still render with their non-process endpoints.
function applyGranularity(
    payload: YosysPayload,
    granularity: Granularity
): YosysPayload {
    if (granularity === 'all') {
        return payload;
    }
    // Deep-clone via JSON to avoid mutating the cached lastPayload.
    const out: YosysPayload = JSON.parse(JSON.stringify(payload));
    for (const m of Object.values(out.modules ?? {})) {
        if (!m.cells) continue;
        const filtered: Record<string, CellData> = {};
        for (const [name, cell] of Object.entries(m.cells)) {
            const t = typeof cell.type === 'string' ? cell.type : '';
            const sep = t.indexOf(' : ');
            const kind = sep < 0 ? t : t.slice(sep + 3);
            if (!kind.startsWith('process')) {
                filtered[name] = cell;
            }
        }
        m.cells = filtered;
    }
    return out;
}

export class DataFlowPanel {
    private readonly panel: WebviewPanel;
    private readonly initialKey: string;
    /// Navigation history. First entry is what the panel was opened
    /// for; pushing happens on drill, popping on back / breadcrumb.
    private stack: NavEntry[];
    /// Persists across navigation - users typically pick a granularity
    /// once and want it to stick.
    private granularity: Granularity = 'all';
    /// Last fetched payload, kept so granularity toggles can re-render
    /// without going back to the LSP.
    private lastPayload: YosysPayload | undefined;

    constructor(
        library: string,
        entity: string,
        private readonly getClient: () => LanguageClient,
        private readonly log: OutputChannel
    ) {
        this.stack = [{ library, entity }];
        this.initialKey = `${library}.${entity}`;
        this.panel = window.createWebviewPanel(
            'vhdlDataflow',
            this.panelTitle(),
            ViewColumn.Active,
            {
                enableScripts: true,
                retainContextWhenHidden: true,
            }
        );
        this.panel.onDidDispose(() => {
            panels.delete(this.initialKey);
        });
        this.panel.webview.onDidReceiveMessage((msg: IncomingMessage) => {
            this.handleMessage(msg).catch((err) => {
                this.log.appendLine(`dataflow webview message error: ${err}`);
            });
        });
        this.panel.webview.html = this.placeholderHtml(
            `Loading data-flow for ${this.currentKey()}...`
        );
        void this.refresh();
    }

    static showOrCreate(
        library: string,
        entity: string,
        getClient: () => LanguageClient,
        log: OutputChannel
    ): DataFlowPanel {
        const key = `${library}.${entity}`;
        const existing = panels.get(key);
        if (existing) {
            existing.panel.reveal(ViewColumn.Active);
            // Reset the nav stack to the requested entity so a
            // re-invocation of "Show Data Flow" feels like a fresh
            // start, not a continuation of wherever the panel
            // happened to have been left.
            existing.stack = [{ library, entity }];
            existing.panel.title = existing.panelTitle();
            void existing.refresh();
            return existing;
        }
        const panel = new DataFlowPanel(library, entity, getClient, log);
        panels.set(key, panel);
        return panel;
    }

    private current(): NavEntry {
        return this.stack[this.stack.length - 1];
    }

    private currentKey(): string {
        const c = this.current();
        return `${c.library}.${c.entity}`;
    }

    private panelTitle(): string {
        if (this.stack.length === 1) {
            return `Data flow: ${this.currentKey()}`;
        }
        return `Data flow: ${this.stack[0].library}.${this.stack[0].entity} > ${this.current().entity}`;
    }

    async refresh(): Promise<void> {
        const c = this.current();
        try {
            const payload = await this.getClient().sendRequest<YosysPayload>(
                DATA_FLOW_REQUEST,
                { library: c.library, entity: c.entity }
            );
            this.lastPayload = payload;
            await this.rerender();
            return;
        } catch (err) {
            const detail =
                typeof err === 'object' &&
                err !== null &&
                'message' in err &&
                typeof (err as { message?: unknown }).message === 'string'
                    ? (err as { message: string }).message
                    : String(err);
            this.log.appendLine(`Data-flow request failed: ${detail}`);
            this.panel.webview.html = this.placeholderHtml(
                `Failed to load data-flow for ${this.currentKey()}:\n${detail}`
            );
        }
    }

    /// Re-render from the last fetched payload. Cheap: no LSP request,
    /// just re-runs the granularity filter and netlistsvg pass.
    private async rerender(): Promise<void> {
        if (!this.lastPayload) {
            return;
        }
        const filtered = applyGranularity(this.lastPayload, this.granularity);
        const svg = await this.renderSvg(filtered);
        this.panel.title = this.panelTitle();
        this.panel.webview.html = this.renderHtml(filtered, svg);
    }

    private renderSvg(payload: YosysPayload): Promise<string> {
        return new Promise((resolve, reject) => {
            try {
                netlistsvg.render(
                    defaultSkin,
                    payload,
                    (err: unknown, svg: string) => {
                        if (err) {
                            reject(err);
                        } else {
                            resolve(svg);
                        }
                    }
                );
            } catch (err) {
                reject(err);
            }
        });
    }

    private async handleMessage(msg: IncomingMessage): Promise<void> {
        if (msg.type === 'reload') {
            await this.refresh();
            return;
        }
        if (msg.type === 'navigate') {
            const uri = Uri.file(msg.pos.file);
            const range = new Range(
                new Position(msg.pos.start.line, msg.pos.start.character),
                new Position(msg.pos.end.line, msg.pos.end.character)
            );
            const doc = await workspace.openTextDocument(uri);
            await window.showTextDocument(doc, {
                viewColumn: ViewColumn.Beside,
                selection: range,
                preserveFocus: false,
            });
            return;
        }
        if (msg.type === 'drill') {
            // Drill in-place: push onto this panel's nav stack instead
            // of opening a new panel. Keeps the navigation linear and
            // back-traversable, the way schematic explorers usually
            // behave.
            this.stack.push({ library: msg.library, entity: msg.entity });
            await this.refresh();
            return;
        }
        if (msg.type === 'back') {
            if (this.stack.length > 1) {
                this.stack.pop();
                await this.refresh();
            }
            return;
        }
        if (msg.type === 'jump') {
            // Truncate the stack so msg.index becomes the new top.
            if (msg.index >= 0 && msg.index < this.stack.length - 1) {
                this.stack = this.stack.slice(0, msg.index + 1);
                await this.refresh();
            }
            return;
        }
        if (msg.type === 'granularity') {
            if (msg.value !== this.granularity) {
                this.granularity = msg.value;
                await this.rerender();
            }
            return;
        }
    }

    private renderHtml(payload: YosysPayload, svg: string): string {
        const moduleNames = Object.keys(payload.modules ?? {});
        const moduleName = moduleNames[0] ?? '';
        const cellIndex: Record<
            string,
            { instance?: VhdlPos; entity?: VhdlPos; type?: string }
        > = {};
        if (moduleName) {
            const m = payload.modules?.[moduleName];
            for (const [name, cell] of Object.entries(m?.cells ?? {})) {
                cellIndex[name] = {
                    instance: cell.vhdl_instance_pos,
                    entity: cell.vhdl_entity_pos,
                    type: cell.type,
                };
            }
        }
        const cellIndexJson = JSON.stringify(cellIndex);
        const moduleEntityPosJson = JSON.stringify(
            payload.modules?.[moduleName]?.vhdl_entity_pos ?? null
        );
        const stackJson = JSON.stringify(this.stack);
        const canGoBack = this.stack.length > 1;
        const granularityValue = this.granularity;

        const csp = `default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline';`;
        return `<!doctype html>
<html>
<head>
<meta charset="utf-8" />
<meta http-equiv="Content-Security-Policy" content="${csp}" />
<title>Data flow ${this.escape(this.currentKey())}</title>
<style>
body { font-family: var(--vscode-editor-font-family, monospace); margin: 0; padding: 0; color: var(--vscode-foreground); background: var(--vscode-editor-background); height: 100vh; display: flex; flex-direction: column; }
header { padding: 6px 12px; border-bottom: 1px solid var(--vscode-panel-border); display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
header button { font: inherit; padding: 2px 8px; background: var(--vscode-button-background); color: var(--vscode-button-foreground); border: 0; cursor: pointer; border-radius: 2px; }
header button:hover:not(:disabled) { background: var(--vscode-button-hoverBackground); }
header button:disabled { opacity: 0.4; cursor: default; }
header .hint { font-size: 11px; color: var(--vscode-descriptionForeground); margin-left: auto; }
header select { font: inherit; padding: 2px 6px; background: var(--vscode-dropdown-background); color: var(--vscode-dropdown-foreground); border: 1px solid var(--vscode-dropdown-border); border-radius: 2px; }
#crumbs { font-size: 12px; display: flex; align-items: center; gap: 4px; flex: 1; min-width: 0; flex-wrap: wrap; }
.crumb { padding: 1px 4px; border-radius: 2px; cursor: pointer; }
.crumb:hover { background: var(--vscode-list-hoverBackground); }
.crumb.current { font-weight: bold; cursor: default; }
.crumb.current:hover { background: transparent; }
.crumb-sep { color: var(--vscode-descriptionForeground); }
#viewport { flex: 1; overflow: hidden; background: var(--vscode-editor-background); position: relative; cursor: grab; }
#viewport.panning { cursor: grabbing; }
#stage { transform-origin: 0 0; will-change: transform; }
#stage svg { background: white; max-width: none; display: block; }
#zoomctl { position: absolute; right: 12px; bottom: 12px; display: flex; gap: 4px; background: var(--vscode-editorWidget-background); border: 1px solid var(--vscode-panel-border); border-radius: 3px; padding: 2px; opacity: 0.85; }
#zoomctl button { font: inherit; padding: 2px 8px; min-width: 26px; background: transparent; color: var(--vscode-foreground); border: 0; cursor: pointer; }
#zoomctl button:hover { background: var(--vscode-list-hoverBackground); }
#zoomctl span { font-size: 11px; color: var(--vscode-descriptionForeground); align-self: center; padding: 0 4px; min-width: 36px; text-align: center; }
g[id^="cell_"] { cursor: pointer; }
g[id^="cell_"]:hover rect, g[id^="cell_"]:hover path { stroke: var(--vscode-focusBorder); stroke-width: 1.5; }
/* Visual distinction by cell kind. Light fill with thin matching */
/* stroke - keeps the schematic readable in both light and dark    */
/* themes since the webview canvas itself is white-backed.         */
g.cell-instance > rect:not(.splitjoinBody) { fill: #eaf2ff; stroke: #5a7fbf; }
g.cell-process > rect:not(.splitjoinBody) { fill: #fff2d6; stroke: #c9962b; }
g.cell-process > path { stroke: #c9962b; }
</style>
</head>
<body>
<header>
  <button id="back" title="Up one level" ${canGoBack ? '' : 'disabled'}>&#x2191;</button>
  <nav id="crumbs"></nav>
  <span class="hint">click: jump to source - shift+click: drill in</span>
  <select id="granularity" title="View granularity">
    <option value="all"${granularityValue === 'all' ? ' selected' : ''}>modules + processes</option>
    <option value="modulesOnly"${granularityValue === 'modulesOnly' ? ' selected' : ''}>modules only</option>
  </select>
  <button id="reload" title="Reload">&#x21bb;</button>
</header>
<div id="viewport">
  <div id="stage">${svg}</div>
  <div id="zoomctl">
    <button id="zoomOut" title="Zoom out (or wheel)">&#x2212;</button>
    <span id="zoomLevel">100%</span>
    <button id="zoomIn" title="Zoom in (or wheel)">+</button>
    <button id="zoomFit" title="Fit to viewport">fit</button>
    <button id="zoomReset" title="Reset to 100%">1:1</button>
  </div>
</div>
<script>
const vscode = acquireVsCodeApi();
const cellIndex = ${cellIndexJson};
const moduleEntityPos = ${moduleEntityPosJson};
const stack = ${stackJson};

function navigate(pos) { if (pos) vscode.postMessage({ type: 'navigate', pos }); }

function drill(typePath) {
    if (!typePath || typePath.startsWith('$')) return;
    const dot = typePath.indexOf('.');
    if (dot < 0) return;
    vscode.postMessage({ type: 'drill', library: typePath.slice(0, dot), entity: typePath.slice(dot + 1) });
}

// Cell click handlers + visual classification (entity instance vs
// process). Cell type is formatted as "<name> : <kind>" where kind
// is either "process (sync|comb)" or "library.entity"; we classify
// off the kind side. Drill targets the bound entity so we extract
// it from the second half before posting.
function splitType(t) {
    if (typeof t !== 'string') return { name: '', kind: '' };
    const sep = t.indexOf(' : ');
    return sep < 0
        ? { name: '', kind: t }
        : { name: t.slice(0, sep), kind: t.slice(sep + 3) };
}
document.querySelectorAll('g[id^="cell_"]').forEach((node) => {
    const name = node.id.replace(/^cell_/, '');
    const info = cellIndex[name];
    if (!info) return;
    const { kind } = splitType(info.type);
    if (kind.startsWith('process')) {
        node.classList.add('cell-process');
    } else {
        node.classList.add('cell-instance');
    }
    node.addEventListener('click', (ev) => {
        ev.stopPropagation();
        if (ev.shiftKey) {
            drill(kind);
        } else if (info.instance) {
            navigate(info.instance);
        }
    });
});

// Breadcrumb. Last entry is the current view (no click); earlier
// entries jump back to that level.
const crumbs = document.getElementById('crumbs');
stack.forEach((entry, i) => {
    if (i > 0) {
        const sep = document.createElement('span');
        sep.className = 'crumb-sep';
        sep.textContent = ' > ';
        crumbs.appendChild(sep);
    }
    const span = document.createElement('span');
    span.className = 'crumb' + (i === stack.length - 1 ? ' current' : '');
    span.textContent = entry.entity;
    span.title = entry.library + '.' + entry.entity;
    if (i === stack.length - 1) {
        // Click on current crumb = jump to the entity declaration.
        if (moduleEntityPos) {
            span.style.cursor = 'pointer';
            span.addEventListener('click', () => navigate(moduleEntityPos));
        }
    } else {
        span.addEventListener('click', () => vscode.postMessage({ type: 'jump', index: i }));
    }
    crumbs.appendChild(span);
});

document.getElementById('back').addEventListener('click', () => {
    vscode.postMessage({ type: 'back' });
});
document.getElementById('reload').addEventListener('click', () => {
    vscode.postMessage({ type: 'reload' });
});
document.getElementById('granularity').addEventListener('change', (ev) => {
    vscode.postMessage({ type: 'granularity', value: ev.target.value });
});

// ----- Pan + zoom on the SVG -----
// Plain CSS transform on a <div id="stage"> wrapping the SVG.
// We track scale + (tx,ty) in viewport-pixel units and rebuild the
// transform string. Wheel zooms toward the mouse position; left-
// or middle-click drag pans.
const viewport = document.getElementById('viewport');
const stage = document.getElementById('stage');
const zoomLevelEl = document.getElementById('zoomLevel');
let scale = 1;
let tx = 0;
let ty = 0;
const MIN_SCALE = 0.05;
const MAX_SCALE = 20;

function applyTransform() {
    stage.style.transform = 'translate(' + tx + 'px, ' + ty + 'px) scale(' + scale + ')';
    zoomLevelEl.textContent = Math.round(scale * 100) + '%';
}
applyTransform();

function setScale(newScale, centerX, centerY) {
    const clamped = Math.max(MIN_SCALE, Math.min(MAX_SCALE, newScale));
    if (clamped === scale) return;
    // Keep the point under (centerX, centerY) fixed in screen space.
    const ratio = clamped / scale;
    tx = centerX - ratio * (centerX - tx);
    ty = centerY - ratio * (centerY - ty);
    scale = clamped;
    applyTransform();
}

viewport.addEventListener('wheel', (ev) => {
    ev.preventDefault();
    const rect = viewport.getBoundingClientRect();
    const cx = ev.clientX - rect.left;
    const cy = ev.clientY - rect.top;
    const factor = Math.pow(1.0015, -ev.deltaY);
    setScale(scale * factor, cx, cy);
}, { passive: false });

let panning = false;
let panStartX = 0;
let panStartY = 0;
let panStartTx = 0;
let panStartTy = 0;
viewport.addEventListener('mousedown', (ev) => {
    // Left or middle button. Skip if the click landed on a cell -
    // those take precedence so we don't fight the navigation handler.
    if (ev.button !== 0 && ev.button !== 1) return;
    if (ev.button === 0 && ev.target.closest && ev.target.closest('g[id^="cell_"]')) return;
    panning = true;
    panStartX = ev.clientX;
    panStartY = ev.clientY;
    panStartTx = tx;
    panStartTy = ty;
    viewport.classList.add('panning');
    ev.preventDefault();
});
window.addEventListener('mousemove', (ev) => {
    if (!panning) return;
    tx = panStartTx + (ev.clientX - panStartX);
    ty = panStartTy + (ev.clientY - panStartY);
    applyTransform();
});
window.addEventListener('mouseup', () => {
    if (panning) {
        panning = false;
        viewport.classList.remove('panning');
    }
});

document.getElementById('zoomIn').addEventListener('click', () => {
    const r = viewport.getBoundingClientRect();
    setScale(scale * 1.25, r.width / 2, r.height / 2);
});
document.getElementById('zoomOut').addEventListener('click', () => {
    const r = viewport.getBoundingClientRect();
    setScale(scale / 1.25, r.width / 2, r.height / 2);
});
document.getElementById('zoomReset').addEventListener('click', () => {
    scale = 1; tx = 0; ty = 0; applyTransform();
});
document.getElementById('zoomFit').addEventListener('click', () => {
    const svgEl = stage.querySelector('svg');
    if (!svgEl) return;
    const r = viewport.getBoundingClientRect();
    const bb = svgEl.getBoundingClientRect();
    // Use the bounding box at scale=1 to compute fit; we read the
    // attributes since current bb is post-transform.
    const w = parseFloat(svgEl.getAttribute('width') || bb.width / scale);
    const h = parseFloat(svgEl.getAttribute('height') || bb.height / scale);
    const sx = (r.width - 24) / w;
    const sy = (r.height - 24) / h;
    scale = Math.max(MIN_SCALE, Math.min(MAX_SCALE, Math.min(sx, sy)));
    tx = (r.width - w * scale) / 2;
    ty = (r.height - h * scale) / 2;
    applyTransform();
});

// Keyboard shortcuts when the panel is focused.
window.addEventListener('keydown', (ev) => {
    if (ev.target && (ev.target.tagName === 'INPUT' || ev.target.tagName === 'TEXTAREA')) return;
    if ((ev.key === '+' || ev.key === '=') && (ev.ctrlKey || ev.metaKey)) {
        ev.preventDefault();
        document.getElementById('zoomIn').click();
    } else if (ev.key === '-' && (ev.ctrlKey || ev.metaKey)) {
        ev.preventDefault();
        document.getElementById('zoomOut').click();
    } else if (ev.key === '0' && (ev.ctrlKey || ev.metaKey)) {
        ev.preventDefault();
        document.getElementById('zoomReset').click();
    }
});
</script>
</body>
</html>`;
    }

    private placeholderHtml(message: string): string {
        const csp = `default-src 'none'; style-src 'unsafe-inline';`;
        return `<!doctype html>
<html>
<head>
<meta charset="utf-8" />
<meta http-equiv="Content-Security-Policy" content="${csp}" />
<style>
body { font-family: var(--vscode-editor-font-family, monospace); padding: 16px; color: var(--vscode-foreground); background: var(--vscode-editor-background); white-space: pre-wrap; }
</style>
</head>
<body>${this.escape(message)}</body>
</html>`;
    }

    /// Public hook so the breadcrumb in the panel header can be
    /// extended later if needed (e.g. by an external "go up" command).
    levelUp(): void {
        if (this.stack.length > 1) {
            this.stack.pop();
            void this.refresh();
        }
    }

    private escape(s: string): string {
        return s.replace(/[&<>"']/g, (c) => {
            switch (c) {
                case '&':
                    return '&amp;';
                case '<':
                    return '&lt;';
                case '>':
                    return '&gt;';
                case '"':
                    return '&quot;';
                case "'":
                    return '&#39;';
                default:
                    return c;
            }
        });
    }
}
