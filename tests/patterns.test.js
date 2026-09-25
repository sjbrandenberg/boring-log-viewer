import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Resvg } from '@resvg/resvg-js';
import { renderBoringLog, validateBoringLog, BoringLogError } from '../src/index.js';

// 8x8 black diagonal on white
const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAgAAAAICAAAAADhZOFXAAAAHklEQVR4nGNg+A8BDP8ZYAwoiwGKEQQDqgKEnv8MANjRN8mfoGgcAAAAAElFTkSuQmCC';
const SVG_IMAGE = `data:image/svg+xml;base64,${Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><circle cx="5" cy="5" r="3"/></svg>').toString('base64')}`;

const doc = (extra = {}) => ({
    schema_version: '1.0',
    patterns: {
        FILL: { name: 'Fill', image: PNG, width: 8, height: 8 },
        SM: { name: 'Silty sand (custom)', image: SVG_IMAGE, width: 10, height: 10, tile_width: 20 },
        Vane: { name: 'Vane shear', kind: 'sampler', image: PNG, width: 8, height: 8 },
    },
    layers: [
        { top: 0, bottom: 1, description: 'Rubble fill', hatch: 'FILL' },
        { top: 1, bottom: 3, description: 'Brown silty SAND', uscs: 'SM' },
        { top: 3, bottom: 5, description: 'poorly graded SAND with fill debris', hatch: 'SP-FILL' },
    ],
    samples: [
        { top: 0.5, bottom: 0.95, name: 'V-1', type: 'Vane' },
        { top: 2, bottom: 2.45, name: 'S-1', type: 'SPT' },
    ],
    ...extra,
});
const textOf = svg => [...svg.matchAll(/<text[^>]*>([^<]*)<\/text>/g)].map(m => m[1]).join(' ');

test('documents with custom patterns validate', () => {
    const result = validateBoringLog(doc());
    assert.deepEqual(result.errors, []);
});

test('a custom soil pattern tiles its image in the graphic log and appears in the legend', () => {
    const svg = renderBoringLog(doc(), { id_prefix: 't' });
    assert.match(svg, /<pattern id="t-FILL"[^>]*><image href="data:image\/png;base64,[^"]+"/);
    assert.match(svg, /fill="url\(#t-FILL\)"/);
    assert.match(textOf(svg), /FILL – Fill/);
});

test('a custom pattern for a USCS code replaces the built-in one, at its tile width', () => {
    const svg = renderBoringLog(doc(), { id_prefix: 't' });
    assert.match(svg, /<pattern id="t-SM" patternUnits="userSpaceOnUse" width="20" height="20"[^>]*><image href="data:image\/svg\+xml;base64,/);
    assert.match(textOf(svg), /SM – Silty sand \(custom\)/);
});

test('custom codes work in dual patterns', () => {
    const svg = renderBoringLog(doc(), { id_prefix: 't' });
    assert.match(svg, /fill="url\(#t-SP\)"/);
    assert.match(svg, /fill="url\(#t-FILL-right\)"/);
    assert.match(textOf(svg), /SP-FILL – Poorly graded sand \/ fill \(left: SP, right: FILL\)/);
});

test('a custom sampler draws its image in the sample column and the legend', () => {
    const svg = renderBoringLog(doc(), { id_prefix: 't' });
    const images = svg.match(/<image href="data:image\/png;base64,[^"]+" x="[\d.]+" y="[\d.]+" width="[\d.]+" height="[\d.]+" preserveAspectRatio="none"\/>/g) || [];
    assert.equal(images.length, 2, 'once in the sample column, once in the legend');
    assert.match(textOf(svg), /Vane shear/);
    assert.match(textOf(svg), /Standard penetration test \(SPT\)/, 'built-in samplers are unaffected');
});

test('logs with custom patterns rasterize with resvg (the API renders PNGs this way)', () => {
    const img = new Resvg(renderBoringLog(doc())).render();
    assert.ok(img.width > 0 && img.height > 0);
});

test('undefined or mismatched pattern codes are reported', () => {
    const d = doc();
    d.layers[0].hatch = 'ROCK';
    d.layers[1].hatch = 'Vane';
    d.samples[1].type = 'FILL';
    d.samples.push({ top: 4, bottom: 4.5, type: 'Pitcher' });
    const byPath = Object.fromEntries(validateBoringLog(d).errors.map(e => [e.path, e.message]));
    assert.match(byPath['/layers/0/hatch'], /unknown pattern "ROCK"/);
    assert.match(byPath['/layers/1/hatch'], /"Vane" is a sampler pattern/);
    assert.match(byPath['/samples/1/type'], /"FILL" is a soil pattern/);
    assert.match(byPath['/samples/2/type'], /unknown sampler type "Pitcher"/);
    assert.throws(() => renderBoringLog(d), BoringLogError);
});

test('only PNG, JPEG and SVG data URIs are accepted as images', () => {
    for (const image of ['https://example.com/x.png', 'data:image/gif;base64,R0lGODlh', 'data:image/png;base64,AAAA" onload="alert(1)']) {
        const d = doc();
        d.patterns.FILL.image = image;
        const result = validateBoringLog(d);
        assert.ok(result.errors.some(e => e.path === '/patterns/FILL/image'), image);
        assert.throws(() => renderBoringLog(d), BoringLogError, 'the renderer refuses it even without validation');
    }
});

test('pattern codes must be simple identifiers', () => {
    const d = doc();
    d.patterns['bad code'] = { image: PNG, width: 8, height: 8 };
    const result = validateBoringLog(d);
    assert.ok(result.errors.some(e => /pattern code "bad code"/.test(e.message)), JSON.stringify(result.errors));
});
