import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { layoutState, layoutFromState, newColumnId, parseCustomValue, customTargets, setCustomValue, clearCustomValues } from '../site/layout-state.js';
import { renderBoringLog, defaultLayout } from '../src/index.js';

const load = name => JSON.parse(readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8'));

test('the Layout window starts from the columns as drawn, with the others unticked in their places', () => {
    const doc = load('coastal-style.json');
    const state = layoutState(doc);
    const shown = state.columns.filter(c => c.show).map(c => c.id);
    assert.deepEqual(shown, defaultLayout(doc).columns.map(c => c.id));
    const energy = state.columns.find(c => c.id === 'energy_ratio');
    assert.equal(energy.show, false);
    assert.equal(energy.hasData, false);
    // Unchanged, it gives a layout that draws the log as before.
    const plain = renderBoringLog(doc, { id_prefix: 't' });
    const laidOut = renderBoringLog({ ...doc, layout: layoutFromState(state) }, { id_prefix: 't' });
    assert.ok(Math.abs(Number(plain.match(/width="(\d+)"/)[1]) - Number(laidOut.match(/width="(\d+)"/)[1])) <= 1);
});

test('changes in the window become the layout', () => {
    const doc = load('coastal-style.json');
    const state = layoutState(doc);
    const col = id => state.columns.find(c => c.id === id);
    col('blow_count').show = false;
    col('description').label = 'Soil';
    col('description').width = 25;
    const id = newColumnId('PP (tsf)', state.columns.map(c => c.id));
    assert.equal(id, 'pp_tsf');
    state.columns.push({ id, show: true, label: 'PP (tsf)', width: 3, builtIn: false, defaultLabel: 'PP (tsf)', source: 'sample', field: id });
    const layout = layoutFromState(state);
    assert.ok(!layout.columns.some(c => c.id === 'blow_count'));
    assert.deepEqual(layout.columns.find(c => c.id === 'description'), { id: 'description', width: 25, label: 'Soil' });
    assert.deepEqual(layout.columns.at(-1), { id: 'pp_tsf', source: 'sample', width: 3, label: 'PP (tsf)' });
    // Its values go into the samples' "custom".
    const [first] = customTargets(doc, 'sample', id);
    assert.equal(first.label, 'S-1 (1.5–1.95)');
    setCustomValue(doc, first, id, parseCustomValue(' 1.5 '));
    assert.deepEqual(doc.samples[0].custom, { pp_tsf: 1.5 });
    const t = [...renderBoringLog({ ...doc, layout }).matchAll(/<text[^>]*>([^<]*)<\/text>/g)].map(m => m[1]).join(' ');
    assert.match(t, /PP \(tsf\)/);
    assert.match(t, / 1\.5 /);
    clearCustomValues(doc, 'sample', id);
    assert.equal(doc.samples[0].custom, undefined);
});

test('specimen targets and typed values', () => {
    const doc = load('coastal-style.json');
    const targets = customTargets(doc, 'specimen', 'cu');
    assert.ok(targets.some(t => t.label === 'T-3 / T-3A (4.7–4.85)'));
    assert.equal(parseCustomValue('45'), 45);
    assert.equal(parseCustomValue('>50'), '>50');
    assert.equal(parseCustomValue('  '), undefined);
    assert.equal(newColumnId('Depth', []), 'depth_2');
    assert.equal(newColumnId('2nd', []), 'col_2nd');
});
