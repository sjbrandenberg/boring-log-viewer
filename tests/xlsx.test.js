import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { xlsxToBoringLog, workbookToBoringLog, looksLikeXlsx, XlsxError, validateBoringLog } from '../src/index.js';

const file = p => readFileSync(new URL(p, import.meta.url));
const json = p => JSON.parse(file(p));

test('the filled-in template converts back to the JSON it was made from', async () => {
    const { document, warnings } = await xlsxToBoringLog(file('../site/templates/NAS-1.xlsx'));
    assert.deepEqual(warnings, []);
    assert.deepEqual(document, json('../examples/NAS-1.json'));
});

test('the instruction rows, README and explanation column are optional', async () => {
    const { document, warnings } = await xlsxToBoringLog(file('fixtures/nas1-bare.xlsx'));
    assert.deepEqual(warnings, []);
    assert.deepEqual(document, json('../examples/NAS-1.json'));
});

test('specimens, custom values, units and booleans survive the round trip', async () => {
    const { document } = await xlsxToBoringLog(file('fixtures/coastal-style.xlsx'));
    const expected = json('fixtures/coastal-style.json');
    delete expected.metadata.notes; // null in the JSON, an empty cell in Excel
    assert.deepEqual(document, expected);
    assert.equal(validateBoringLog(document).valid, true);
});

test('the B-3 example workbook offered on the page is the coastal example', async () => {
    const { document, warnings } = await xlsxToBoringLog(file('../site/templates/B-3-example.xlsx'));
    const expected = json('fixtures/coastal-style.json');
    delete expected.metadata.notes;
    assert.deepEqual(warnings, []);
    assert.deepEqual(document, expected);
});

test('the empty template reads without errors and asks for layers', async () => {
    const { document, warnings } = await xlsxToBoringLog(file('../site/templates/boring-log-template.xlsx'));
    assert.deepEqual(document, { schema_version: '1.0', layers: [] });
    assert.deepEqual(warnings, ['the Layers sheet has no layers; a log needs at least one']);
});

test('a hand-made workbook: other sheet names, header spellings, units in headers, Excel dates', async () => {
    const { document: d, warnings } = await xlsxToBoringLog(file('fixtures/messy.xlsx'));
    assert.deepEqual(d.units, { length: 'ft', unit_weight: 'pcf' });
    assert.deepEqual(d.metadata, { boring_name: 'B-7', start_date: '2023-03-14', latitude: 34.07, elevation: 102.5 });
    assert.deepEqual(d.layers.map(l => [l.top, l.bottom, l.uscs]), [[0, 4.5, 'SM'], [4.5, 12, 'CL']]);
    assert.deepEqual(d.groundwater, [{ depth: 7.5, date: '2023-03-15', note: 'stabilized' }]);
    const [s1, s2] = d.samples;
    assert.equal(s1.blow_count, '50/3in');
    assert.deepEqual(s1.blows, [6, 8, 10]);
    assert.deepEqual(s1.custom, { cu: 45 });
    assert.deepEqual(s1.specimens, [{ top: 2.1, nonplastic: true }]); // linked by depth
    assert.equal(s2.specimens[0].liquid_limit, 45);
    assert.deepEqual(d.layout.columns.slice(0, 3), ['depth', 'graphic', 'description']);
    assert.equal(d.layout.columns[3].source, 'sample');
    assert.ok(warnings.some(w => w.includes('strata!B7')));
    assert.ok(warnings.some(w => w.includes('"Bad col!"')));
    assert.ok(warnings.some(w => w.includes('no sample contains depth 30')));
    assert.ok(warnings.some(w => w.includes('"Notes for me"')));
    assert.equal(validateBoringLog(d).valid, true);
});

test('workbookToBoringLog finds the header below any number of other rows', () => {
    const rows = [['Layers'], ['some help'], ['Depth to top', 'Depth to bottom'], ['top', 'bottom', 'description'], [0, 2, 'Sand'], [], [2, 5, 'Clay']];
    const { document, warnings } = workbookToBoringLog({ sheets: [{ name: 'Layers', rows }] });
    assert.deepEqual(warnings, []);
    assert.deepEqual(document.layers, [{ top: 0, bottom: 2, description: 'Sand' }, { top: 2, bottom: 5, description: 'Clay' }]);
});

test('specimens with an unknown sample name are reported', () => {
    const sheets = [
        { name: 'Layers', rows: [['top', 'bottom'], [0, 5]] },
        { name: 'Samples', rows: [['name', 'top', 'bottom'], ['S-1', 1, 2]] },
        { name: 'Specimens', rows: [['sample_name', 'water_content'], ['S-9', 20], ['S-1', 25]] },
    ];
    const { document, warnings } = workbookToBoringLog({ sheets });
    assert.deepEqual(document.samples[0].specimens, [{ water_content: 25 }]);
    assert.match(warnings[0], /no sample named "S-9"/);
});

test('files that are not .xlsx workbooks are refused', async () => {
    assert.equal(looksLikeXlsx(new TextEncoder().encode('{"layers": []}')), false);
    await assert.rejects(xlsxToBoringLog(new TextEncoder().encode('hello')), XlsxError);
    await assert.rejects(xlsxToBoringLog(new Uint8Array([0xd0, 0xcf, 0x11, 0xe0, 0, 0, 0, 0])), /old \.xls/);
});

test('recovery (as a percent), sample unit weights and a specimen USCS are read from a workbook', () => {
    const { document, warnings } = workbookToBoringLog({ sheets: [
        { name: 'Layers', rows: [['top', 'bottom', 'description'], [0, 10, 'Gray lean CLAY']] },
        { name: 'Samples', rows: [['name', 'top', 'bottom', 'type', 'Recovery (%)', 'total_unit_weight'], ['T-1', 2, 4, 'Shelby', 85, 18.6]] },
        { name: 'Specimens', rows: [['sample_name', 'top', 'liquid_limit', 'plastic_limit', 'USCS'], ['T-1', 2.5, 44, 21, 'CL']] },
    ] });
    assert.deepEqual(warnings, []);
    assert.deepEqual(document.samples, [{
        top: 2, bottom: 4, name: 'T-1', type: 'Shelby', recovery_percent: 85, total_unit_weight: 18.6,
        specimens: [{ top: 2.5, liquid_limit: 44, plastic_limit: 21, uscs: 'CL' }],
    }]);
    const v = validateBoringLog(document);
    assert.equal(v.valid, true, JSON.stringify(v.errors));
    assert.deepEqual(v.warnings, []);
});
