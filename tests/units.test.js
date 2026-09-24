import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { inferHatch, layerHatch, validateBoringLog, measureText, wrapText } from '../src/index.js';

test('inferHatch reads explicit group symbols first', () => {
    assert.equal(inferHatch('Gray-brown, medium dense, poorly graded SAND with silt (SP-SM)'), 'SP-SM');
    assert.equal(inferHatch('Stiff CL with sand'), 'CL');
    assert.equal(inferHatch('CLASSIC clay'), 'CL', 'symbols must be whole words, not parts of CLASSIC');
});

test('inferHatch falls back to keywords when no symbol is given', () => {
    // The original get_hatch_code.js returned early here and produced no hatch.
    assert.equal(inferHatch('Dark gray, loose, wet, silty SAND with shell fragments'), 'SM');
    assert.equal(inferHatch('Reddish brown, stiff, sandy lean clay with trace gravel'), 'CL');
    assert.equal(inferHatch('Olive gray, stiff, moist, fat CLAY, high plasticity'), 'CH');
    assert.equal(inferHatch('Light brown, dry, well-graded GRAVEL with sand'), 'GW');
    assert.equal(inferHatch('poorly graded sand'), 'SP');
    assert.equal(inferHatch('clayey gravel with sand'), 'GC');
    assert.equal(inferHatch('Gray elastic silt, very soft'), 'MH');
    assert.equal(inferHatch('dark brown organic silt with roots'), 'OL');
    assert.equal(inferHatch('Fibrous PEAT'), 'PT');
});

test('inferHatch picks the principal soil, not a minor constituent', () => {
    assert.equal(inferHatch('silty SAND with gravel'), 'SM', 'capitalized principal wins');
    assert.equal(inferHatch('sand with gravel'), 'SP', 'noun after "with" is minor');
});

test('inferHatch returns null for non-soil descriptions', () => {
    assert.equal(inferHatch('Asphalt concrete over aggregate base'), null);
    assert.equal(inferHatch(''), null);
    assert.equal(inferHatch(undefined), null);
});

test('layerHatch prefers explicit hatch, then USCS, then the description', () => {
    assert.deepEqual(layerHatch({ hatch: 'none', uscs: 'SM' }), []);
    assert.deepEqual(layerHatch({ hatch: 'GP', uscs: 'SM' }), ['GP']);
    assert.deepEqual(layerHatch({ uscs: 'CL-ML', description: 'SAND' }), ['CL', 'ML']);
    assert.deepEqual(layerHatch({ description: 'silty SAND' }), ['SM']);
});

test('every fixture passes validation', () => {
    const dir = new URL('./fixtures/', import.meta.url);
    for (const file of readdirSync(dir).filter(f => f.endsWith('.json'))) {
        const result = validateBoringLog(readFileSync(new URL(file, dir), 'utf8'));
        assert.deepEqual(result.errors, [], file);
    }
});

test('validation reports every problem with a path', () => {
    const result = validateBoringLog({
        schema_version: '1.0',
        units: { length: 'yards' },
        layers: [
            { top: 0, bottom: 2, uscs: 'XX', colour: 'brown' },
            { top: 3, bottom: 2 },
        ],
        samples: [{ top: 1, bottom: 1.5, type: 'Split spoon' }],
    });
    assert.equal(result.valid, false);
    const byPath = Object.fromEntries(result.errors.map(e => [e.path, e.message]));
    assert.match(byPath['/units/length'], /must be one of: m, ft/);
    assert.match(byPath['/layers/0/uscs'], /USCS/);
    assert.match(byPath['/layers/0'], /unknown property "colour"/);
    assert.match(byPath['/layers/1'], /bottom \(2\) must be greater than top \(3\)/);
    assert.match(byPath['/samples/0/type'], /SPT/);
});

test('validation warns about gaps and overlaps without failing', () => {
    const result = validateBoringLog({
        schema_version: '1.0',
        layers: [{ top: 0, bottom: 1 }, { top: 1.5, bottom: 3 }, { top: 2.5, bottom: 4 }],
    });
    assert.equal(result.valid, true);
    assert.equal(result.warnings.length, 2);
    assert.match(result.warnings[0].message, /gap/);
    assert.match(result.warnings[1].message, /overlaps/);
});

test('validation accepts nulls and rejects malformed JSON', () => {
    assert.equal(validateBoringLog({ schema_version: '1.0', metadata: { rig: null }, layers: [{ top: 0, bottom: 1, uscs: null }] }).valid, true);
    const bad = validateBoringLog('{"layers": [');
    assert.equal(bad.valid, false);
    assert.match(bad.errors[0].message, /Invalid JSON/);
});

test('measureText uses Arial-compatible advance widths', () => {
    assert.equal(measureText('', 10), 0);
    // Digits are 1139/2048 em in Arial.
    assert.ok(Math.abs(measureText('0', 10) - 5.5615) < 0.001);
    assert.ok(measureText('W', 10) > measureText('i', 10));
    assert.ok(measureText('Sand', 10, true) > measureText('Sand', 10));
});

test('wrapText keeps every line within the width', () => {
    const text = 'Gray-green, medium dense, saturated, silty SAND with occasional shell fragments and a supercalifragilisticexpialidocious word';
    const lines = wrapText(text, 80, 10);
    assert.ok(lines.length > 3);
    for (const ln of lines) assert.ok(measureText(ln, 10) <= 80, ln);
    assert.equal(lines.join('').replace(/\s/g, ''), text.replace(/\s/g, ''));
    assert.deepEqual(wrapText('a\nb', 100, 10), ['a', 'b']);
    assert.deepEqual(wrapText(null, 100, 10), []);
});
