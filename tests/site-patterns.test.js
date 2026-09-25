import { test } from 'node:test';
import assert from 'node:assert/strict';
import ImageTracer from 'imagetracerjs';
import { addPattern, removePattern, listPatterns, thresholdPixels, tidyTracedSvg, base64Utf8, svgSize, patternTargets, applyPattern } from '../site/lib.js';
import { validateBoringLog, hatchSwatch, samplerSwatch, USCS_SYMBOLS, SAMPLER_NAMES } from '../src/index.js';

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

test('the dialog lists layers or samples and applies the code to the ticked ones', () => {
    const text = JSON.stringify({
        schema_version: '1.0',
        units: { length: 'ft' },
        layers: [{ top: 0, bottom: 4, description: 'Rubble fill' }, { top: 4, bottom: 9, description: 'silty SAND', uscs: 'SM' }],
        samples: [{ top: 2, bottom: 3.5, name: 'S-1', type: 'SPT' }],
    });
    assert.deepEqual(patternTargets(text, 'soil'), [
        { index: 0, label: '0–4 ft · Rubble fill', current: '' },
        { index: 1, label: '4–9 ft · silty SAND', current: 'SM' },
    ]);
    assert.deepEqual(patternTargets(text, 'sampler'), [{ index: 0, label: '2–3.5 ft · S-1', current: 'SPT' }]);

    const withHatch = applyPattern(addPattern(text, 'FILL', { image: png, width: 8, height: 8 }), 'FILL', 'soil', [0]);
    const doc = JSON.parse(withHatch);
    assert.equal(doc.layers[0].hatch, 'FILL');
    assert.equal(doc.layers[1].hatch, undefined, 'unticked layers are left alone');
    assert.equal(doc.layers[1].uscs, 'SM', '"uscs" is never changed');
    assert.deepEqual(validateBoringLog(withHatch).errors, []);

    const withSampler = applyPattern(addPattern(text, 'Vane', { image: png, width: 8, height: 8, kind: 'sampler' }), 'Vane', 'sampler', [0]);
    assert.equal(JSON.parse(withSampler).samples[0].type, 'Vane');
    assert.deepEqual(validateBoringLog(withSampler).errors, []);
});

test('every built-in hatch and sampler has a swatch for the reference list', () => {
    for (const code of USCS_SYMBOLS) assert.match(hatchSwatch(code), /^<svg[^>]*>.*fill="url\(#swatch-/s, code);
    for (const type of Object.keys(SAMPLER_NAMES)) assert.match(samplerSwatch(type), /^<svg[^>]*><.*<\/svg>$/s, type);
    assert.equal(hatchSwatch('FILL'), '');
});
