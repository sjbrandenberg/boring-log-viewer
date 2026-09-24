import { test } from 'node:test';
import assert from 'node:assert/strict';
import { syntaxErrorLocation, locatePointer, downloadName, renderOptions, summarize, lineColumn } from '../site/lib.js';

const json = `{
  "schema_version": "1.0",
  "metadata": { "boring_name": "B-3", "a/b": 1 },
  "layers": [
    { "top": 0, "bottom": 2, "description": "sand, \\"loose\\"" },
    { "top": 2, "bottom": 5, "uscs": "XX", "tags": [1, [2, 3], {}] }
  ],
  "samples": []
}`;

const at = pointer => {
    const span = locatePointer(json, pointer);
    return span && json.slice(span.start, span.end);
};

test('locatePointer finds values by key and array index', () => {
    assert.equal(at('/schema_version'), '"1.0"');
    assert.equal(at('/layers/1/uscs'), '"XX"');
    assert.equal(at('/layers/0/bottom'), '2');
    assert.equal(at('/layers/0/description'), '"sand, \\"loose\\""');
    assert.equal(at('/metadata/a~1b'), '1', 'JSON Pointer escapes ~1 for /');
    assert.equal(at('/samples'), '[]');
    assert.match(at('/layers/1'), /^\{ "top": 2.*\}$/s, 'skips nested arrays and objects in earlier siblings');
    assert.ok(at('').startsWith('{') && at('').endsWith('}'));
});

test('locatePointer returns null for paths that do not exist', () => {
    assert.equal(locatePointer(json, '/layers/7'), null);
    assert.equal(locatePointer(json, '/nope'), null);
    assert.equal(locatePointer(json, '/schema_version/x'), null);
});

test('syntaxErrorLocation understands Chrome/Node and Firefox messages', () => {
    const text = '{\n  "a": 1\n  "b": 2\n}';
    let err;
    try { JSON.parse(text); } catch (e) { err = e; }
    const loc = syntaxErrorLocation(text, err.message);
    assert.deepEqual([loc.line, loc.column], [3, 3]);
    assert.equal(text[loc.offset], '"');

    const ff = syntaxErrorLocation(text, "JSON.parse: expected ',' or '}' after property value in object at line 3 column 3 of the JSON data");
    assert.deepEqual(ff, loc);
    assert.deepEqual(syntaxErrorLocation(text, 'Unexpected token } in JSON at position 9'), { offset: 9, ...lineColumn(text, 9) });
    assert.equal(syntaxErrorLocation(text, 'Unexpected end of JSON input'), null);
});

test('downloadName makes a safe filename from the boring name', () => {
    assert.equal(downloadName({ metadata: { boring_name: 'B-3 (north)' } }, 'svg'), 'B-3_north.svg');
    assert.equal(downloadName({ metadata: { boring_name: '../../etc' } }, 'png'), '.._.._etc.png');
    assert.equal(downloadName({}, 'png'), 'boring-log.png');
    assert.equal(downloadName({ metadata: { boring_name: '***' } }, 'png'), 'boring-log.png');
});

test('renderOptions maps form values to renderer options', () => {
    const base = { header: true, legend: false, fit_text: true, hide_empty_columns: true };
    assert.deepEqual(renderOptions({ ...base, units: '', width: '800' }), { ...base, width: 800 });
    assert.equal(renderOptions({ ...base, units: 'ft', width: '' }).units, 'ft');
    assert.equal(renderOptions({ ...base, units: 'yards', width: '50' }).units, undefined);
    assert.equal(renderOptions({ ...base, width: '50' }).width, undefined, 'too narrow: keep the default');
    assert.equal(renderOptions({ ...base, width: '99999' }).width, 4000);
});

test('summarize counts what the log contains', () => {
    assert.equal(summarize({ layers: [{}], samples: [] }), '1 layer, 0 samples');
    assert.equal(summarize({ layers: [{}, {}], samples: [{}], groundwater: [{}, {}] }), '2 layers, 1 sample, 2 groundwater readings');
});
