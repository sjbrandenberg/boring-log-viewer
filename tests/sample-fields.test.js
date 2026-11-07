import test from 'node:test';
import assert from 'node:assert/strict';
import { renderBoringLog, validateBoringLog } from '../src/index.js';

const base = samples => ({
    units: { length: 'ft', unit_weight: 'pcf' },
    layers: [{ top: 0, bottom: 20, description: 'Gray, soft, wet, lean CLAY', uscs: 'CL' }],
    samples,
});
const text = svg => svg.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');

test('unit weights can be given for a whole sample, without a warning', () => {
    const doc = base([{ top: 5, bottom: 7.5, name: 'T-1', type: 'Shelby', total_unit_weight: 118.4, dry_unit_weight: 87.1,
        specimens: [{ name: 'T-1a', top: 5.5, bottom: 6, water_content: 35.2 }] }]);
    const result = validateBoringLog(doc);
    assert.equal(result.valid, true, JSON.stringify(result.errors));
    assert.deepEqual(result.warnings, []);
    const t = text(renderBoringLog(doc));
    assert.match(t, /Total unit wt\. \(pcf\)/);
    assert.match(t, /118\.4/);
    assert.match(t, /87\.1/);
    assert.match(t, /35\.2/);
});

test('other lab results on a sample still get a warning', () => {
    const result = validateBoringLog(base([{ top: 5, bottom: 6.5, type: 'SPT', water_content: 30, total_unit_weight: 120 }]));
    assert.equal(result.valid, true);
    assert.equal(result.warnings.length, 1);
    assert.match(result.warnings[0].message, /water_content/);
    assert.doesNotMatch(result.warnings[0].message, /unit_weight/);
});

test('a specimen can have a USCS symbol, drawn in the Lab USCS column', () => {
    const doc = base([{ top: 5, bottom: 7.5, name: 'T-1', type: 'Shelby',
        specimens: [{ name: 'T-1a', top: 5.5, bottom: 6, liquid_limit: 44, plastic_limit: 21, uscs: 'CL' }] }]);
    const result = validateBoringLog(doc);
    assert.equal(result.valid, true, JSON.stringify(result.errors));
    const t = text(renderBoringLog(doc));
    assert.match(t, /Lab USCS/);
    const bad = validateBoringLog(base([{ top: 5, bottom: 7.5, specimens: [{ top: 5.5, uscs: 'XX' }] }]));
    assert.equal(bad.valid, false);
    assert.equal(bad.errors[0].path, '/samples/0/specimens/0/uscs');
});

test('the Lab USCS column is left out when no specimen has a symbol', () => {
    const t = text(renderBoringLog(base([{ top: 5, bottom: 7.5, specimens: [{ top: 5.5, water_content: 30 }] }])));
    assert.doesNotMatch(t, /Lab USCS/);
});
