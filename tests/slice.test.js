import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { prepareBoring, MAX_SECTION_LENGTH } from '../src/section.js';
import { buildModel } from '../src/model3d.js';
import { modelAt, clipToBox, sliceProfile, renderSlice, boringsNearSlice } from '../src/slice.js';
import { localPositions, neighbourEdges } from '../site/geometry3d.js';
import { parseSiteQuery } from '../server/app.js';

const nas = [1, 2, 3, 4].map(n => JSON.parse(readFileSync(new URL(`../examples/NAS-${n}.json`, import.meta.url))));
const borings = nas.map(d => ({ ...prepareBoring(d), name: d.metadata.boring_name }));
const pos = localPositions(nas.map(d => ({ lat: d.metadata.latitude, lon: d.metadata.longitude })));
const model = buildModel(borings, pos, neighbourEdges(pos), { nx: 24, ny: 24 });

test('the model at a grid node is that node, and in between it is in between', () => {
    const n = model.nodes[5 * 25 + 7];
    const at = modelAt(model, n.x, n.y);
    assert.ok(Math.abs(at.ground - n.ground) < 1e-9);
    at.tops.forEach((t, k) => assert.ok(Math.abs(t - n.tops[k]) < 1e-9));
    const m = model.nodes[5 * 25 + 8];
    const mid = modelAt(model, (n.x + m.x) / 2, n.y);
    assert.ok(Math.abs(mid.base - (n.base + m.base) / 2) < 1e-9);
});

test('a line is clipped to the box', () => {
    const box = { x0: 0, x1: 10, y0: 0, y1: 10 };
    assert.deepEqual(clipToBox(box, { x: -5, y: 5 }, { x: 15, y: 5 }), [{ x: 0, y: 5 }, { x: 10, y: 5 }]);
    assert.equal(clipToBox(box, { x: -5, y: 20 }, { x: 15, y: 20 }), null);
});

test('a slice is drawn with its layers and the borings near it', () => {
    // From NAS-2 to NAS-4.
    const a = pos[1];
    const b = pos[3];
    const { points, length } = sliceProfile(model, a, b, 10);
    assert.equal(points.length, 11);
    assert.ok(Math.abs(length - Math.hypot(b.x - a.x, b.y - a.y)) < 1e-9);
    const near = boringsNearSlice(pos.map((p, i) => ({ name: borings[i].name, ...p })), a, b, 30);
    assert.deepEqual(near.map(bo => bo.name), ['NAS-2', 'NAS-4']);
    assert.ok(Math.abs(near[1].s - length) < 1e-6);
    // NAS-3 is off the line; a wider corridor takes it in, at its place along the line.
    assert.deepEqual(boringsNearSlice(pos.map((p, i) => ({ name: borings[i].name, ...p })), a, b, 1000).map(bo => bo.name), ['NAS-2', 'NAS-3', 'NAS-4']);
    const slim = pos.map((p, i) => ({ name: borings[i].name, x: p.x, y: p.y, ground: 0, segments: [{ top: 0, bottom: -borings[i].depth, fill: '#ccc' }] }));
    const { svg, borings: shown } = renderSlice(model, a, b, { borings: slim, corridor: 30 });
    assert.deepEqual(shown, ['NAS-2', 'NAS-4']);
    assert.match(svg, /^<svg[^>]* width="900"/);
    assert.match(svg, /Slice A–A′/);
    assert.match(svg, /Distance along the slice \(m\)/);
    assert.match(svg, /Not explored/);
    for (const l of model.layers.slice(0, 2)) assert.ok(svg.includes(`fill="${l.fill}"`));
});

test('section lines longer than 10 km are refused by the API', () => {
    assert.equal(MAX_SECTION_LENGTH, 10000);
    // About 11 km north.
    const long = parseSiteQuery({ line: '34.0,-118.0;34.1,-118.0' }, true);
    assert.ok(long.problems.some(p => p.path === '?line' && /at most 10 km/.test(p.message)));
    const ok = parseSiteQuery({ line: '34.0,-118.0;34.05,-118.0' }, true);
    assert.ok(!ok.problems.some(p => p.path === '?line'));
});
