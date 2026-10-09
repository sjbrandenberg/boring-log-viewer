import test from 'node:test';
import assert from 'node:assert/strict';
import { renderBoringLog, validateBoringLog, SAMPLER_NAMES } from '../src/index.js';

const base = samples => ({
    schema_version: '1.0',
    units: { length: 'm' },
    layers: [{ top: 0, bottom: 5, description: 'Brown silty SAND' }],
    samples,
});
const text = svg => svg.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');

test('NoRecovery is not a sampler type', () => {
    assert.equal(SAMPLER_NAMES.NoRecovery, undefined);
});

test('recovery is a note in the remarks, not a column', () => {
    const svg = renderBoringLog(base([
        { top: 1, bottom: 1.45, name: 'S-1', type: 'SPT', recovery: 0.36 },
        { top: 2, bottom: 2.45, name: 'S-2', type: 'SPT', recovery: 0, remarks: 'Rock in shoe' },
        { top: 3, bottom: 3.45, name: 'S-3', type: 'Shelby', recovery: 0, remarks: 'No recovery, tube bent' },
    ]));
    const t = text(svg);
    assert.doesNotMatch(t, /Recovery \(m\)/);
    assert.match(t, /Remarks/);
    assert.match(t, /Recovery 0\.36 m \(80%\)/);
    assert.match(t, /No recovery; Rock in shoe/);
    assert.equal((t.match(/no recovery/gi) ?? []).length, 2);
});

test('recovery is converted to the display units', () => {
    const t = text(renderBoringLog(base([{ top: 1, bottom: 1.5, type: 'SPT', recovery: 0.3048 }]), { units: 'ft' }));
    assert.match(t, /Recovery 1 ft \(61%\)/);
});

test('"no recovery" entered as the type or sample number becomes a note, with a warning', () => {
    for (const sample of [
        { top: 1, bottom: 1.45, name: 'S-1', type: 'NoRecovery' },
        { top: 1, bottom: 1.45, name: 'S-1', type: 'No recovery' },
        { top: 1, bottom: 1.45, name: 'NR', type: 'SPT' },
        { top: 1, bottom: 1.45, name: 'No Recovery', type: 'SPT' },
    ]) {
        const doc = base([sample]);
        const result = validateBoringLog(doc);
        assert.equal(result.valid, true, JSON.stringify(result.errors));
        assert.equal(result.warnings.length, 1, JSON.stringify(sample));
        assert.match(result.warnings[0].message, /no recovery/);
        const t = text(renderBoringLog(doc));
        assert.match(t, /No recovery/, JSON.stringify(sample));
        assert.doesNotMatch(t, /No Recovery|NoRecovery|\bNR\b/);
    }
});

test('a SPT with no recovery keeps its SPT symbol', () => {
    const t = text(renderBoringLog(base([{ top: 1, bottom: 1.45, name: 'NR', type: 'SPT' }])));
    assert.match(t, /Standard penetration test/);
});

test('a custom sampler pattern named NoRecovery still works', () => {
    const doc = base([{ top: 1, bottom: 1.45, type: 'NoRecovery' }]);
    doc.patterns = { NoRecovery: { kind: 'sampler', name: 'My NR', svg: "<svg viewBox='0 0 10 10'><rect width='10' height='10'/></svg>" } };
    const result = validateBoringLog(doc);
    assert.equal(result.valid, true);
    assert.equal(result.warnings.length, 0);
    assert.match(text(renderBoringLog(doc)), /My NR/);
});
