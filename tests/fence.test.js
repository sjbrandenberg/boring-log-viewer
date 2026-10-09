import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fenceEdges, localPositions } from '../site/fence.js';
import { renderSection } from '../src/section.js';

const nas = [1, 2, 3, 4].map(n => JSON.parse(readFileSync(new URL(`../examples/NAS-${n}.json`, import.meta.url))));
const sites = nas.map(doc => ({ name: doc.metadata.boring_name, lat: doc.metadata.latitude, lon: doc.metadata.longitude, doc }));

test('borings are placed in metres around their mean position', () => {
    const pos = localPositions(sites);
    const mean = pos.reduce((s, p) => ({ x: s.x + p.x / pos.length, y: s.y + p.y / pos.length }), { x: 0, y: 0 });
    assert.ok(Math.abs(mean.x) < 1e-6 && Math.abs(mean.y) < 1e-6);
    // NAS-1 is east of NAS-4 by about 890 m.
    assert.ok(Math.abs(pos[0].x - pos[3].x - 890) < 30);
});

test('panels join neighbouring borings, not distant ones', () => {
    const pos = localPositions(sites);
    const edges = fenceEdges(pos);
    const has = (a, b) => edges.some(([i, j]) => (i === a && j === b) || (i === b && j === a));
    assert.ok(has(1, 2), 'NAS-2 to NAS-3');
    assert.ok(has(2, 3), 'NAS-3 to NAS-4');
    assert.ok(edges.length >= 3 && edges.length <= 5);
    assert.deepEqual(fenceEdges(pos.slice(0, 2)), [[0, 1]]);
    // Borings in a line are joined in order.
    assert.deepEqual(fenceEdges([{ x: 0, y: 0 }, { x: 20, y: 0 }, { x: 10, y: 0 }]).map(e => e.slice().sort()).sort(), [[0, 2], [1, 2]]);
});

test('a panel is just the space between two borings, at the size asked for', () => {
    const { svg, colours } = renderSection([{ doc: nas[1], chainage: 0 }, { doc: nas[2], chainage: 70 }], { panel: { width: 600, height: 300, top: 0, bottom: 20 }, id_prefix: 'p' });
    assert.match(svg, /^<svg[^>]* width="600" height="300"/);
    assert.doesNotMatch(svg, /Legend|Distance along|Cross-section/);
    assert.ok(colours.includes('sand') && colours.includes('clay'));
});
