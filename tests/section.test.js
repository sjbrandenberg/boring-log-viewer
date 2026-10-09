import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { placeAlongLine, matchUnits, boringUnits, soilClass, renderSection, lineLength } from '../src/section.js';
import { validateBoringLog } from '../src/validate.js';

const nas = [1, 2, 3, 4].map(n => JSON.parse(readFileSync(new URL(`../examples/NAS-${n}.json`, import.meta.url))));
const points = nas.map(doc => ({ doc, name: doc.metadata.boring_name, lat: doc.metadata.latitude, lon: doc.metadata.longitude }));
const line = [{ lat: 23.9109, lon: 120.6942 }, { lat: 23.9083, lon: 120.6852 }];

test('borings are placed along the line by distance, within the corridor', () => {
    assert.ok(Math.abs(lineLength(line) - 960) < 15);
    const placed = placeAlongLine(points, line, 100);
    assert.deepEqual(placed.map(p => p.name), ['NAS-1', 'NAS-2', 'NAS-3', 'NAS-4']);
    for (let i = 1; i < placed.length; i++) assert.ok(placed[i].chainage > placed[i - 1].chainage);
    assert.ok(placed.every(p => p.offset <= 100));
    assert.deepEqual(placeAlongLine(points, line, 30).map(p => p.name), ['NAS-1', 'NAS-4']);
    // Points past the ends of the line are left out.
    assert.deepEqual(placeAlongLine(points, [line[0], { lat: 23.9100, lon: 120.6911 }], 300).map(p => p.name), ['NAS-1']);
    assert.deepEqual(placeAlongLine(points, [line[0]], 100), []);
});

test('layers are classed by main soil or material', () => {
    assert.deepEqual(soilClass('SP-SM'), ['sand', 'sand']);
    assert.deepEqual(soilClass('CL'), ['clay']);
    assert.deepEqual(soilClass('ML'), ['silt']);
    assert.deepEqual(soilClass('CL-ML'), ['clay']);
    assert.deepEqual(soilClass('ML-CL'), ['clay']);
    assert.deepEqual(soilClass('GP'), ['gravel']);
    assert.deepEqual(soilClass('PT'), ['organic']);
    assert.deepEqual(soilClass('FILL_HYD'), ['fill']);
    assert.deepEqual(soilClass('CONCRETE'), ['pavement']);
    assert.deepEqual(soilClass('SANDSTONE'), ['rock']);
    assert.equal(soilClass('NO_RECOVERY'), null);
    assert.equal(soilClass('XYZ'), null);
});

const units = list => boringUnits(list.map(([top, bottom, code]) => ({ top, bottom, codes: [code] })));

test('consecutive layers of the same main soil form one unit', () => {
    const u = units([[0, 1, 'FILL'], [1, 3, 'ML'], [3, 4, 'MH'], [4, 5, 'CL'], [5, 6, 'SM'], [6, 9, 'SP']]);
    assert.deepEqual(u.map(x => [x.top, x.bottom, x.code]), [[0, 1, 'FILL'], [1, 4, 'ML'], [4, 5, 'CL'], [5, 9, 'SP']]);
});

test('units connect only to the same main soil, without crossing, preferring similar depths', () => {
    const a = units([[0, 1, 'FILL'], [1, 5, 'CL'], [5, 9, 'SP']]);
    const b = units([[0, 2, 'SM'], [2, 6, 'CH'], [6, 10, 'SW']]);
    // FILL has no partner; clay to clay and sand to sand. The top sand of b
    // can't also take a's sand without crossing the clay link.
    assert.deepEqual(matchUnits(a, b), [[1, 1], [2, 2]]);
    const c = units([[0, 4, 'GP']]);
    assert.deepEqual(matchUnits(a, c), [], 'gravel never connects to sand or clay');
    // Two sands in b: the one at a similar depth is chosen.
    const d = units([[0, 1, 'SM'], [1, 4, 'GP'], [4, 9, 'SP']]);
    assert.deepEqual(matchUnits(units([[4, 9, 'SP']]), d), [[0, 2]]);
});

test('the Nantou section is drawn with every boring, pinch-outs and a legend', () => {
    const { svg, warnings } = renderSection(placeAlongLine(points, line, 100), { id_prefix: 't', style: 'hatch' });
    assert.deepEqual(warnings, []);
    for (const name of ['NAS-1', 'NAS-2', 'NAS-3', 'NAS-4', 'Cross-section A–A′', 'Distance along the line (m)', 'Depth (m)', 'Legend', 'ML – Silt']) {
        assert.ok(svg.includes(name), name);
    }
    assert.match(svg, /stroke-dasharray="2 2"/, 'unmatched units pinch out');
    assert.match(svg, /Vertical exaggeration ×\d+/);
    assert.doesNotMatch(svg, /NaN|undefined/);
});

test('with ground elevations everywhere the section is drawn by elevation, in the chosen units', () => {
    const withElev = points.slice(0, 2).map((p, i) => ({ ...p, doc: { ...p.doc, metadata: { ...p.doc.metadata, elevation: 10 + i } } }));
    for (const p of withElev) assert.equal(validateBoringLog(p.doc).valid, true);
    const { svg } = renderSection(placeAlongLine(withElev, line, 100), { units: 'ft' });
    assert.match(svg, /Elevation \(ft\)/);
    assert.match(svg, /Distance along the line \(ft\)/);
    const mixed = renderSection(placeAlongLine([withElev[0], points[1]], line, 100));
    assert.match(mixed.warnings[0], /drawn by depth/);
});

test('boundaries are curves, uncertain parts are marked and the water table is joined', () => {
    const { svg } = renderSection(placeAlongLine(points, line, 100), { id_prefix: 't' });
    assert.match(svg, /<path d="M[\d.]+ [\d.]+C/, 'cubic curves');
    assert.match(svg, />\?<\/text>/, 'question marks');
    assert.match(svg, /stroke="#1f5fa8" stroke-width="1.4" stroke-dasharray="6 3"/, 'water table curve');
    assert.match(svg, /Uncertain: a layer that pinches out/);
    assert.doesNotMatch(svg, /<polygon/);
});

test('the section runs from A to A′ when the line length is given', () => {
    const placed = placeAlongLine(points, line, 100);
    const { svg } = renderSection(placed, { id_prefix: 't', length: lineLength(line), style: 'hatch' });
    // The distance axis starts at 0 and the outer borings' layers reach the frame edges.
    assert.match(svg, />0<\/text>/);
    assert.match(svg, /<path d="M64 [\d.]+L[\d.]+ [\d.]+L[\d.]+ [\d.]+L64 [\d.]+Z" fill="url\(#t-/);
});

test('unmatched units fill the space between connections, leaving no gap', async () => {
    // A: sand over clay; B: sand, gravel (no partner), clay. The gravel must
    // span from the sand connection down to the clay connection everywhere.
    const doc = (name, layers, lon) => ({ schema_version: '1.0', metadata: { boring_name: name, latitude: 0.001, longitude: lon }, layers });
    const a = doc('A', [{ top: 0, bottom: 2, uscs: 'SP' }, { top: 2, bottom: 6, uscs: 'CL' }], 0.001);
    const b = doc('B', [{ top: 0, bottom: 2, uscs: 'SP' }, { top: 2, bottom: 3, uscs: 'GP' }, { top: 3, bottom: 6, uscs: 'CL' }], 0.002);
    const { svg } = renderSection([{ doc: a, chainage: 0 }, { doc: b, chainage: 100 }], { id_prefix: 't', style: 'hatch' });
    // The gravel's polygon starts on the sand-clay boundary at A (a zero-thickness edge).
    const gp = [...svg.matchAll(/<path d="M([^"]+)Z" fill="url\(#t-GP\)"/g)].map(m => m[1]);
    assert.ok(gp.length >= 1);
    const pts = gp[0].split('L').map(p => p.trim().split(' ').map(Number));
    const first = pts[0];
    const last = pts[pts.length - 1];
    assert.ok(Math.abs(first[1] - last[1]) < 0.01, 'zero thickness where it thins out');
});

test('a unit of several layers of one main soil shows each layer in its own hatch', () => {
    // NAS-2 has SC over SM (both sand): both hatches appear between the borings.
    const placed = placeAlongLine(points, line, 100).filter(p => ['NAS-1', 'NAS-2'].includes(p.name));
    const { svg } = renderSection(placed, { id_prefix: 't', style: 'hatch' });
    const between = [...svg.matchAll(/<path d="M[^"]+Z" fill="url\(#t-(SC|SM)\)"/g)].map(m => m[1]);
    assert.ok(between.includes('SC') && between.includes('SM'));
});

test('by default layers between borings are coloured by main soil and labelled', async () => {
    const { unitLabel, colourClass, SECTION_COLOURS } = await import('../src/section.js');
    assert.equal(unitLabel(['SC', 'SM']), 'Clayey and silty SAND (SC, SM)');
    assert.equal(unitLabel(['ML', 'CL']), 'SILT and lean CLAY (ML, CL)');
    assert.equal(unitLabel(['SM', 'SC', 'SP-SM']), 'Silty, clayey and poorly graded SAND (SM, SC, SP-SM)');
    assert.equal(unitLabel(['FILL']), 'Fill');
    assert.equal(colourClass('ML'), 'silt');
    assert.equal(colourClass('CL'), 'clay');
    assert.equal(colourClass('SP-SM'), 'sand');
    assert.equal(colourClass('SANDSTONE'), 'rock');
    assert.equal(colourClass('NO_RECOVERY'), null);
    const { svg } = renderSection(placeAlongLine(points, line, 100), { id_prefix: 't', length: lineLength(line) });
    for (const key of ['sand', 'silt', 'clay', 'fill']) assert.ok(svg.includes(SECTION_COLOURS[key].fill), key);
    assert.match(svg, /SILT/);
    assert.match(svg, /CLAY/);
    assert.match(svg, /Between borings/);
    assert.match(svg, /Borings \(USCS and material hatches\)/);
    // The boring columns keep their hatches.
    assert.match(svg, /<rect [^>]*fill="url\(#t-ML\)"/);
});

test('silt never connects to plain clay; CL connects to CH; CL-ML is a clay that also joins silt', () => {
    assert.deepEqual(matchUnits(units([[0, 4, 'ML']]), units([[0, 4, 'CL']])), []);
    assert.deepEqual(matchUnits(units([[0, 4, 'CL']]), units([[0, 4, 'CH']])), [[0, 0]]);
    assert.deepEqual(matchUnits(units([[0, 4, 'ML']]), units([[0, 4, 'CL-ML']])), [[0, 0]]);
    assert.deepEqual(matchUnits(units([[0, 4, 'CL-ML']]), units([[0, 4, 'ML']])), [[0, 0]]);
    assert.deepEqual(matchUnits(units([[0, 2, 'CL-ML'], [2, 4, 'CL']]), units([[0, 4, 'ML']])), [[0, 0]], 'a clay unit holding CL-ML joins silt');
    assert.deepEqual(matchUnits(units([[0, 4, 'CH']]), units([[0, 4, 'CL-ML']])), [[0, 0]]);
});

test('a value that is not a USCS symbol is replaced by our guess, marked * and listed', async () => {
    const { unitLabel } = await import('../src/section.js');
    assert.equal(unitLabel(['CL-ML', 'CL']), 'Silty and lean CLAY (CL-ML, CL)');
    assert.equal(unitLabel(['SM'], new Set(['SM'])), 'Silty SAND (SM*)');
    const { svg } = renderSection(placeAlongLine(points, line, 100), { id_prefix: 't', length: lineLength(line) });
    const words = svg.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
    assert.match(words, /\* Guessed symbols: .*NAS-3 7\.2–8\.4 m: GP-GW → SM \(read from the description\)/);
    assert.match(words, /NAS-4 1\.5–3\.0 m: SM-ML → SM \(its first symbol\)/);
    assert.match(svg, /SM\*/);
    assert.doesNotMatch(svg, /GP-GW –|fill="url\(#t-GW\)"/, 'no GW hatch from the impossible GP-GW');
});

test('a layer under a heading is classed by the text after it, so it connects to its neighbours', () => {
    // NAS-2 17.1-18.5 m has no USCS: "GRAVEL AND SAND: ... very dense silty sand with gravels" is SM,
    // like NAS-3 at the same depth, so the two connect.
    const placed = placeAlongLine(points, line, 100).filter(p => ['NAS-2', 'NAS-3'].includes(p.name));
    const { svg } = renderSection(placed, { id_prefix: 't' });
    assert.doesNotMatch(svg, /GRAVEL \(GM\)/);
    assert.doesNotMatch(svg, /fill="url\(#t-GM\)"/);
});

test('lineBearing and compassPoint give the direction of a section', async () => {
    const { lineBearing, compassPoint } = await import('../src/section.js');
    assert.equal(Math.round(lineBearing([{ lat: 34, lon: -118 }, { lat: 34.01, lon: -118 }])), 0);
    assert.equal(Math.round(lineBearing([{ lat: 34, lon: -118 }, { lat: 34, lon: -117.99 }])), 90);
    assert.equal(compassPoint(73), 'ENE');
    assert.equal(compassPoint(253), 'WSW');
    assert.equal(lineBearing([{ lat: 34, lon: -118 }]), null);
});

test('a section shows its letter and the direction of each end', () => {
    const { svg } = renderSection(placeAlongLine(points, line, 100), { id_prefix: 't', length: lineLength(line), id: 'B', bearing: 90 });
    assert.match(svg, />B</);
    assert.match(svg, />B′</);
    assert.match(svg, />← W</);
    assert.match(svg, />E →</);
});

test('without ground elevations a disclaimer says the boundaries between borings are uncertain', () => {
    const { svg } = renderSection(placeAlongLine(points, line, 100), { id_prefix: 't', length: lineLength(line) });
    assert.match(svg, /No ground elevations are given/);
    const withElev = points.map((p, i) => ({ ...p, doc: { ...p.doc, metadata: { ...p.doc.metadata, elevation: 100 + i } } }));
    assert.doesNotMatch(renderSection(placeAlongLine(withElev, line, 100), { id_prefix: 't', length: lineLength(line) }).svg, /No ground elevations are given/);
});
