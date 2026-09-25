import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { diggsToBoringLogs, parseXml, looksLikeDiggs, looksLikeAgs, DiggsError, validateBoringLog, renderBoringLog } from '../src/index.js';

const DIGGS = readFileSync(new URL('./fixtures/example.diggs.xml', import.meta.url), 'utf8');

test('the XML reader handles namespaces, comments, CDATA and entities', () => {
    const root = parseXml(DIGGS);
    assert.equal(root.name, 'Diggs');
    const project = root.children.find(c => c.name === 'project').children[0];
    assert.equal(project.children[0].qname, 'gml:name');
    assert.equal(project.children[0].text, 'Levee Upgrade & Crossing (synthetic example)');
    assert.ok(looksLikeDiggs(DIGGS));
    assert.ok(!looksLikeAgs(DIGGS));
    assert.ok(!looksLikeDiggs('<svg/>'));
    assert.throws(() => parseXml('<a><b></a>'), /doesn't match/);
    assert.throws(() => parseXml('<a>'), /never closed/);
});

test('each borehole becomes a document; one without strata is reported', () => {
    const { documents, warnings } = diggsToBoringLogs(DIGGS);
    assert.deepEqual(documents.map(d => d.loca_id), ['B-1', 'B-2']);
    assert.deepEqual(validateBoringLog(documents[0].document).errors, []);
    assert.equal(documents[1].document.units.length, 'm', 'depth units from the lrm link');
    assert.match(warnings.join('\n'), /B-2: no strata/);
});

test('borehole metadata comes from the location, dates, roles and construction method', () => {
    const doc = diggsToBoringLogs(DIGGS).documents[0].document;
    assert.deepEqual(doc.units, { length: 'ft', unit_weight: 'pcf', diameter: 'in' });
    assert.deepEqual(doc.metadata, {
        project: 'Levee Upgrade & Crossing (synthetic example)', boring_name: 'B-1', latitude: 38.25, longitude: -121.5, elevation: 12.5,
        start_date: '2024-05-01', end_date: '2024-05-02', boring_type: 'Hollow-stem auger', rig: 'CME 75',
        logged_by: 'A. Logger', driller: 'Example Drilling Co.', notes: 'Hole backfilled with grout <after> completion',
    });
    assert.deepEqual(doc.groundwater, [{ depth: 8.5, note: 'During drilling' }]);
});

test('strata: descriptions, composed descriptions, USCS-only strata and missing bases', () => {
    const { layers, depth_notes } = diggsToBoringLogs(DIGGS).documents[0].document;
    // An observation at one depth inside a stratum is a depth note
    assert.deepEqual(depth_notes, [{ depth: 3, description: '@ 3 ft: shell fragments' }]);
    assert.deepEqual(layers, [
        { top: 0, bottom: 6, description: 'Stiff brown lean CLAY with sand, moist', uscs: 'CL' },
        { top: 6, bottom: 20, description: 'Medium dense, gray SAND, trace silt, wet' },
        { top: 20, bottom: 30, uscs: 'GP' },   // top only: runs to the total depth
    ]);
});

test('samples get their sampler type, recovery, SPT drive sets and lab results', () => {
    const { samples } = diggsToBoringLogs(DIGGS).documents[0].document;
    assert.deepEqual(samples, [
        // "38 19" separated by ts, not cs, is still read as LL and PL; dry density 101.2 pcf
        { top: 3, bottom: 5, name: 'T-2', type: 'Shelby', liquid_limit: 38, plastic_limit: 19, water_content: 24.5, dry_unit_weight: 101.2, uscs: 'CL' },
        { top: 10, bottom: 11.5, name: 'S-1', type: 'SPT', recovery: 1, blow_count: 14, blows: [4, 6, 8] },
    ]);
});

test('an imported DIGGS log renders', () => {
    const svg = renderBoringLog(diggsToBoringLogs(DIGGS).documents[0].document, { id_prefix: 't' });
    assert.match(svg, /fill="url\(#t-CL\)"/);
    assert.match(svg, /Hollow-stem auger/);
});

test('files that are not DIGGS are rejected with a reason', () => {
    assert.throws(() => diggsToBoringLogs('<svg xmlns="http://www.w3.org/2000/svg"/>'), /not a DIGGS file/);
    assert.throws(() => diggsToBoringLogs('<Diggs><samplingFeature/></Diggs>'), /no Borehole/);
    assert.throws(() => diggsToBoringLogs('<Diggs><x></Diggs>'), DiggsError);
});
