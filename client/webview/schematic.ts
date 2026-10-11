/* ------------------------------------------------------------------------------------------
 * MIT License
 * ------------------------------------------------------------------------------------------ */
// Schematic model for the data-flow view: turns the vhdl/dataFlow payload
// into cells, pins and wires, groups pins into buses by name prefix, lays
// the result out with ELK and renders it to an SVG string. DOM-free, so the
// same code runs in the webview and under node for checks.

import type { ElkExtendedEdge, ElkNode, ElkPort } from 'elkjs/lib/elk-api';

// ----------------------------------------------------------------------------
// Payload (vhdl_lang::DataFlow as serialized by the server)
// ----------------------------------------------------------------------------

export type Dir = 'in' | 'out' | 'inout' | 'buffer' | 'linkage' | 'unknown';

export interface SrcRange {
    file: string;
    start: { line: number; character: number };
    end: { line: number; character: number };
}

export interface DfPort {
    name: string;
    direction: Dir;
    type_repr: string;
    decl_pos: SrcRange | null;
}

export interface DfInstance {
    id: string;
    label: string | null;
    entity_path: string;
    component: string | null;
    instance_pos: SrcRange | null;
    entity_pos: SrcRange | null;
    ports: DfPort[];
    clocks: string[];
    generate: GenerateScope[];
}

export type GenerateScope =
    | { kind: 'for'; label: string | null; index: string; range: string }
    | { kind: 'if'; label: string | null; condition: string | null }
    | { kind: 'case'; label: string | null; expression: string; choices: string };

export interface DfEndpoint {
    kind: 'external' | 'instance' | 'process';
    cell_id: string | null;
    port: string;
    /** Sub-element of the net at this endpoint, as written: (7 downto 0), .field. */
    part: string | null;
    direction: Dir;
    source_pos: SrcRange | null;
}

export interface DfProcess {
    id: string;
    label: string | null;
    source_pos: SrcRange | null;
    clock_signal: string | null;
    reset_signal: string | null;
}

export interface DfNet {
    name: string;
    kind: 'signal' | 'parent_port' | 'opaque' | 'unresolved';
    endpoints: DfEndpoint[];
    clock_domain: string | null;
    is_cdc: boolean;
}

export interface DataFlow {
    entity_path: string;
    architecture: string | null;
    entity_pos: SrcRange | null;
    external_ports: DfPort[];
    instances: DfInstance[];
    processes: DfProcess[];
    nets: DfNet[];
}

// ----------------------------------------------------------------------------
// Schematic model
// ----------------------------------------------------------------------------

export type Side = 'W' | 'E';
export type CellKind = 'instance' | 'process' | 'input' | 'output';

/**
 * @brief One connection point on a cell edge.
 * A bus pin stands for several ports; nets, members and ports are parallel
 * to each other only for single pins, a bus pin lists each member once.
 */
export interface Pin {
    id: string;
    cell: string;
    side: Side;
    label: string;
    members: string[];
    nets: string[];
    /** Group key of the bus this pin forms or could form, null when none. */
    group: string | null;
    /** True when the pin is the collapsed bus of group. */
    bus: boolean;
    clock: boolean;
    /** Every net on the pin has this pin as its only endpoint. */
    dangling: boolean;
    /** Sub-element text per net key, for nets the pin touches only in part. */
    parts: Record<string, string>;
    /** Expression the pin is tied to in the port map, null when it is on a signal. */
    tie: string | null;
    /** Name in the port map the analyzer could not resolve, null otherwise. */
    unresolved: string | null;
    type: string;
    assoc: SrcRange | null;
    decl: SrcRange | null;
}

export interface Cell {
    id: string;
    kind: CellKind;
    title: string;
    subtitle: string;
    generate: GenerateScope[];
    /** library.entity to open when descending into the cell, null when not resolvable. */
    drill: string | null;
    pos: SrcRange | null;
    entityPos: SrcRange | null;
    pins: Pin[];
}

export interface Wire {
    id: string;
    src: string;
    dst: string;
    nets: string[];
}

export interface Schematic {
    cells: Cell[];
    wires: Wire[];
    pins: Map<string, Pin>;
    /** Wires, pins and nets below are keyed by net key, see @ref netIds. */
    netWires: Map<string, string[]>;
    netPins: Map<string, string[]>;
    nets: Map<string, DfNet>;
}

export interface BuildOptions {
    processes: boolean;
    buses: boolean;
    minBus: number;
    /** Group keys of buses the user expanded back into single pins. */
    ungrouped: ReadonlySet<string>;
}

interface RawPin {
    cell: string;
    side: Side;
    port: string;
    nets: string[];
    parts: Record<string, string>;
    tie: string | null;
    unresolved: string | null;
    type: string;
    assoc: SrcRange | null;
    decl: SrcRange | null;
}

const EXT_IN = 'x:in';
const EXT_OUT = 'x:out';

function endpointCell(ep: DfEndpoint): string {
    if (ep.kind === 'instance') {
        return 'i:' + ep.cell_id;
    }
    if (ep.kind === 'process') {
        return 'p:' + ep.cell_id;
    }
    return ep.direction === 'in' ? EXT_IN : EXT_OUT;
}

/**
 * @brief True when the endpoint puts a value onto its net.
 * An external in port drives the architecture, an instance or process out
 * port drives it from inside.
 */
function drives(ep: DfEndpoint): boolean {
    if (ep.kind === 'external') {
        return ep.direction === 'in';
    }
    return ep.direction === 'out' || ep.direction === 'buffer';
}

/**
 * @brief Picks the driving endpoint of a net.
 * Falls back to the first bidirectional or unknown endpoint, and to the
 * first endpoint, when no endpoint drives by direction.
 */
function driverIndex(net: DfNet): number {
    const eps = net.endpoints;
    const known = eps.findIndex(drives);
    if (known >= 0) {
        return known;
    }
    const weak = eps.findIndex((e) => e.direction === 'inout' || e.direction === 'unknown');
    return weak >= 0 ? weak : 0;
}

/**
 * @brief Underscore-terminated name prefixes of name, shortest first.
 * ACQ_COUNT_I yields ACQ_ and ACQ_COUNT_; a single-segment name yields none.
 */
export function prefixes(name: string): string[] {
    const out: string[] = [];
    let at = name.indexOf('_');
    while (at > 0 && at < name.length - 1) {
        out.push(name.slice(0, at + 1));
        at = name.indexOf('_', at + 1);
    }
    return out;
}

/**
 * @brief Groups names by their longest prefix shared with at least minSize names.
 * Returns prefix (lower case) per grouped name; ungrouped names are absent.
 */
export function groupByPrefix(names: string[], minSize: number): Map<string, string> {
    const counts = new Map<string, number>();
    for (const n of names) {
        for (const p of prefixes(n.toLowerCase())) {
            counts.set(p, (counts.get(p) ?? 0) + 1);
        }
    }

    const best = new Map<string, string>();
    for (const n of names) {
        const fit = prefixes(n.toLowerCase()).filter((p) => (counts.get(p) ?? 0) >= minSize);
        if (fit.length > 0) {
            best.set(n, fit[fit.length - 1]);
        }
    }

    const sizes = new Map<string, number>();
    for (const p of best.values()) {
        sizes.set(p, (sizes.get(p) ?? 0) + 1);
    }
    for (const [n, p] of best) {
        if ((sizes.get(p) ?? 0) < minSize) {
            best.delete(n);
        }
    }
    return best;
}

/**
 * @brief Bus label: shared prefix, a star, and the shared underscore-delimited suffix.
 * ACQ_COUNT_I, ACQ_START_I, ACQ_STOP_I give ACQ_*_I.
 */
export function busLabel(members: string[], prefixLen: number): string {
    const rests = members.map((m) => m.slice(prefixLen));
    let suffix = '';
    const us = rests[0].lastIndexOf('_');
    if (us > 0) {
        const cand = rests[0].slice(us).toLowerCase();
        if (rests.every((r) => r.length > cand.length && r.toLowerCase().endsWith(cand))) {
            suffix = rests[0].slice(us);
        }
    }
    return members[0].slice(0, prefixLen) + '*' + suffix;
}

/**
 * @brief Side of the cell an endpoint's pin sits on: drivers east, loads west.
 * isDriver decides only for bidirectional and unknown endpoints.
 */
function endpointSide(ep: DfEndpoint, isDriver: boolean): Side {
    if (ep.kind === 'external') {
        return ep.direction === 'in' ? 'E' : 'W';
    }
    if (drives(ep)) {
        return 'E';
    }
    if (ep.direction === 'in') {
        return 'W';
    }
    return isDriver ? 'E' : 'W';
}

/**
 * @brief Unique key per net, parallel to df.nets.
 * Net names repeat for opaque actuals (every constant association is its
 * own net named after its expression), so a repeated name gets a #n suffix.
 */
export function netIds(df: DataFlow): string[] {
    const seen = new Map<string, number>();
    return df.nets.map((n) => {
        const k = seen.get(n.name) ?? 0;
        seen.set(n.name, k + 1);
        return k === 0 ? n.name : n.name + '#' + k;
    });
}

function dedupe(xs: string[]): string[] {
    return [...new Set(xs)];
}

function collectRawPins(df: DataFlow, ids: string[], opts: BuildOptions): Map<string, RawPin> {
    const decl = new Map<string, DfPort>();
    for (const inst of df.instances) {
        for (const p of inst.ports) {
            decl.set('i:' + inst.id + '|' + p.name.toLowerCase(), p);
        }
    }
    for (const p of df.external_ports) {
        decl.set('x|' + p.name.toLowerCase(), p);
    }

    const raw = new Map<string, RawPin>();
    const add = (cell: string, side: Side, ep: DfEndpoint, net: DfNet, key: string): void => {
        const k = cell + '|' + side + '|' + ep.port.toLowerCase();
        let pin = raw.get(k);
        if (!pin) {
            const d = decl.get((cell.startsWith('x:') ? 'x' : cell) + '|' + ep.port.toLowerCase());
            pin = {
                cell,
                side,
                port: ep.port,
                nets: [],
                parts: {},
                tie: null,
                unresolved: null,
                type: d?.type_repr ?? '',
                assoc: ep.source_pos,
                decl: d?.decl_pos ?? null,
            };
            raw.set(k, pin);
        }
        if (net.kind === 'opaque') {
            pin.tie = net.name;
            return;
        }
        if (net.kind === 'unresolved') {
            pin.unresolved = net.name;
            return;
        }
        if (!pin.nets.includes(key)) {
            pin.nets.push(key);
        }
        if (ep.part !== null) {
            pin.parts[key] = ep.part;
        }
    };

    df.nets.forEach((net, n) => {
        const drv = driverIndex(net);
        net.endpoints.forEach((ep, i) => {
            if (ep.kind === 'process' && !opts.processes) {
                return;
            }
            add(endpointCell(ep), endpointSide(ep, i === drv), ep, net, ids[n]);
        });
    });

    return raw;
}

/**
 * @brief Keys of the nets used as clocks or resets somewhere in the architecture.
 * Only signal and parent-port nets can be clocks or resets.
 */
function clockAndResetNets(df: DataFlow, ids: string[]): { clocks: Set<string>; resets: Set<string> } {
    const clockNames = new Set<string>(df.instances.flatMap((i) => i.clocks));
    const resetNames = new Set<string>();
    for (const p of df.processes) {
        if (p.clock_signal) {
            clockNames.add(p.clock_signal);
        }
        if (p.reset_signal) {
            resetNames.add(p.reset_signal);
        }
    }

    const clocks = new Set<string>();
    const resets = new Set<string>();
    df.nets.forEach((n, i) => {
        const carried = n.kind === 'signal' || n.kind === 'parent_port';
        if (carried && clockNames.has(n.name)) {
            clocks.add(ids[i]);
        }
        if (carried && resetNames.has(n.name)) {
            resets.add(ids[i]);
        }
    });
    return { clocks, resets };
}

/**
 * @brief Builds the schematic model of one architecture.
 * Pins of one cell side sharing a name prefix collapse into one bus pin
 * unless their group key is in opts.ungrouped; clock and reset pins stay
 * single. Each wire joins a driving pin to one sink pin and carries every
 * net that runs between the two.
 */
export function buildSchematic(df: DataFlow, opts: BuildOptions): Schematic {
    const ids = netIds(df);
    const raw = collectRawPins(df, ids, opts);
    const { clocks, resets } = clockAndResetNets(df, ids);

    const bySide = new Map<string, RawPin[]>();
    for (const r of raw.values()) {
        const k = r.cell + '|' + r.side;
        bySide.set(k, [...(bySide.get(k) ?? []), r]);
    }

    const pins = new Map<string, Pin>();
    const pinOf = new Map<string, string>();
    for (const [sideKey, list] of bySide) {
        const groupable = list.filter((r) => !r.nets.some((n) => clocks.has(n) || resets.has(n)));
        const groups = groupByPrefix(
            groupable.map((r) => r.port),
            opts.buses ? opts.minBus : Number.MAX_SAFE_INTEGER
        );
        const members = new Map<string, RawPin[]>();
        for (const r of list) {
            const g = groups.get(r.port);
            if (g !== undefined) {
                members.set(g, [...(members.get(g) ?? []), r]);
            }
        }

        for (const r of list) {
            const g = groups.get(r.port);
            const group = g === undefined ? null : sideKey + '|' + g;
            const collapsed = group !== null && !opts.ungrouped.has(group);
            const id = collapsed ? 'b:' + group : 'p:' + sideKey + '|' + r.port.toLowerCase();
            pinOf.set(r.cell + '|' + r.side + '|' + r.port.toLowerCase(), id);
            if (pins.has(id)) {
                continue;
            }
            const ms = collapsed ? members.get(g as string) ?? [r] : [r];
            ms.sort((a, b) => a.port.localeCompare(b.port));
            pins.set(id, {
                id,
                cell: r.cell,
                side: r.side,
                label: collapsed ? busLabel(ms.map((m) => m.port), (g as string).length) : r.port,
                members: ms.map((m) => m.port),
                nets: dedupe(ms.flatMap((m) => m.nets)),
                group,
                bus: collapsed,
                clock: r.nets.some((n) => clocks.has(n)),
                dangling: false,
                parts: Object.assign({}, ...ms.map((m) => m.parts)),
                tie: collapsed ? null : r.tie,
                unresolved: collapsed ? null : r.unresolved,
                type: collapsed ? ms.length + ' ports' : r.type,
                assoc: collapsed ? null : r.assoc,
                decl: collapsed ? null : r.decl,
            });
        }
    }

    const cells = buildCells(df, opts, pins);

    const wires = new Map<string, Wire>();
    const netWires = new Map<string, string[]>();
    const netPins = new Map<string, string[]>();
    const nets = new Map<string, DfNet>();
    df.nets.forEach((net, n) => {
        const id = ids[n];
        nets.set(id, net);
        const eps = net.endpoints.filter((e) => opts.processes || e.kind !== 'process');
        if (eps.length === 0 || (net.kind !== 'signal' && net.kind !== 'parent_port')) {
            return;
        }
        const drvEp = net.endpoints[driverIndex(net)];
        const pinIds = eps.map(
            (ep) => pinOf.get(endpointCell(ep) + '|' + endpointSide(ep, ep === drvEp) + '|' + ep.port.toLowerCase()) as string
        );
        netPins.set(id, dedupe(pinIds));
        const src = eps.includes(drvEp) ? pinIds[eps.indexOf(drvEp)] : pinIds[0];
        for (const dst of dedupe(pinIds)) {
            if (dst === src) {
                continue;
            }
            const wid = 'w:' + src + '>' + dst;
            let w = wires.get(wid);
            if (!w) {
                w = { id: wid, src, dst, nets: [] };
                wires.set(wid, w);
            }
            w.nets.push(id);
            netWires.set(id, [...(netWires.get(id) ?? []), wid]);
        }
    });

    for (const p of pins.values()) {
        p.dangling = p.nets.length > 0 && p.nets.every((n) => (netPins.get(n) ?? []).length === 1);
    }

    return { cells, wires: [...wires.values()], pins, netWires, netPins, nets };
}

function buildCells(df: DataFlow, opts: BuildOptions, pins: Map<string, Pin>): Cell[] {
    const byCell = new Map<string, Pin[]>();
    for (const p of pins.values()) {
        byCell.set(p.cell, [...(byCell.get(p.cell) ?? []), p]);
    }
    const extDecl = new Map(df.external_ports.map((p) => [p.name.toLowerCase(), p]));

    const cells: Cell[] = [];
    for (const inst of df.instances) {
        const resolved = inst.component === null && !inst.entity_path.startsWith('<');
        cells.push({
            id: 'i:' + inst.id,
            kind: 'instance',
            title: inst.label ?? inst.id,
            subtitle: resolved ? inst.entity_path : inst.component ? 'component ' + inst.component : 'unresolved',
            generate: inst.generate,
            drill: resolved ? inst.entity_path : null,
            pos: inst.instance_pos,
            entityPos: inst.entity_pos,
            pins: byCell.get('i:' + inst.id) ?? [],
        });
    }
    if (opts.processes) {
        for (const proc of df.processes) {
            cells.push({
                id: 'p:' + proc.id,
                kind: 'process',
                title: proc.label ?? 'process :' + ((proc.source_pos?.start.line ?? -1) + 1),
                generate: [],
                subtitle: proc.clock_signal ? 'process @ ' + proc.clock_signal : 'process (comb)',
                drill: null,
                pos: proc.source_pos,
                entityPos: null,
                pins: byCell.get('p:' + proc.id) ?? [],
            });
        }
    }

    // Module ports: one cell per port or per port bus, with its single pin.
    for (const ext of [EXT_IN, EXT_OUT]) {
        for (const pin of byCell.get(ext) ?? []) {
            const d = pin.bus ? undefined : extDecl.get(pin.label.toLowerCase());
            const id = 'x:' + pin.id;
            pin.cell = id;
            cells.push({
                id,
                kind: ext === EXT_IN ? 'input' : 'output',
                title: pin.label,
                subtitle: '',
                generate: [],
                drill: null,
                pos: d?.decl_pos ?? null,
                entityPos: null,
                pins: [pin],
            });
        }
    }
    return cells;
}

// ----------------------------------------------------------------------------
// Layout
// ----------------------------------------------------------------------------

export const PIN_PITCH = 16;
export const HEADER = 36;
const PORT_H = 20;

export type Measure = (text: string, bold: boolean) => number;

/** Monospace 11px approximation, for use where no canvas is available. */
export const approxMeasure: Measure = (t, bold) => t.length * (bold ? 7.0 : 6.7);

export interface Placed {
    x: number;
    y: number;
    width: number;
    height: number;
}

export interface Layout {
    width: number;
    height: number;
    cells: Map<string, Placed>;
    /** Pin anchor on the cell edge, absolute. */
    pins: Map<string, { x: number; y: number }>;
    wires: Map<string, { d: string; junctions: { x: number; y: number }[] }>;
}

/**
 * @brief Short header tag for the generate scopes of a cell: "x 0 to N - 1 / if COND".
 */
export function generateTag(scopes: GenerateScope[]): string {
    return scopes
        .map((g) => {
            switch (g.kind) {
                case 'for':
                    return 'x ' + g.range;
                case 'if':
                    return g.condition === null ? 'else' : 'if ' + g.condition;
                default:
                    return 'case ' + g.choices;
            }
        })
        .join(' / ');
}

function pinText(p: Pin): string {
    return p.bus ? p.label + ' [' + p.members.length + ']' : p.label;
}

/**
 * @brief ELK graph of the schematic: layered, left to right, orthogonal wires.
 * Module inputs sit in the first layer and outputs in the last; ELK orders
 * pins along each fixed side to reduce crossings.
 */
export function toElk(s: Schematic, measure: Measure): ElkNode {
    const children: ElkNode[] = s.cells.map((c): ElkNode => {
        const ports: ElkPort[] = c.pins.map((p) => ({
            id: p.id,
            width: 0,
            height: 0,
            layoutOptions: { 'elk.port.side': p.side === 'W' ? 'WEST' : 'EAST' },
        }));

        if (c.kind === 'input' || c.kind === 'output') {
            const width = measure(pinText(c.pins[0]), true) + 26;
            return {
                id: c.id,
                width,
                height: PORT_H,
                ports: ports.map((p) => ({ ...p, x: c.kind === 'input' ? width : 0, y: PORT_H / 2 })),
                layoutOptions: {
                    'elk.portConstraints': 'FIXED_POS',
                    'elk.layered.layering.layerConstraint': c.kind === 'input' ? 'FIRST' : 'LAST',
                },
            };
        }

        const w = (side: Side): number =>
            Math.max(0, ...c.pins.filter((p) => p.side === side).map((p) => measure(pinText(p), false)));
        const inner = w('W') + w('E') + 28;
        const tag = generateTag(c.generate);
        const head = Math.max(measure(c.title, true), measure(c.subtitle, false) + (tag ? measure(tag, false) + 28 : 0)) + 36;
        const rows = Math.max(1, ...(['W', 'E'] as Side[]).map((sd) => c.pins.filter((p) => p.side === sd).length));
        return {
            id: c.id,
            width: Math.ceil(Math.max(inner, head, 80)),
            height: HEADER + rows * PIN_PITCH,
            ports,
            layoutOptions: {
                'elk.portConstraints': 'FIXED_SIDE',
                'elk.nodeSize.constraints': 'PORTS MINIMUM_SIZE',
                'elk.nodeSize.minimum': '(' + Math.ceil(Math.max(inner, head, 80)) + ',' + (HEADER + PIN_PITCH) + ')',
                'elk.portAlignment.default': 'BEGIN',
            },
        };
    });

    const edges: ElkExtendedEdge[] = s.wires.map((w) => ({
        id: w.id,
        sources: [w.src],
        targets: [w.dst],
    }));

    return {
        id: 'root',
        layoutOptions: {
            'elk.algorithm': 'layered',
            'elk.direction': 'RIGHT',
            'elk.edgeRouting': 'ORTHOGONAL',
            'elk.layered.spacing.nodeNodeBetweenLayers': '60',
            'elk.layered.spacing.edgeNodeBetweenLayers': '16',
            'elk.layered.spacing.edgeEdgeBetweenLayers': '7',
            'elk.spacing.edgeEdge': '7',
            'elk.spacing.nodeNode': '28',
            'elk.spacing.edgeNode': '14',
            'elk.layered.nodePlacement.strategy': 'NETWORK_SIMPLEX',
            'elk.layered.unnecessaryBendpoints': 'true',
            'elk.layered.considerModelOrder.strategy': 'NODES_AND_EDGES',
            'elk.padding': '[top=24,left=24,bottom=24,right=24]',
            // Port spacing only takes effect at graph level; applies to cells, module ports use FIXED_POS.
            'elk.spacing.portPort': String(PIN_PITCH),
            'elk.spacing.portsSurrounding': '[top=' + (HEADER + 4) + ',left=0,bottom=' + PIN_PITCH / 2 + ',right=0]',
        },
        children,
        edges,
    };
}

export function readLayout(g: ElkNode): Layout {
    const cells = new Map<string, Placed>();
    const pins = new Map<string, { x: number; y: number }>();
    for (const n of g.children ?? []) {
        const x = n.x ?? 0;
        const y = n.y ?? 0;
        cells.set(n.id, { x, y, width: n.width ?? 0, height: n.height ?? 0 });
        for (const p of n.ports ?? []) {
            pins.set(p.id, { x: x + (p.x ?? 0), y: y + (p.y ?? 0) });
        }
    }

    const wires = new Map<string, { d: string; junctions: { x: number; y: number }[] }>();
    for (const e of (g.edges ?? []) as ElkExtendedEdge[]) {
        const parts: string[] = [];
        for (const sec of e.sections ?? []) {
            const pts = [sec.startPoint, ...(sec.bendPoints ?? []), sec.endPoint];
            parts.push('M' + pts.map((p) => r1(p.x) + ' ' + r1(p.y)).join('L'));
        }
        wires.set(e.id, { d: parts.join(''), junctions: e.junctionPoints ?? [] });
    }
    return { width: g.width ?? 0, height: g.height ?? 0, cells, pins, wires };
}

function r1(v: number): number {
    return Math.round(v * 10) / 10;
}

// ----------------------------------------------------------------------------
// SVG
// ----------------------------------------------------------------------------

export function esc(s: string): string {
    return s.replace(/[&<>"']/g, (c) => '&#' + c.charCodeAt(0) + ';');
}

function renderPin(p: Pin, at: { x: number; y: number }, cell: Placed, isPort: boolean): string {
    const loose = p.nets.length === 0;
    const cls = ['pin', p.bus ? 'bus' : '', p.clock ? 'clock' : '', p.dangling || (loose && p.unresolved !== null) ? 'nc' : '', loose && p.tie !== null ? 'tie' : '']
        .filter(Boolean)
        .join(' ');
    const out: string[] = ['<g class="' + cls + '" data-p="' + esc(p.id) + '">'];
    const west = p.side === 'W';
    const x = at.x;
    const y = at.y;
    out.push('<rect class="pinhit" x="' + (west ? x - 6 : cell.x + cell.width / 2) + '" y="' + (y - PIN_PITCH / 2) +
        '" width="' + (cell.width / 2 + 6) + '" height="' + PIN_PITCH + '"/>');
    if (p.dangling || (loose && p.unresolved !== null)) {
        out.push('<circle class="ncmark" cx="' + (west ? x - 4 : x + 4) + '" cy="' + y + '" r="2.5"/>');
    } else if (loose && p.tie !== null) {
        const d = west ? -1 : 1;
        out.push('<path class="tiemark" d="M' + x + ' ' + y + 'h' + 5 * d + 'M' + (x + 5 * d) + ' ' + (y - 4) + 'v8"/>');
    }
    if (p.clock && !isPort) {
        const d = west ? 1 : -1;
        out.push('<path class="clkmark" d="M' + x + ' ' + (y - 4) + 'L' + (x + 6 * d) + ' ' + y + 'L' + x + ' ' + (y + 4) + '"/>');
    }
    if (!isPort) {
        const tx = west ? x + (p.clock ? 9 : 5) : x - (p.clock ? 9 : 5);
        out.push('<text class="pinlabel" x="' + tx + '" y="' + (y + 3.5) + '" text-anchor="' + (west ? 'start' : 'end') + '">' +
            esc(p.label) + (p.bus ? '<tspan class="buswidth"> [' + p.members.length + ']</tspan>' : '') + '</text>');
    }
    out.push('</g>');
    return out.join('');
}

function renderCell(c: Cell, at: Placed, lay: Layout): string {
    const out: string[] = [];
    const isPort = c.kind === 'input' || c.kind === 'output';
    out.push('<g class="cell k-' + c.kind + '" data-c="' + esc(c.id) + '">');
    if (isPort) {
        const { x, y, width: w, height: h } = at;
        const tip = 8;
        const d =
            c.kind === 'input'
                ? 'M' + x + ' ' + y + 'H' + (x + w - tip) + 'L' + (x + w) + ' ' + (y + h / 2) + 'L' + (x + w - tip) + ' ' + (y + h) + 'H' + x + 'Z'
                : 'M' + (x + tip) + ' ' + y + 'H' + (x + w) + 'V' + (y + h) + 'H' + (x + tip) + 'L' + x + ' ' + (y + h / 2) + 'Z';
        const p = c.pins[0];
        out.push('<path class="body' + (p?.bus ? ' busport' : '') + '" d="' + d + '"/>');
        out.push('<text class="portlabel" x="' + (c.kind === 'input' ? x + 6 : x + tip + 4) + '" y="' + (y + h / 2 + 3.5) + '">' +
            esc(c.title) + (p?.bus ? '<tspan class="buswidth"> [' + p.members.length + ']</tspan>' : '') + '</text>');
    } else {
        out.push('<rect class="body" x="' + at.x + '" y="' + at.y + '" width="' + at.width + '" height="' + at.height + '" rx="3"/>');
        out.push('<line class="headsep" x1="' + at.x + '" y1="' + (at.y + HEADER - 6) + '" x2="' + (at.x + at.width) + '" y2="' + (at.y + HEADER - 6) + '"/>');
        out.push('<text class="title" x="' + (at.x + 8) + '" y="' + (at.y + 14) + '">' + esc(c.title) + '</text>');
        out.push('<text class="subtitle' + (c.kind === 'instance' && c.entityPos === null ? ' unresolved' : '') + '" x="' + (at.x + 8) + '" y="' + (at.y + 26) + '">' + esc(c.subtitle) + '</text>');
        const tag = generateTag(c.generate);
        if (tag) {
            out.push('<text class="gentag" x="' + (at.x + at.width - (c.drill !== null ? 24 : 8)) + '" y="' + (at.y + 26) + '" text-anchor="end">' + esc(tag) + '</text>');
        }
        if (c.drill !== null) {
            const bx = at.x + at.width - 20;
            const by = at.y + 5;
            out.push('<g class="drill" data-drill="' + esc(c.id) + '"><rect x="' + bx + '" y="' + by + '" width="15" height="15" rx="2"/>' +
                '<path d="M' + (bx + 4) + ' ' + (by + 5) + 'L' + (bx + 7.5) + ' ' + (by + 9) + 'L' + (bx + 11) + ' ' + (by + 5) + '"/></g>');
        }
    }
    for (const p of c.pins) {
        const pa = lay.pins.get(p.id);
        if (pa) {
            out.push(renderPin(p, pa, at, isPort));
        }
    }
    out.push('</g>');
    return out.join('');
}

/**
 * @brief Renders the laid-out schematic as an SVG fragment.
 * Wires carry data-w, pins data-p and cells data-c with the model ids; the
 * sel and hov groups are empty overlays for highlighted wire copies.
 */
export function renderSvg(s: Schematic, lay: Layout): string {
    const wires: string[] = [];
    const hits: string[] = [];
    const joints: string[] = [];
    for (const w of s.wires) {
        const g = lay.wires.get(w.id);
        if (!g) {
            continue;
        }
        const cdc = w.nets.some((n) => s.nets.get(n)?.is_cdc);
        const cls = 'wire' + (w.nets.length > 1 || s.pins.get(w.src)?.bus ? ' bus' : '') + (cdc ? ' cdc' : '');
        wires.push('<path class="' + cls + '" data-w="' + esc(w.id) + '" d="' + g.d + '"/>');
        hits.push('<path class="hit" data-w="' + esc(w.id) + '" d="' + g.d + '"/>');
        for (const j of g.junctions) {
            joints.push('<circle class="junction" cx="' + r1(j.x) + '" cy="' + r1(j.y) + '" r="2.6"/>');
        }
    }

    const cells: string[] = [];
    for (const c of s.cells) {
        const at = lay.cells.get(c.id);
        if (at) {
            cells.push(renderCell(c, at, lay));
        }
    }

    return (
        '<g class="wires">' + wires.join('') + '</g>' +
        '<g class="junctions">' + joints.join('') + '</g>' +
        '<g id="sel"></g><g id="hov"></g>' +
        '<g class="hits">' + hits.join('') + '</g>' +
        '<g class="cells">' + cells.join('') + '</g>'
    );
}
