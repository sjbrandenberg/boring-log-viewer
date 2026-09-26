import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { agsToBoringLogs, parseAgs, looksLikeAgs, AgsError, validateBoringLog, renderBoringLog } from '../src/index.js';

const AGS = readFileSync(new URL('./fixtures/example.ags', import.meta.url), 'utf8');

test('AGS4 lines are parsed into groups, with doubled quotes inside fields', () => {
    const g = parseAgs(AGS);
    assert.equal(g.GEOL.rows.length, 6);
    assert.equal(g.GEOL.units.GEOL_TOP, 'm');
    assert.equal(g.GEOL.rows[1].GEOL_DESC, 'Soft grey slightly sandy CLAY with "organic" odour');
    assert.ok(looksLikeAgs(AGS));
    assert.ok(!looksLikeAgs('{ "schema_version": "1.0" }'));
});

test('each borehole becomes a valid document', () => {
    const { documents, warnings } = agsToBoringLogs(AGS);
    assert.deepEqual(documents.map(d => d.loca_id), ['BH01', 'BH02']);
    for (const { document } of documents) assert.deepEqual(validateBoringLog(document).errors, [], document.metadata.boring_name);
    assert.deepEqual(warnings, ['BH01: stratum at 8.00 m left out (base missing)']);
});

test('borehole metadata, strata and depth notes carry over', () => {
    const [bh01, bh02] = agsToBoringLogs(AGS).documents.map(d => d.document);
    assert.deepEqual(bh01.metadata, {
        project: 'Riverside Quay (synthetic example)', site_name: 'Riverside', boring_name: 'BH01', latitude: 52.9, longitude: -1.1,
        elevation: 21.5, start_date: '2024-03-04', end_date: '2024-03-05', boring_type: 'Cable percussion',
        driller: 'Example Drilling Ltd', notes: 'Groundwater seepage noted during boring', diameter: 150,
    });
    assert.deepEqual(bh01.units, { length: 'm', unit_weight: 'kN/m3', diameter: 'mm' });
    assert.deepEqual(bh01.layers.map(l => [l.top, l.bottom]), [[0, 1.2], [1.2, 3.5], [3.5, 8]]);
    assert.deepEqual(bh01.depth_notes, [{ depth: 2.4, description: 'Thin peat band' }]);
    assert.deepEqual(bh02.samples, []);
    assert.equal(bh02.metadata.latitude, undefined);
});

test('samples get sampler types, SPT results and lab values', () => {
    const { samples } = agsToBoringLogs(AGS).documents[0].document;
    const at = top => samples.filter(s => s.top === top);
    assert.deepEqual(at(0.5), [{ top: 0.5, bottom: 1, name: '1', type: 'Bulk' }]);
    assert.deepEqual(at(1.5), [{
        top: 1.5, bottom: 1.95, name: '2', type: 'Shelby', sampler_diameter: 100, recovery: 0.36,
        water_content: 38, liquid_limit: 52, plastic_limit: 24, dry_unit_weight: 13.24, specific_gravity: 2.68,
    }]);
    // An ES sample isn't a sampler type: drawn as Other, with the AGS code in its number
    assert.deepEqual(at(2), [{ top: 2, bottom: 2.15, name: '3 ES', type: 'Other', remarks: 'For chemical testing' }]);
    // The SPT at 4.00 m has its own sample; the D sample there keeps the lab results
    const [d4, spt4] = [at(4).find(s => s.type === 'Disturbed'), at(4).find(s => s.type === 'SPT')];
    assert.deepEqual(d4, { top: 4, bottom: 4.15, name: '4', type: 'Disturbed', nonplastic: true, fines_content: 8 });
    assert.deepEqual(spt4, { top: 4, bottom: 4.45, type: 'SPT', blow_count: 24, blows: [5, 11, 13], energy_ratio: 71 });
    // Refusal keeps the main drive's blows/penetration
    assert.equal(at(6)[0].blow_count, '50/150mm');
});

test('water strikes become groundwater observations', () => {
    const { groundwater } = agsToBoringLogs(AGS).documents[0].document;
    assert.deepEqual(groundwater, [{ depth: 3.6, date: '2024-03-04', note: 'water strike; rose to 3.10 m after 20 min' }]);
});

test('made ground is drawn with the fill hatch and the log renders', () => {
    const svg = renderBoringLog(agsToBoringLogs(AGS).documents[0].document, { id_prefix: 't' });
    assert.match(svg, /fill="url\(#t-FILL\)"/);
    assert.match(svg, /Cable percussion/);
});

test('files that are not AGS4 are rejected with a reason', () => {
    assert.throws(() => agsToBoringLogs('"**PROJ"\n"*PROJ_ID"\n"EX1"'), /AGS3/);
    assert.throws(() => agsToBoringLogs('hello'), AgsError);
    assert.throws(() => agsToBoringLogs('"GROUP","PROJ"\n"HEADING","PROJ_ID"\n"DATA","X"'), /no LOCA group/);
});

test('SPT reports given only as text ("N=36 (18,29/36,-,-,-)") give N and the blows per 150 mm', () => {
    const ags = AGS.replace('"DATA","BH01","4.00","24","N=24","2","3","5","6","6","7","71"', '"DATA","BH01","4.00","","N=24 (2,3/5,6,6,7)","","","","","","",""')
        .replace('"DATA","BH01","6.00","50","25/75 50/150","","","","","","",""', '"DATA","BH01","6.00","","N=36 (18,29/36,-,-,-)","","","","","","",""');
    const { samples } = agsToBoringLogs(ags).documents[0].document;
    const spt = samples.filter(s => s.type === 'SPT');
    assert.deepEqual(spt.map(s => [s.top, s.blow_count, s.blows]), [[4, 24, [5, 11, 13]], [6, 36, undefined]]);
});
