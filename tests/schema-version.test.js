import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateBoringLog, renderBoringLog } from '../src/index.js';

const layers = [{ top: 0, bottom: 3, description: 'Gray, soft, wet, lean CLAY' }];

test('schema_version is optional: a log without it is read as the latest version', () => {
    const v = validateBoringLog({ layers });
    assert.equal(v.valid, true, JSON.stringify(v.errors));
    assert.match(renderBoringLog({ layers }), /^<svg/);
});

test('schema_version, when given, must be a known version', () => {
    assert.equal(validateBoringLog({ schema_version: '1.0', layers }).valid, true);
    const v = validateBoringLog({ schema_version: '2.0', layers });
    assert.equal(v.valid, false);
    assert.equal(v.errors[0].path, '/schema_version');
});
