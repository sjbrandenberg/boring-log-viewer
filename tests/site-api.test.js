import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { buildApp, parseSiteQuery } from '../server/app.js';
import { siteBorings, autoSections, siteSummary, siteModel } from '../src/site.js';

const nas = [1, 2, 3, 4].map(i => JSON.parse(readFileSync(new URL(`../examples/NAS-${i}.json`, import.meta.url), 'utf8')));
const at = (lat, lon, name) => ({
    schema_version: '1.0',
    metadata: { boring_name: name, latitude: lat, longitude: lon, elevation: 100 },
    layers: [{ top: 0, bottom: 3, uscs: 'SM', description: 'silty sand' }, { top: 3, bottom: 10, uscs: 'CL', description: 'lean clay' }],
});
// A 3 × 3 grid of borings 50 m apart, and a row of five along a road.
const grid = [];
for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) grid.push(at(34 + i * 0.00045, -118 + j * 0.00055, `G-${i}${j}`));
const row = [0, 1, 2, 3, 4].map(i => at(34 + i * 0.0009, -118 + i * 0.0001, `R-${i}`));

let app;
before(async () => { app = await buildApp({ rateLimitMax: 1000 }); });
after(() => app.close());
const post = (url, body, headers = {}) => app.inject({ method: 'POST', url, payload: typeof body === 'string' ? body : JSON.stringify(body), headers: { 'content-type': typeof body === 'string' ? 'text/plain' : 'application/json', ...headers } });

test('autoSections: along and across a grid site', () => {
    const s = autoSections(siteBorings(grid));
    assert.equal(s[0].kind, 'long');
    assert.ok(s.some(x => x.kind === 'across'));
    for (const x of s) assert.ok(x.borings.length >= 2 && x.line.length >= 2 && x.length > 0);
    assert.deepEqual(s.map(x => x.id), s.map((_, i) => 'ABCDEFGH'[i]));
});

test('autoSections: a row of borings gives one section along it', () => {
    const s = autoSections(siteBorings(row));
    assert.equal(s[0].borings.length, 5);
    assert.ok(!s.some(x => x.kind === 'across'), 'too narrow for a cross-line');
});

test('autoSections: none without two located borings', () => {
    const lone = [at(34, -118, 'A'), { ...at(0, 0, 'B'), metadata: { boring_name: 'B' } }];
    assert.deepEqual(autoSections(siteBorings(lone)), []);
});

test('siteModel: layers from the top, each boring placed', () => {
    const m = siteModel(siteBorings(nas), { grid: 4 });
    assert.equal(m.borings.length, 4);
    assert.equal(m.levels, 'depth');
    assert.ok(m.layers.length >= 2);
    for (const b of m.borings) for (const u of b.units) assert.ok(m.layers[u.layer]);
    assert.equal(m.grid.ground.length, 25);
    assert.equal(m.grid.tops.length, m.layers.length);
    assert.equal(siteModel(siteBorings([nas[0]])), null);
});

test('siteSummary lists borings and sections', () => {
    const s = siteSummary(nas);
    assert.deepEqual(s.borings.map(b => b.name), ['NAS-1', 'NAS-2', 'NAS-3', 'NAS-4']);
    assert.ok(s.sections.length >= 1);
});

test('parseSiteQuery rejects unknown and misplaced parameters', () => {
    assert.equal(parseSiteQuery({ format: 'json' }).problems.length, 0);
    assert.ok(parseSiteQuery({ unit: 'm' }).problems.length);
    assert.ok(parseSiteQuery({ id: 'A' }).problems.length, 'id is for /api/site/section');
    assert.ok(parseSiteQuery({}, true).problems.length, 'a section needs id or line');
    assert.ok(parseSiteQuery({ line: '34,-118' }, true).problems.length);
    assert.deepEqual(parseSiteQuery({ line: '34,-118;34.001,-118' }, true).line, [{ lat: 34, lon: -118 }, { lat: 34.001, lon: -118 }]);
});

test('POST /api/site?format=json: summary, sections with SVG, model', async () => {
    const res = await post('/api/site?format=json&grid=8', { name: 'Nantou', borings: nas });
    assert.equal(res.statusCode, 200);
    const body = res.json();
    assert.equal(body.name, 'Nantou');
    assert.equal(body.borings.length, 4);
    assert.ok(body.sections.length >= 1);
    assert.match(body.sections[0].svg, /^<svg /);
    assert.ok(body.model.layers.length >= 2);
    assert.equal(body.model.grid.nx, 8);
});

test('POST /api/site takes a bare array and can leave out the SVGs', async () => {
    const res = await post('/api/site?format=json&svg=false', grid);
    assert.equal(res.statusCode, 200);
    assert.equal(res.json().sections[0].svg, undefined);
});

test('POST /api/site reports invalid borings by index', async () => {
    const res = await post('/api/site?format=json', { borings: [nas[0], { schema_version: '1.0', metadata: {}, layers: 'x' }] });
    assert.equal(res.statusCode, 422);
    assert.ok(res.json().errors.every(e => e.path.startsWith('/borings/1')));
    assert.equal((await post('/api/site?format=json', { borings: [] })).statusCode, 422);
    assert.equal((await post('/api/site?format=json', { foo: 1 })).statusCode, 400);
    assert.equal((await post('/api/site?format=svg', { borings: nas })).statusCode, 400);
});

test('POST /api/site warns about borings without coordinates', async () => {
    const res = await post('/api/site?format=json', [...row, { ...at(0, 0, 'X'), metadata: { boring_name: 'X' } }]);
    assert.equal(res.statusCode, 200);
    assert.ok(res.json().warnings.some(w => /no coordinates/.test(w.message)));
});

test('POST /api/site accepts an AGS4 file', async () => {
    const ags = readFileSync(new URL('./fixtures/example.ags', import.meta.url), 'utf8');
    const res = await post('/api/site?format=json&name=AGS', ags);
    assert.equal(res.statusCode, 200);
    assert.ok(res.json().borings.length >= 1);
});

test('POST /api/site (HTML) returns the site page with the data embedded', { skip: !existsSync(new URL('../public/site-page.js', import.meta.url)) && 'run npm run build first' }, async () => {
    const res = await post('/api/site', { name: 'Nantou </script>', borings: nas });
    assert.equal(res.statusCode, 200);
    assert.match(res.headers['content-type'], /text\/html/);
    assert.match(res.body, /id="site-data"/);
    assert.ok(!res.body.includes('Nantou </script>'), 'the name cannot end the script element');
});

test('POST /api/site/section by id and by line', async () => {
    const svg = await post('/api/site/section?id=A', { borings: nas });
    assert.equal(svg.statusCode, 200);
    assert.match(svg.headers['content-type'], /image\/svg\+xml/);
    const png = await post('/api/site/section?id=A&format=png&png_scale=1', { borings: nas });
    assert.equal(png.headers['content-type'], 'image/png');
    const line = row.map(d => `${d.metadata.latitude},${d.metadata.longitude}`).filter((_, i) => i % 4 === 0).join(';');
    const json = await post(`/api/site/section?format=json&corridor=20&line=${encodeURIComponent(line)}`, row);
    assert.equal(json.statusCode, 200);
    assert.equal(json.json().borings.length, 5);
    assert.equal((await post('/api/site/section?id=Z', { borings: nas })).statusCode, 404);
    assert.equal((await post('/api/site/section?line=10,10;10.001,10', { borings: nas })).statusCode, 422);
});

test('a site body may be larger than a single log', async () => {
    const big = { borings: Array.from({ length: 40 }, (_, i) => ({ ...nas[i % 4], metadata: { ...nas[i % 4].metadata, boring_name: `B-${i}`, notes: 'x'.repeat(30000) } })) };
    assert.ok(JSON.stringify(big).length > 1024 * 1024);
    const res = await post('/api/site?format=json&svg=false', big);
    assert.notEqual(res.statusCode, 413);
});
