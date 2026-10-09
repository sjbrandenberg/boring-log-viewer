import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createLog, logName, restoreLogs, saveLogs, addLogs, removeLog, uniqueNames } from '../site/logs.js';
import { makeZip, crc32 } from '../site/zip.js';

test('a log is named after its boring, else its file, else Untitled', () => {
    assert.equal(logName(createLog('{ "metadata": { "boring_name": "B-\\"7\\"" } }', { name: 'file' })), 'B-"7"');
    assert.equal(logName(createLog('{ "layers": [] }', { name: 'site.json' })), 'site.json');
    assert.equal(logName(createLog('')), 'Untitled');
});

test('opened logs go after the active one, replacing it when it is empty', () => {
    const a = createLog('{}'), b = createLog('{"x":1}'), empty = createLog('');
    let r = addLogs([a, b], 0, [createLog('1'), createLog('2')]);
    assert.deepEqual(r.logs.map(l => l.text), ['{}', '1', '2', '{"x":1}']);
    assert.equal(r.active, 1);
    r = addLogs([a, empty], 1, [createLog('3')]);
    assert.deepEqual(r.logs.map(l => l.text), ['{}', '3']);
    assert.equal(r.active, 1);
});

test('closing logs keeps a sensible active log and at least one log', () => {
    const list = ['a', 'b', 'c'].map(t => createLog(t));
    assert.equal(removeLog(list, 2, 0).active, 1);
    assert.equal(removeLog(list, 2, 2).active, 1);
    assert.equal(removeLog(list, 0, 1).active, 0);
    const last = removeLog([list[0]], 0, 0);
    assert.equal(last.logs.length, 1);
    assert.equal(last.logs[0].text, '');
});

test('saved logs are restored, including the old one-log format', () => {
    const list = [createLog('a', { name: 'A', note: 'n' }), createLog('b')];
    const back = restoreLogs(JSON.parse(JSON.stringify(saveLogs(list, 1))));
    assert.deepEqual(back.logs.map(l => [l.text, l.name, l.note]), [['a', 'A', 'n'], ['b', '', '']]);
    assert.equal(back.active, 1);
    assert.deepEqual(restoreLogs({ json: '{"x":1}' }).logs.map(l => l.text), ['{"x":1}']);
    assert.equal(restoreLogs({}), null);
    assert.equal(restoreLogs({ logs: [], active: 3 }), null);
});

test('download names are made unique', () => {
    assert.deepEqual(uniqueNames(['B-1.svg', 'B-1.svg', 'b-1.svg', 'B-2.svg']), ['B-1.svg', 'B-1_2.svg', 'b-1_3.svg', 'B-2.svg']);
});

test('makeZip writes a ZIP that standard tools read back', () => {
    assert.equal(crc32(new TextEncoder().encode('123456789')), 0xcbf43926);
    const zip = makeZip([{ name: 'B-1.svg', data: '<svg/>' }, { name: 'ünï.png', data: new Uint8Array([0, 1, 2, 255]) }]);
    const dir = mkdtempSync(join(tmpdir(), 'zip-'));
    const file = join(dir, 'a.zip');
    writeFileSync(file, zip);
    const out = execFileSync('python3', ['-I', '-c', `import zipfile,sys; z=zipfile.ZipFile(sys.argv[1]); assert z.testzip() is None; print(z.namelist(), z.read('B-1.svg').decode(), list(z.read('ünï.png')))`, file]).toString();
    assert.match(out, /\['B-1.svg', 'ünï.png'\] <svg\/> \[0, 1, 2, 255\]/);
});

test('a log location comes from metadata latitude and longitude', async () => {
    const { logLocation } = await import('../site/logs.js');
    assert.deepEqual(logLocation('{"metadata":{"latitude":23.9,"longitude":120.69}}'), { lat: 23.9, lon: 120.69 });
    assert.equal(logLocation('{"metadata":{"latitude":23.9}}'), null);
    assert.equal(logLocation('{"metadata":{"latitude":"23.9","longitude":120}}'), null);
    assert.equal(logLocation('{"metadata":{"latitude":95,"longitude":120}}'), null);
    assert.equal(logLocation('{"metadata":{"latitude":0,"longitude":0}}'), null, '0, 0 is a missing location');
    assert.equal(logLocation('{ not json'), null);
});
