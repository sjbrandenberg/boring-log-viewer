import test from 'node:test';
import assert from 'node:assert/strict';
import { renderBoringLog, validateBoringLog } from '../src/index.js';
import { checkUscs, isValidUscs } from '../src/classify.js';

const text = svg => svg.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
const oneLayer = (uscs, description) => ({ schema_version: '1.0', layers: [{ top: 0, bottom: 5, uscs, description }] });

test('only possible USCS symbols are valid', () => {
    for (const ok of ['SP', 'SP-SM', 'SM-SP', 'GC-GM', 'CL-ML', 'CL/CH', 'GW/GP', 'PT']) assert.ok(isValidUscs(ok), ok);
    for (const bad of ['GW-GP', 'SW-SP', 'CL-CH', 'ML-SM', 'SP-SP', 'XX', 'sp']) assert.ok(!isValidUscs(bad), bad);
});

test('a recorded symbol is flagged whenever the description gives a different one', () => {
    assert.deepEqual(checkUscs('SP', 'Brown sandy SILT'), { invalid: false, inferred: 'ML' });
    assert.deepEqual(checkUscs('SP-SM', 'Brown well graded SAND'), { invalid: false, inferred: 'SW' });
    assert.deepEqual(checkUscs('SP', 'silty SAND'), { invalid: false, inferred: 'SM' });
    assert.deepEqual(checkUscs('CL', 'fat CLAY'), { invalid: false, inferred: 'CH' });
    assert.deepEqual(checkUscs('GW', 'poorly graded SAND'), { invalid: false, inferred: 'SP' });
    // after a heading that reads as a mixed layer
    assert.deepEqual(checkUscs('SP', 'GRAVEL AND SAND: Yellowish brown, medium dense, silty sand with gravels'), { invalid: false, inferred: 'SM' });
    assert.deepEqual(checkUscs('GW-GP', 'poorly graded GRAVEL'), { invalid: true, inferred: 'GP' });
    assert.deepEqual(checkUscs('GW-GP', 'GRAVEL'), { invalid: true, inferred: null });
    assert.deepEqual(checkUscs('GP-GW', 'GRAVEL AND SAND: Brown, dense silty sand with gravels and cobbles'), { invalid: true, inferred: 'SM' });
    assert.deepEqual(checkUscs('SM-G', 'GRAVEL AND SAND'), { invalid: true, inferred: 'SM' });
    // the same symbol, a dual in the other order, a borderline symbol that includes it,
    // or a description that determines nothing
    for (const [uscs, description] of [['SM', 'Brown silty SAND'], ['ML-CL', 'silty CLAY'], ['CL/CH', 'lean CLAY'], ['SM', 'SAND'], ['ML-CL', 'clayey silt to silty clay']]) {
        assert.equal(checkUscs(uscs, description), null, `${uscs} / ${description}`);
    }
});

test('a contradicted symbol is shown with ours in parentheses, with a warning', () => {
    const doc = oneLayer('SP', 'Brown sandy SILT, stiff');
    const t = text(renderBoringLog(doc));
    assert.match(t, / SP \(ML\) /);
    assert.match(t, /USCS symbol inferred from the material description/);
    const { valid, warnings } = validateBoringLog(doc);
    assert.equal(valid, true);
    assert.equal(warnings.length, 1);
    assert.match(warnings[0].message, /reads as ML/);
    assert.doesNotMatch(text(renderBoringLog(doc, { infer_uscs: false })), /\(ML\)/);
});

test('an impossible symbol gets a warning, and ours when the description gives one', () => {
    const doc = oneLayer('GW-GP', 'Brown poorly graded GRAVEL');
    assert.match(text(renderBoringLog(doc)), / GW-GP \(GP\) /);
    const { valid, warnings } = validateBoringLog(doc);
    assert.equal(valid, true);
    assert.match(warnings[0].message, /not a possible USCS symbol/);
    assert.equal(validateBoringLog(oneLayer('GW-GP', 'GRAVEL')).warnings.length, 1);
});

test('matching symbols get no note', () => {
    const doc = oneLayer('SM', 'Brown silty SAND');
    assert.doesNotMatch(text(renderBoringLog(doc)), /\(SM\)|inferred/);
    assert.deepEqual(validateBoringLog(doc).warnings, []);
});

test('a value with one real symbol (SM-G) is accepted with a warning and drawn from that symbol; one with none (XX) is an error', () => {
    const doc = oneLayer('SM-G', 'Gray, very dense silty sand with gravels');
    const { valid, warnings } = validateBoringLog(doc);
    assert.equal(valid, true);
    assert.match(warnings[0].message, /not a possible USCS symbol.*graphic log uses SM/);
    const svg = renderBoringLog(doc, { id_prefix: 't' });
    assert.match(text(svg), / SM-G \(SM\) /);
    assert.match(svg, /fill="url\(#t-SM\)"/);
    assert.equal(validateBoringLog(oneLayer('XX', 'sand')).valid, false);
});

test('a recorded symbol that includes the one read from the description is not a mismatch', () => {
    assert.equal(checkUscs('SP-SM', 'silty SAND'), null, 'SP-SM includes SM');
    assert.equal(checkUscs('SP-SM', 'poorly graded SAND'), null, 'SP-SM includes SP');
    assert.equal(checkUscs('SP-SM', 'GRAVEL AND SAND: Yellowish brown, medium dense, silty sand with gravels'), null);
    assert.equal(checkUscs('CL-ML', 'silty CLAY'), null);
    assert.deepEqual(checkUscs('SP-SM', 'Brown well graded SAND'), { invalid: false, inferred: 'SW' }, 'SW is not in SP-SM');
});
