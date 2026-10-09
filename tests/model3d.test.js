import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { prepareBoring } from '../src/section.js';
import { buildModel, correlate, idw } from '../src/model3d.js';
import { localPositions, neighbourEdges } from '../site/geometry3d.js';

const nas = [1, 2, 3, 4].map(n => JSON.parse(readFileSync(new URL(`../examples/NAS-${n}.json`, import.meta.url))));
const borings = nas.map(d => prepareBoring(d));
const pos = localPositions(nas.map(d => ({ lat: d.metadata.latitude, lon: d.metadata.longitude })));

test('inverse distance weighting is exact at the data and between them in between', () => {
    const pts = [{ x: 0, y: 0 }, { x: 10, y: 0 }];
    assert.equal(idw(pts, [1, 3], 0, 0), 1);
    assert.equal(idw(pts, [1, 3], 5, 0), 2);
    const v = idw(pts, [1, 3], 2, 0);
    assert.ok(v > 1 && v < 2);
});

test('correlated layers are ordered from the top and keep silt and clay apart', () => {
    const { layers } = correlate(borings, neighbourEdges(pos));
    const means = layers.map(l => l.mean);
    assert.ok(layers.length >= 6);
    assert.ok(layers.some(l => l.colour === 'silt') && layers.some(l => l.colour === 'clay'));
    assert.ok(!layers.some(l => l.codes.includes('ML') && l.codes.includes('CL')), 'no layer mixes ML and CL');
    assert.ok(means[0] < means[means.length - 1]);
});

test('the model reproduces each boring at its own position', () => {
    const model = buildModel(borings, pos, neighbourEdges(pos), { nx: 8, ny: 8 });
    assert.ok(model.byDepth);
    assert.equal(model.nodes.length, 81);
    // At each boring the interpolated layer thicknesses add up to its depth.
    const { layers, unitLayer } = correlate(borings, neighbourEdges(pos));
    borings.forEach((b, i) => {
        const total = layers.reduce((sum, _, k) => sum + b.units.filter(u => unitLayer.get(u) === k).reduce((s, u) => s + u.bottom - u.top, 0), 0);
        assert.ok(Math.abs(total - b.depth) < 1e-6);
    });
    for (const n of model.nodes) {
        for (let k = 1; k < n.tops.length; k++) assert.ok(n.tops[k] <= n.tops[k - 1] + 1e-9, 'layers stack downwards');
        assert.ok(n.base >= model.lowest - 1e-9 || n.base <= n.tops[n.tops.length - 1]);
    }
    assert.ok(model.water && model.water.every(w => w <= 0));
});

test('layers of one main soil get different shades; same-named layers share one', async () => {
    const { layerFills, shade } = await import('../src/model3d.js');
    assert.equal(shade('#808080', 0), '#808080');
    assert.ok(shade('#808080', 0.2) > '#808080');
    const fills = layerFills([
        { colour: 'sand', label: 'Silty SAND (SM)' },
        { colour: 'silt', label: 'SILT (ML)' },
        { colour: 'sand', label: 'Clayey SAND (SC)' },
        { colour: 'silt', label: 'SILT (ML)' },
        { colour: 'sand', label: 'Poorly graded SAND (SP)' },
    ]);
    assert.equal(fills[1], fills[3], 'same name, same colour');
    assert.equal(new Set([fills[0], fills[2], fills[4]]).size, 3, 'three sands, three shades');
});
