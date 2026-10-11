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

export const DATA_FLOW_REQUEST = 'vhdl/dataFlow';

interface SrcRange {
    file: string;
    start: { line: number; character: number };
    end: { line: number; character: number };
}

interface NavEntry {
    library: string;
    entity: string;
}

type IncomingMessage =
    | { type: 'ready' }
    | { type: 'reload' }
    | { type: 'back' }
    | { type: 'navigate'; pos: SrcRange }
    | { type: 'drill'; library: string; entity: string }
    | { type: 'jump'; index: number };

/** Open panels keyed by the entity they were opened for (bottom of the nav stack). */
const panels = new Map<string, DataFlowPanel>();

/**
 * @brief Webview panel hosting the data-flow schematic of one entity.
 * The webview script (dist/dataflowView.js) lays out and draws the graph;
 * this side fetches vhdl/dataFlow, keeps the drill-down stack and opens
 * source locations.
 */
export class DataFlowPanel {
    private readonly panel: WebviewPanel;
    private readonly initialKey: string;
    private stack: NavEntry[];
    private ready = false;

    private constructor(
        library: string,
        entity: string,
        private readonly extensionUri: Uri,
        private readonly getClient: () => LanguageClient,
        private readonly log: OutputChannel
    ) {
        this.stack = [{ library, entity }];
        this.initialKey = `${library}.${entity}`;
        const dist = Uri.joinPath(extensionUri, 'dist');
        this.panel = window.createWebviewPanel('vhdlDataflow', this.panelTitle(), ViewColumn.Active, {
            enableScripts: true,
            retainContextWhenHidden: true,
            localResourceRoots: [dist],
        });
        this.panel.onDidDispose(() => panels.delete(this.initialKey));
        this.panel.webview.onDidReceiveMessage((msg: IncomingMessage) => {
            this.handleMessage(msg).catch((err) => {
                this.log.appendLine(`dataflow webview message error: ${err}`);
            });
        });
        this.panel.webview.html = this.html(this.panel.webview.asWebviewUri(Uri.joinPath(dist, 'dataflowView.js')));
    }

    static showOrCreate(
        library: string,
        entity: string,
        extensionUri: Uri,
        getClient: () => LanguageClient,
        log: OutputChannel
    ): DataFlowPanel {
        const key = `${library}.${entity}`;
        const existing = panels.get(key);
        if (existing) {
            existing.panel.reveal(ViewColumn.Active);
            existing.stack = [{ library, entity }];
            void existing.refresh();
            return existing;
        }
        const panel = new DataFlowPanel(library, entity, extensionUri, getClient, log);
        panels.set(key, panel);
        return panel;
    }

    private current(): NavEntry {
        return this.stack[this.stack.length - 1];
    }

    private panelTitle(): string {
        const top = this.stack[0];
        return this.stack.length === 1
            ? `Data flow: ${top.library}.${top.entity}`
            : `Data flow: ${top.entity} > ${this.current().entity}`;
    }

    async refresh(): Promise<void> {
        if (!this.ready) {
            return;
        }
        const c = this.current();
        this.panel.title = this.panelTitle();
        void this.panel.webview.postMessage({ type: 'loading', message: `${c.library}.${c.entity}` });
        try {
            const df = await this.getClient().sendRequest<unknown>(DATA_FLOW_REQUEST, {
                library: c.library,
                entity: c.entity,
            });
            void this.panel.webview.postMessage({ type: 'graph', df, stack: this.stack });
        } catch (err) {
            const detail = err instanceof Error ? err.message : String(err);
            this.log.appendLine(`Data-flow request failed: ${detail}`);
            void this.panel.webview.postMessage({
                type: 'error',
                message: `Failed to load data flow for ${c.library}.${c.entity}: ${detail}`,
            });
        }
    }

    private async handleMessage(msg: IncomingMessage): Promise<void> {
        switch (msg.type) {
            case 'ready':
                this.ready = true;
                await this.refresh();
                return;
            case 'reload':
                await this.refresh();
                return;
            case 'navigate': {
                const range = new Range(
                    new Position(msg.pos.start.line, msg.pos.start.character),
                    new Position(msg.pos.end.line, msg.pos.end.character)
                );
                const doc = await workspace.openTextDocument(Uri.file(msg.pos.file));
                await window.showTextDocument(doc, { viewColumn: ViewColumn.Beside, selection: range });
                return;
            }
            case 'drill':
                this.stack.push({ library: msg.library, entity: msg.entity });
                await this.refresh();
                return;
            case 'back':
                if (this.stack.length > 1) {
                    this.stack.pop();
                    await this.refresh();
                }
                return;
            case 'jump':
                if (msg.index >= 0 && msg.index < this.stack.length - 1) {
                    this.stack = this.stack.slice(0, msg.index + 1);
                    await this.refresh();
                }
                return;
        }
    }

    private html(script: Uri): string {
        const nonce = [...Array(32)].map(() => Math.floor(Math.random() * 36).toString(36)).join('');
        const csp = [
            "default-src 'none'",
            `style-src ${this.panel.webview.cspSource} 'unsafe-inline'`,
            `script-src 'nonce-${nonce}'`,
        ].join('; ');
        return `<!doctype html>
<html>
<head>
<meta charset="utf-8" />
<meta http-equiv="Content-Security-Policy" content="${csp}" />
<style>${DATAFLOW_CSS}</style>
</head>
<body>
<header>
  <button id="up" title="Up one level (Backspace)">&#8593;</button>
  <nav id="crumbs"></nav>
  <input id="search" type="search" placeholder="find net or cell  ( / )" spellcheck="false" />
  <label title="Show processes as cells"><input id="procs" type="checkbox" /> processes</label>
  <label title="Group pins sharing a name prefix into buses"><input id="buses" type="checkbox" /> buses</label>
  <label title="Smallest group that forms a bus">min <input id="minbus" type="number" min="2" max="16" /></label>
  <span id="zoom">100%</span>
  <button id="fit" title="Fit (F)">fit</button>
  <button id="reload" title="Reload">reload</button>
</header>
<div id="viewport">
  <svg id="canvas" xmlns="http://www.w3.org/2000/svg"></svg>
  <div id="status" hidden></div>
  <div id="chips" hidden></div>
  <div id="help">hover: trace - click: highlight (ctrl: add) - double-click: source / expand bus - right-click: more</div>
</div>
<div id="tip" hidden></div>
<div id="menu" hidden></div>
<script nonce="${nonce}" src="${script.toString()}"></script>
</body>
</html>`;
    }
}

/** Webview styles; colors come from the VS Code theme so both light and dark themes work. */
export const DATAFLOW_CSS = `
:root {
  --fg: var(--vscode-editor-foreground);
  --bg: var(--vscode-editor-background);
  --dim: var(--vscode-descriptionForeground);
  --wire: color-mix(in srgb, var(--fg) 55%, var(--bg));
  --cell: var(--vscode-editorWidget-background);
  --cell-edge: color-mix(in srgb, var(--fg) 45%, var(--bg));
  --hov: var(--vscode-editorCursor-foreground, var(--fg));
  --c0: var(--vscode-charts-blue);
  --c1: var(--vscode-charts-orange);
  --c2: var(--vscode-charts-green);
  --c3: var(--vscode-charts-purple);
  --c4: var(--vscode-charts-red);
  --c5: var(--vscode-charts-yellow);
  --warn: var(--vscode-editorWarning-foreground);
}
html, body { height: 100%; }
body { margin: 0; padding: 0; color: var(--fg); background: var(--bg); display: flex; flex-direction: column; overflow: hidden;
  font-family: var(--vscode-font-family); font-size: 12px; }
header { padding: 4px 8px; border-bottom: 1px solid var(--vscode-panel-border); display: flex; align-items: center; gap: 8px; }
header button { font: inherit; padding: 2px 8px; background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground); border: 0; border-radius: 2px; cursor: pointer; }
header button:hover:not(:disabled) { background: var(--vscode-button-secondaryHoverBackground); }
header button:disabled { opacity: 0.4; cursor: default; }
header label { display: flex; align-items: center; gap: 3px; color: var(--dim); white-space: nowrap; }
header input[type=number] { width: 3em; }
header input { font: inherit; background: var(--vscode-input-background); color: var(--vscode-input-foreground); border: 1px solid var(--vscode-input-border, transparent); border-radius: 2px; padding: 1px 4px; }
#search { width: 16em; }
#search.nomatch { outline: 1px solid var(--vscode-inputValidation-errorBorder); }
#crumbs { flex: 1; min-width: 0; display: flex; gap: 2px; align-items: center; overflow: hidden; white-space: nowrap; }
.crumb { padding: 1px 4px; border-radius: 2px; cursor: pointer; }
.crumb:hover { background: var(--vscode-list-hoverBackground); }
.crumb.current { font-weight: bold; }
.sep { color: var(--dim); }
#zoom { color: var(--dim); min-width: 3.5em; text-align: right; }
#viewport { flex: 1; position: relative; overflow: hidden; cursor: default; user-select: none; }
#viewport.panning { cursor: grabbing; }
#canvas { position: absolute; inset: 0; width: 100%; height: 100%; display: block;
  font-family: var(--vscode-editor-font-family, monospace); font-size: 11px; text-rendering: geometricPrecision; }
#status { position: absolute; left: 50%; top: 40%; transform: translateX(-50%); padding: 8px 14px; border-radius: 3px;
  background: var(--vscode-editorWidget-background); border: 1px solid var(--vscode-editorWidget-border); white-space: pre-wrap; max-width: 80%; }
#help { position: absolute; right: 8px; bottom: 6px; color: var(--dim); font-size: 11px; pointer-events: none; padding: 1px 6px; border-radius: 3px;
  background: color-mix(in srgb, var(--bg) 85%, transparent); }
#chips { position: absolute; left: 8px; bottom: 6px; display: flex; flex-wrap: wrap; gap: 4px; max-width: 60%; }
.chip { display: flex; align-items: center; gap: 5px; padding: 2px 4px 2px 6px; border-radius: 10px; cursor: pointer;
  background: var(--vscode-badge-background); color: var(--vscode-badge-foreground); font-family: var(--vscode-editor-font-family); font-size: 11px; }
.chip em { opacity: 0.7; font-style: normal; }
.chip b { padding: 0 4px; border-radius: 8px; font-weight: normal; opacity: 0.7; }
.chip b:hover { opacity: 1; background: var(--vscode-toolbar-hoverBackground); }
.sw { width: 9px; height: 9px; border-radius: 50%; display: inline-block; }
.sw.c0 { background: var(--c0); } .sw.c1 { background: var(--c1); } .sw.c2 { background: var(--c2); }
.sw.c3 { background: var(--c3); } .sw.c4 { background: var(--c4); } .sw.c5 { background: var(--c5); }
#tip, #menu { position: fixed; z-index: 10; background: var(--vscode-editorHoverWidget-background); color: var(--vscode-editorHoverWidget-foreground);
  border: 1px solid var(--vscode-editorHoverWidget-border); border-radius: 3px; box-shadow: 0 2px 8px var(--vscode-widget-shadow); }
#tip { padding: 5px 8px; max-width: 480px; pointer-events: none; font-family: var(--vscode-editor-font-family); font-size: 11px; line-height: 1.45; }
#tip hr { border: 0; border-top: 1px solid var(--vscode-editorHoverWidget-border); margin: 4px 0; }
#tip em, #tip .dim { color: var(--dim); font-style: normal; }
#tip .members { color: var(--dim); word-break: break-all; }
#tip .warn { color: var(--warn); }
#menu { padding: 3px 0; min-width: 180px; background: var(--vscode-menu-background); color: var(--vscode-menu-foreground); }
.mi { padding: 3px 14px; cursor: pointer; white-space: nowrap; }
.mi:hover { background: var(--vscode-menu-selectionBackground); color: var(--vscode-menu-selectionForeground); }
[hidden] { display: none !important; }

/* Schematic. --inv is 1/zoom: widths scaled by max(1, --inv) stay at least their nominal screen width when zoomed out. */
#canvas { --inv: 1; }
.wire, .hl, .sl { fill: none; stroke-linejoin: round; }
.wire { stroke: var(--wire); stroke-width: calc(1.1px * max(1, var(--inv))); }
.wire.bus { stroke-width: calc(3px * max(1, var(--inv))); }
.wire.cdc { stroke: var(--warn); stroke-dasharray: 6 3; }
.junction { fill: var(--wire); }
.hit { fill: none; stroke: transparent; stroke-width: calc(9px * max(1, var(--inv))); pointer-events: stroke; cursor: pointer; }
.hl { stroke: var(--hov); stroke-width: calc(2.2px * max(1, var(--inv))); }
.hl.bus { stroke-width: calc(4.5px * max(1, var(--inv))); }
.sl { stroke-width: calc(2.4px * max(1, var(--inv))); }
.sl.bus { stroke-width: calc(4.5px * max(1, var(--inv))); }
.sl.c0 { stroke: var(--c0); } .sl.c1 { stroke: var(--c1); } .sl.c2 { stroke: var(--c2); }
.sl.c3 { stroke: var(--c3); } .sl.c4 { stroke: var(--c4); } .sl.c5 { stroke: var(--c5); }
.has-sel .wires, .has-sel .junctions { opacity: 0.3; }
.has-sel .cell:not(.touched) { opacity: 0.45; }
.cell .body { fill: var(--cell); stroke: var(--cell-edge); stroke-width: calc(1px * max(1, var(--inv))); }
.cell:hover > .body { stroke: var(--vscode-focusBorder); }
.k-process .body { fill: color-mix(in srgb, var(--c5) 10%, var(--cell)); stroke: color-mix(in srgb, var(--c5) 60%, var(--bg)); }
.k-input .body, .k-output .body { fill: color-mix(in srgb, var(--fg) 8%, var(--bg)); }
.body.busport { stroke-width: calc(2px * max(1, var(--inv))); }
.headsep { stroke: var(--cell-edge); stroke-width: 0.5; opacity: 0.6; }
.title { fill: var(--fg); font-weight: bold; }
.subtitle { fill: var(--dim); font-size: 10px; }
.subtitle.unresolved { fill: var(--warn); }
.gentag { fill: var(--c3); font-size: 10px; }
.tiemark { fill: none; stroke: var(--dim); stroke-width: 1; }
.portlabel, .pinlabel { fill: var(--fg); }
.pin.bus .pinlabel, .portlabel { font-weight: bold; }
.buswidth { fill: var(--dim); font-weight: normal; }
.pin.nc .pinlabel { fill: var(--dim); }
.ncmark { fill: none; stroke: var(--dim); stroke-width: 1; }
.clkmark { fill: none; stroke: var(--fg); stroke-width: 1; }
.pinhit { fill: transparent; cursor: pointer; }
.pin:hover .pinhit { fill: var(--vscode-list-hoverBackground); }
.pin-hov .pinlabel { fill: var(--hov); font-weight: bold; }
.pin-sel-c0 .pinlabel { fill: var(--c0); } .pin-sel-c1 .pinlabel { fill: var(--c1); } .pin-sel-c2 .pinlabel { fill: var(--c2); }
.pin-sel-c3 .pinlabel { fill: var(--c3); } .pin-sel-c4 .pinlabel { fill: var(--c4); } .pin-sel-c5 .pinlabel { fill: var(--c5); }
.pin-sel .pinlabel { font-weight: bold; }
.drill { cursor: pointer; }
.drill rect { fill: transparent; stroke: var(--cell-edge); stroke-width: 0.8; }
.drill path { fill: none; stroke: var(--fg); stroke-width: 1.4; }
.drill:hover rect { fill: var(--vscode-list-hoverBackground); stroke: var(--vscode-focusBorder); }
.lod-far .pinlabel, .lod-far .subtitle, .lod-far .drill { display: none; }
.lod-very-far .title, .lod-very-far .portlabel { display: none; }
`;
