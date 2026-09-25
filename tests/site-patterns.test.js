import { test } from 'node:test';
import assert from 'node:assert/strict';
import ImageTracer from 'imagetracerjs';
import { addPattern, removePattern, listPatterns, thresholdPixels, tidyTracedSvg, base64Utf8, svgSize } from '../site/lib.js';
import { validateBoringLog } from '../src/index.js';

const base = JSON.stringify({ schema_version: '1.0', layers: [{ top: 0, bottom: 1, hatch: 'FILL' }] });
const png = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAgAAAAICAAAAADhZOFXAAAAHklEQVR4nGNg+A8BDP8ZYAwoiwGKEQQDqgKEnv8MANjRN8mfoGgcAAAAAElFTkSuQmCC';

test('addPattern and removePattern edit the document', () => {
    const text = addPattern(base, 'FILL', { image: png, width: 8, height: 8, name: 'Fill' });
    assert.deepEqual(listPatterns(text).map(([code]) => code), ['FILL']);
    assert.deepEqual(validateBoringLog(text).errors, [], 'the result is a valid document');
    assert.equal(JSON.parse(removePattern(text, 'FILL')).patterns, undefined, 'an empty patterns section is dropped');
    assert.throws(() => addPattern(base, '1bad', {}), /start with a letter/);
    assert.throws(() => addPattern('{ not json', 'FILL', {}), /Fix the JSON first/);
    assert.deepEqual(listPatterns('{ not json'), []);
});

test('thresholdPixels makes black and white, with transparency as white', () => {
    const out = thresholdPixels(new Uint8ClampedArray([30, 30, 30, 255, 220, 220, 220, 255, 0, 0, 0, 0]), 128);
    assert.deepEqual([...out], [0, 0, 0, 255, 255, 255, 255, 255, 255, 255, 255, 255]);
});

test('a traced black-and-white pattern becomes a valid SVG pattern image', () => {
    const w = 20;
    const h = 20;
    const data = new Uint8ClampedArray(w * h * 4);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
        const i = (y * w + x) * 4;
        const v = (x + y) % 10 < 2 ? 0 : 255;
        data[i] = data[i + 1] = data[i + 2] = v;
        data[i + 3] = 255;
    }
    const raw = ImageTracer.imagedataToSVG({ width: w, height: h, data }, {
        colorsampling: 0, numberofcolors: 2, pal: [{ r: 0, g: 0, b: 0, a: 255 }, { r: 255, g: 255, b: 255, a: 255 }],
        ltres: 1, qtres: 1, pathomit: 2, strokewidth: 0, roundcoords: 1, viewbox: true, blurradius: 0,
    });
    const svg = tidyTracedSvg(raw, w, h);
    assert.match(svg, /^<svg width="20" height="20" viewBox="0 0 20 20"/);
    assert.doesNotMatch(svg, /rgb\(255,255,255\)/, 'white shapes removed, so the tile is transparent');
    assert.match(svg, /<path fill="rgb\(0,0,0\)"/);
    assert.deepEqual(svgSize(svg), { width: 20, height: 20 });
    const text = addPattern(base, 'FILL', { image: `data:image/svg+xml;base64,${base64Utf8(svg)}`, width: w, height: h });
    assert.deepEqual(validateBoringLog(text).errors, []);
});

test('svgSize reads width/height or the viewBox', () => {
    assert.deepEqual(svgSize('<svg width="10" height="20px">'), { width: 10, height: 20 });
    assert.deepEqual(svgSize('<svg viewBox="0 0 30 15">'), { width: 30, height: 15 });
    assert.deepEqual(svgSize('<svg width="8" viewBox="0 0 30 15">'), { width: 8, height: 4 });
    assert.equal(svgSize('<svg>'), null);
});

test('base64Utf8 handles non-Latin text', () => {
    assert.equal(Buffer.from(base64Utf8('<svg>é–</svg>'), 'base64').toString('utf8'), '<svg>é–</svg>');
});
