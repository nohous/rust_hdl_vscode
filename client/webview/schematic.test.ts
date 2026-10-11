/* ------------------------------------------------------------------------------------------
 * MIT License
 * ------------------------------------------------------------------------------------------ */
// Checks for the schematic model. Run with: npm run test-webview

import * as assert from 'assert';
import { buildSchematic, busLabel, DataFlow, DfEndpoint, generateTag, groupByPrefix, netIds } from './schematic';

function ep(cell: string, port: string, direction: DfEndpoint['direction']): DfEndpoint {
    return { kind: 'instance', cell_id: cell, port, part: null, direction, source_pos: null };
}

function inst(id: string): DataFlow['instances'][number] {
    return {
        id,
        label: id,
        entity_path: 'lib.' + id,
        component: null,
        instance_pos: null,
        entity_pos: null,
        ports: [],
        clocks: ['clk'],
        generate: [],
    };
}

// ---- Prefix grouping -------------------------------------------------------

{
    const g = groupByPrefix(['ACQ_COUNT_I', 'ACQ_START_I', 'ACQ_STOP_I', 'ACQ_X', 'MODE_I'], 3);
    assert.strictEqual(g.get('ACQ_COUNT_I'), 'acq_');
    assert.strictEqual(g.get('ACQ_X'), 'acq_');
    assert.strictEqual(g.has('MODE_I'), false);
    assert.strictEqual(groupByPrefix(['A_B_1', 'A_B_2', 'A_C'], 3).get('A_B_1'), 'a_');
    assert.strictEqual(groupByPrefix(['A_B_1', 'A_B_2', 'A_C'], 2).get('A_B_1'), 'a_b_');
    assert.strictEqual(busLabel(['ACQ_COUNT_I', 'ACQ_START_I', 'ACQ_STOP_I'], 4), 'ACQ_*_I');
    assert.strictEqual(busLabel(['ACQ_COUNT_I', 'ACQ_START_O'], 4), 'ACQ_*');
}

// ---- Net keys --------------------------------------------------------------

{
    const df = { nets: [{ name: '<expr>' }, { name: 'a' }, { name: '<expr>' }] } as DataFlow;
    assert.deepStrictEqual(netIds(df), ['<expr>', 'a', '<expr>#1']);
}

// ---- Buses and wires -------------------------------------------------------

{
    const df: DataFlow = {
        entity_path: 'lib.top',
        architecture: 'rtl',
        entity_pos: null,
        external_ports: [],
        instances: [inst('u_src'), inst('u_dst')],
        processes: [],
        nets: [
            ...['a', 'b', 'c'].map((n) => ({
                name: 'n_' + n,
                kind: 'signal' as const,
                endpoints: [ep('u_src', 'X_' + n + '_O', 'out'), ep('u_dst', 'Y_' + n + '_I', 'in')],
                clock_domain: null,
                is_cdc: false,
            })),
            {
                name: 'clk',
                kind: 'signal',
                endpoints: [ep('u_src', 'X_clk_O', 'out'), ep('u_dst', 'Y_clk_I', 'in')],
                clock_domain: null,
                is_cdc: false,
            },
            {
                name: '<expr>',
                kind: 'opaque',
                endpoints: [ep('u_dst', 'TIE', 'in')],
                clock_domain: null,
                is_cdc: false,
            },
            {
                name: 'ghost',
                kind: 'unresolved',
                endpoints: [ep('u_dst', 'LOST', 'in')],
                clock_domain: null,
                is_cdc: false,
            },
        ],
    };

    const grouped = buildSchematic(df, { processes: true, buses: true, minBus: 3, ungrouped: new Set() });
    const bus = grouped.wires.find((w) => w.nets.length === 3);
    assert.ok(bus, 'three prefix-sharing nets travel as one wire');
    assert.strictEqual(grouped.pins.get(bus.src)?.label, 'X_*_O');
    assert.strictEqual(grouped.pins.get(bus.dst)?.label, 'Y_*_I');
    assert.strictEqual(grouped.wires.length, 2, 'bus plus the clock, which never joins a bus');
    const tie = [...grouped.pins.values()].find((p) => p.members.includes('TIE'));
    assert.strictEqual(tie?.side, 'W', 'an input with no driver stays an input');
    assert.strictEqual(tie?.bus, false);
    assert.strictEqual(tie?.tie, '<expr>', 'an opaque actual is a tie-off, not a net');
    assert.strictEqual(tie?.nets.length, 0);
    assert.strictEqual(tie?.dangling, false);
    const lost = [...grouped.pins.values()].find((p) => p.members.includes('LOST'));
    assert.strictEqual(lost?.unresolved, 'ghost');
    assert.strictEqual(lost?.nets.length, 0);

    const group = grouped.pins.get(bus.src)?.group as string;
    const expanded = buildSchematic(df, { processes: true, buses: true, minBus: 3, ungrouped: new Set([group]) });
    assert.strictEqual(expanded.wires.length, 4, 'expanded source side fans out from single pins');
    assert.ok(expanded.wires.every((w) => w.nets.length === 1));

    const flat = buildSchematic(df, { processes: true, buses: false, minBus: 3, ungrouped: new Set() });
    assert.strictEqual(flat.wires.length, 4);
}

// ---- Sub-element endpoints share the base net ------------------------------

{
    const part = (cell: string, port: string, direction: DfEndpoint['direction'], p: string): DfEndpoint => ({ ...ep(cell, port, direction), part: p });
    const df: DataFlow = {
        entity_path: 'lib.top',
        architecture: 'rtl',
        entity_pos: null,
        external_ports: [],
        instances: [inst('u_a'), inst('u_b')],
        processes: [],
        nets: [
            {
                name: 'credits',
                kind: 'signal',
                endpoints: [part('u_a', 'credits', 'out', '(i * 24 + 23 downto i * 24)'), part('u_b', 'up_credits', 'in', '(23 downto 0)')],
                clock_domain: null,
                is_cdc: false,
            },
        ],
    };
    const s = buildSchematic(df, { processes: true, buses: true, minBus: 3, ungrouped: new Set() });
    assert.strictEqual(s.wires.length, 1);
    const dst = s.pins.get(s.wires[0].dst);
    assert.strictEqual(dst?.parts['credits'], '(23 downto 0)');
    assert.strictEqual(dst?.dangling, false);
    assert.strictEqual(generateTag([{ kind: 'for', label: 'G', index: 'i', range: '0 to N - 1' }, { kind: 'if', label: null, condition: null }]), 'x 0 to N - 1 / else');
}

console.log('schematic checks passed');
