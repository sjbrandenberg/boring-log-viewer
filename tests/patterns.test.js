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
    d.layers[0].hatch = 'ZEOLITE';
    d.layers[1].hatch = 'Vane';
    d.samples[1].type = 'FILL';
    d.samples.push({ top: 4, bottom: 4.5, type: 'Vibracore' });
    const byPath = Object.fromEntries(validateBoringLog(d).errors.map(e => [e.path, e.message]));
    assert.match(byPath['/layers/0/hatch'], /unknown pattern "ZEOLITE"/);
    assert.match(byPath['/layers/1/hatch'], /"Vane" is a sampler pattern/);
    assert.match(byPath['/samples/1/type'], /"FILL" is a soil pattern/);
    assert.match(byPath['/samples/2/type'], /unknown sampler type "Vibracore"/);
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

test('a pattern code put in "uscs" gets a message pointing to "hatch", and is not shown as a USCS symbol', () => {
    const d = doc();
    d.layers[1] = { top: 1, bottom: 3, description: 'Rubble', uscs: 'FILL' };
    const errors = validateBoringLog(d).errors;
    assert.deepEqual(errors.map(e => e.path), ['/layers/1/uscs']);
    assert.match(errors[0].message, /"FILL" is a custom pattern, not a USCS symbol: use "hatch": "FILL"/);

    // The web page still draws what it can; the pattern is used, but "FILL" isn't
    // written into the USCS column as though it were a classification.
    const svg = renderBoringLog(d, { id_prefix: 't' });
    assert.match(svg, /fill="url\(#t-FILL\)"/);
    assert.doesNotMatch(svg, /text-anchor="middle"[^>]*>FILL</);
});

// ---- patterns given as SVG markup

const HAND_SVG = "<svg viewBox='0 0 40 20'><line x1='0' y1='20' x2='40' y2='0' stroke='black' stroke-width='2'/></svg>";
const svgDoc = (pattern, extra = {}) => ({
    schema_version: '1.0',
    patterns: { RUBBLE: { name: 'Rubble', ...pattern } },
    layers: [{ top: 0, bottom: 2, description: 'Rubble fill', hatch: 'RUBBLE' }],
    ...extra,
});
const decodedImages = svg => [...svg.matchAll(/href="data:image\/svg\+xml;base64,([^"]+)"/g)].map(m => Buffer.from(m[1], 'base64').toString());

test('a pattern given as SVG markup validates, takes its size from the viewBox, and is drawn as an image', () => {
    assert.deepEqual(validateBoringLog(svgDoc({ svg: HAND_SVG })).errors, []);
    const out = renderBoringLog(svgDoc({ svg: HAND_SVG }));
    const [img] = decodedImages(out);
    assert.match(img, /^<svg xmlns="http:\/\/www.w3.org\/2000\/svg" viewBox="0 0 40 20" width="40" height="20"><line x1="0" y1="20" x2="40" y2="0" stroke="black" stroke-width="2"\/><\/svg>$/);
    // one tile across the 40 px column: 40 x 20
    assert.match(out, /<pattern id="[^"]+-RUBBLE" patternUnits="userSpaceOnUse" width="40" height="20"/);
    assert.match(textOf(out), /RUBBLE – Rubble/);
    assert.ok(new Resvg(out).render().asPng().length > 1000);
});

test('SVG markup is rebuilt from drawing elements and paint attributes only', () => {
    const hostile = '<?xml version="1.0"?><svg xmlns="http://www.w3.org/2000/svg" width="10" height="10" onload="alert(1)">'
        + '<title>t</title><metadata><x>y</x></metadata><sodipodi:namedview/>'
        + '<g id="a" style="fill:#000;stroke:none;font-family:Arial" inkscape:label="L">'
        + '<path d="M0 0L10 10Z" onclick="alert(2)" fill="url(http://evil/x)" xlink:href="javascript:alert(3)"/></g></svg>';
    const [img] = decodedImages(renderBoringLog(svgDoc({ svg: hostile })));
    assert.equal(img, '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10" viewBox="0 0 10 10"><g fill="#000" stroke="none"><path d="M0 0L10 10Z"/></g></svg>');
});

test('SVG markup with elements that could run code or load content is rejected', () => {
    for (const [inner, what] of [['<script>alert(1)</script>', /<script> isn't allowed/], ['<image href="http://x/a.png"/>', /<image> isn't allowed/],
        ['<foreignObject><div/></foreignObject>', /<foreignObject> isn't allowed/], ['<style>.a{fill:red}</style>', /<style> isn't allowed.*style="\.\.\."/],
        ['<use href="#a"/>', /<use> isn't allowed/], ['hello', /text .* isn't allowed/]]) {
        const d = svgDoc({ svg: `<svg viewBox="0 0 4 4">${inner}</svg>` });
        const { errors } = validateBoringLog(d);
        assert.equal(errors.length, 1, inner);
        assert.equal(errors[0].path, '/patterns/RUBBLE/svg');
        assert.match(errors[0].message, what);
        assert.throws(() => renderBoringLog(d), BoringLogError, inner);
    }
    const { errors } = validateBoringLog(svgDoc({ svg: '<!DOCTYPE svg [<!ENTITY x "y">]><svg viewBox="0 0 4 4"/>' }));
    assert.match(errors[0].message, /<!DOCTYPE> isn't allowed/);
    assert.match(validateBoringLog(svgDoc({ svg: '<svg><rect width="4" height="4"/></svg>' })).errors[0].message, /needs a viewBox/);
});

test('a pattern needs exactly one of "svg" and "image"', () => {
    const both = validateBoringLog(svgDoc({ svg: HAND_SVG, image: PNG, width: 8, height: 8 })).errors;
    assert.deepEqual(both, [{ path: '/patterns/RUBBLE', message: 'has both "svg" and "image": give one' }]);
    const neither = validateBoringLog(svgDoc({})).errors;
    assert.deepEqual(neither, [{ path: '/patterns/RUBBLE', message: 'needs "svg" (SVG markup), or "image" (a data URI) with "width" and "height"' }]);
});

test('SVG markup works for sampler symbols too', () => {
    const d = {
        schema_version: '1.0',
        patterns: { VIBRO: { name: 'Vibracore', kind: 'sampler', svg: "<svg viewBox='0 0 10 30'><rect x='1' y='1' width='8' height='28' fill='none' stroke='black'/></svg>" } },
        layers: [{ top: 0, bottom: 2, description: 'Sand' }],
        samples: [{ top: 0.5, bottom: 1, type: 'VIBRO' }],
    };
    assert.deepEqual(validateBoringLog(d).errors, []);
    const out = renderBoringLog(d);
    assert.equal(decodedImages(out).length, 2, 'sample column and legend');
    assert.match(textOf(out), /Vibracore/);
});
