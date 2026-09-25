import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Resvg } from '@resvg/resvg-js';
import { renderBoringLog, validateBoringLog, hatchSwatch, hatchName, LITHOLOGY, LITHOLOGY_GROUPS, USCS_SYMBOLS } from '../src/index.js';
import { HATCH_TILES } from '../src/hatches.js';

const codes = Object.keys(LITHOLOGY);
const log = layers => ({ schema_version: '1.0', layers });

test('every built-in material has a tile, a name and a group, and codes follow the pattern-code rule', () => {
    assert.equal(codes.length, 67);
    for (const code of codes) {
        assert.ok(HATCH_TILES[code], `${code} has a tile`);
        assert.match(code, /^[A-Za-z][A-Za-z0-9_]{0,15}$/, code);
        assert.ok(LITHOLOGY[code].name && LITHOLOGY_GROUPS.includes(LITHOLOGY[code].group), code);
        assert.ok(!USCS_SYMBOLS.includes(code), `${code} doesn't clash with a USCS symbol`);
    }
});

test('fallback chains end at a code with a tile and never loop', () => {
    for (const code of codes) {
        const seen = new Set();
        for (let c = code; c; c = LITHOLOGY[c].fallback) {
            assert.ok(!seen.has(c), `${code}: loop at ${c}`);
            seen.add(c);
            assert.ok(LITHOLOGY[c], `${code}: fallback ${c} is a built-in material`);
        }
        assert.ok([...seen].some(c => HATCH_TILES[c]), code);
    }
    assert.equal(LITHOLOGY.SANDSTONE.fallback, 'ROCK_SED');
    assert.equal(LITHOLOGY.ROCK_SED.fallback, 'ROCK');
});

test('every material swatch is well-formed SVG that rasterizes', () => {
    // All swatches nested in one SVG, so the rasterizer runs once.
    const swatches = codes.map((code, i) => hatchSwatch(code).replace('<svg ', `<svg x="${(i % 10) * 44}" y="${Math.floor(i / 10) * 28}" `));
    const img = new Resvg(`<svg xmlns="http://www.w3.org/2000/svg" width="440" height="${Math.ceil(codes.length / 10) * 28}">${swatches.join('')}</svg>`).render();
    assert.equal(img.width, 440);
    for (const s of swatches) assert.match(s, /^<svg [^>]*>.*<\/svg>$/s);
});

test('built-in materials are valid hatch codes, drawn and named in the legend', () => {
    const doc = log([
        { top: 0, bottom: 1, description: 'Asphalt concrete', hatch: 'ASPHALT' },
        { top: 1, bottom: 3, description: 'Rubble fill', hatch: 'FILL' },
        { top: 3, bottom: 5, description: 'poorly graded SAND with fill debris', hatch: 'SP-FILL' },
        { top: 5, bottom: 9, description: 'SANDSTONE, gray, moderately weathered', hatch: 'SANDSTONE' },
    ]);
    assert.deepEqual(validateBoringLog(doc).errors, []);
    const svg = renderBoringLog(doc, { id_prefix: 't' });
    for (const code of ['FILL', 'SANDSTONE', 'SP']) assert.match(svg, new RegExp(`fill="url\\(#t-${code}(-right)?\\)"`), code);
    const text = [...svg.matchAll(/<text[^>]*>([^<]*)<\/text>/g)].map(m => m[1]).join(' ');
    assert.match(text, /FILL – Fill/);
    assert.match(text, /SANDSTONE – Sandstone/);
    assert.match(text, /ASPHALT – Asphalt pavement/);
    assert.match(text, /SP-FILL – Poorly graded sand \/ fill \(left: SP, right: FILL\)/);
    assert.equal(hatchName('GRANITE'), 'Granite');
    assert.ok(new Resvg(svg).render().width > 0);
});

test('solid materials are drawn as a plain fill under the pattern, not a filled tile', () => {
    const svg = renderBoringLog(log([{ top: 0, bottom: 2, hatch: 'ASPHALT' }, { top: 2, bottom: 4, hatch: 'COAL' }]), { id_prefix: 't' });
    assert.match(svg, /<rect x="[\d.]+" y="[\d.]+" width="[\d.]+" height="[\d.]+" fill="#3c3c3c"\/>/, 'asphalt');
    assert.match(svg, /<rect x="[\d.]+" y="[\d.]+" width="[\d.]+" height="[\d.]+" fill="#000000"\/>/, 'coal');
    for (const code of ['ASPHALT', 'COAL', 'VOID']) assert.ok(!/<rect/.test(HATCH_TILES[code].body), `${code} tile has no filled rect`);
});

test('an undefined code is still reported, with the built-in materials mentioned', () => {
    const errors = validateBoringLog(log([{ top: 0, bottom: 1, hatch: 'ZEOLITE' }])).errors;
    assert.match(errors[0].message, /unknown pattern "ZEOLITE": use a USCS symbol, a built-in hatch such as FILL or SANDSTONE/);
});
