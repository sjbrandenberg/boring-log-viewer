import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { Resvg } from '@resvg/resvg-js';
import { renderBoringLog, BoringLogError } from '../src/index.js';

const fixtureDir = new URL('./fixtures/', import.meta.url);
const fixtures = readdirSync(fixtureDir).filter(f => f.endsWith('.json'));
const load = name => JSON.parse(readFileSync(new URL(name, fixtureDir), 'utf8'));

// All drawn text joined with spaces, so labels wrapped onto several lines still match.
const textOf = svg => [...svg.matchAll(/<text[^>]*>([^<]*)<\/text>/g)].map(m => m[1]).join(' ');

const oneLayer = (extra = {}) => ({ schema_version: '1.0', layers: [{ top: 0, bottom: 5, description: 'Brown silty SAND' }], ...extra });

for (const file of fixtures) {
    test(`${file} matches its snapshot`, () => {
        const svg = renderBoringLog(readFileSync(new URL(file, fixtureDir), 'utf8'));
        const expected = readFileSync(new URL(`./snapshots/${file.replace(/\.json$/, '.svg')}`, import.meta.url), 'utf8').trimEnd();
        assert.equal(svg, expected, 'layout changed; if intended, run `npm run test:update` and review the diff');
    });

    test(`${file} is well-formed SVG that rasterizes`, () => {
        // resvg parses strict XML, so malformed markup fails here.
        const svg = renderBoringLog(load(file));
        const img = new Resvg(svg).render();
        assert.ok(img.width > 0 && img.height > 0);
    });
}

test('rendering is deterministic', () => {
    const doc = load('coastal-style.json');
    assert.equal(renderBoringLog(doc), renderBoringLog(structuredClone(doc)));
});

test('user text is escaped, not injected as markup', () => {
    const svg = renderBoringLog(oneLayer({
        metadata: { boring_name: '</title><script>alert(1)</script>', site_name: 'A & B "quoted"' },
        layers: [{ top: 0, bottom: 5, description: '<img src=x onerror=alert(1)> sand' }],
    }));
    assert.doesNotMatch(svg, /<script|<img/);
    assert.match(svg, /&lt;script&gt;/);
    assert.match(svg, /A &amp; B &quot;quoted&quot;/);
    assert.doesNotThrow(() => new Resvg(svg).render());
});

test('display units convert depths and unit weights', () => {
    const doc = load('vspdb-style.json');
    const svg = renderBoringLog(doc, { units: 'm' });
    assert.match(textOf(svg), /Depth \(m\)/);
    assert.match(textOf(svg), /Dry unit wt\. \(kN\/m³\)/);
    // 74.5 pcf = 11.7 kN/m3; 45 ft = 13.72 m
    assert.match(svg, />11\.7</);
    assert.doesNotMatch(svg, />74\.5</);
    assert.match(svg, /Groundwater at 1\.52 m/);
});

test('columns without data are hidden, and can be forced on', () => {
    const minimal = renderBoringLog(oneLayer());
    assert.doesNotMatch(textOf(minimal), /Sample type|Blow count|USCS/);
    const forced = renderBoringLog(oneLayer(), { hide_empty_columns: false });
    assert.match(textOf(forced), /Blow count/);
});

test('custom column list controls order and membership', () => {
    const svg = renderBoringLog(load('coastal-style.json'), { columns: ['depth', 'graphic', 'description', 'blow_count'] });
    assert.match(textOf(svg), /Blow count/);
    assert.doesNotMatch(textOf(svg), /Water content|Sample no\./);
    assert.throws(() => renderBoringLog(oneLayer(), { columns: ['depth', 'nonsense'] }), /Unknown column "nonsense"/);
});

test('the depth scale stretches so stacked descriptions fit', () => {
    const doc = oneLayer({
        layers: [
            { top: 0, bottom: 0.1, description: 'Long description '.repeat(200) },
            { top: 0.1, bottom: 1, description: 'Short' },
        ],
    });
    // y of the "Short" description vs. y of the tick for the bottom of the boring (depth 1).
    const shortY = svg => Number(svg.match(/<text x="[\d.]+" y="([\d.]+)">Short</)[1]);
    const bottomTickY = svg => Number(svg.match(/<line x1="[\d.]+" y1="([\d.]+)"[^>]*\/><text [^>]*text-anchor="end">1(\.0+)?</)[1]);
    const fitted = renderBoringLog(doc, { height: 100 });
    const unfitted = renderBoringLog(doc, { height: 100, fit_text: false });
    assert.ok(shortY(fitted) < bottomTickY(fitted), 'fitted: last description starts above the bottom of the scale');
    assert.ok(shortY(unfitted) > bottomTickY(unfitted), 'unfitted: text runs past the bottom of the scale');
});

test('dual USCS symbols split the graphic column', () => {
    const svg = renderBoringLog(oneLayer({ layers: [{ top: 0, bottom: 5, uscs: 'SP-SM' }] }), { id_prefix: 't' });
    assert.match(svg, /fill="url\(#t-SP\)"/);
    assert.match(svg, /fill="url\(#t-SM\)"/);
});

test('pattern ids differ between documents so logs can share a page', () => {
    const a = renderBoringLog(oneLayer());
    const b = renderBoringLog(oneLayer({ layers: [{ top: 0, bottom: 6, description: 'Brown silty SAND' }] }));
    const id = svg => svg.match(/<pattern id="([^"]+)-/)[1];
    assert.notEqual(id(a), id(b));
    assert.equal(id(renderBoringLog(oneLayer(), { id_prefix: 'mine' })), 'mine');
});

test('database-style nulls are treated as missing values', () => {
    const svg = renderBoringLog({
        schema_version: '1.0',
        metadata: { boring_name: 'B-1', rig: null, elevation: null },
        layers: [{ top: 0, bottom: 2, description: 'Clay', uscs: null, hatch: null }],
        samples: [{ top: 1, bottom: 1.5, type: 'SPT', blow_count: null, water_content: 20 }],
        groundwater: null,
    });
    assert.doesNotMatch(svg, /null/);
    assert.doesNotMatch(textOf(svg), /Elevation|Blow count/);
});

test('undrawable input raises BoringLogError listing each problem', () => {
    assert.throws(() => renderBoringLog('{not json'), BoringLogError);
    try {
        renderBoringLog({ layers: [{ top: 2, bottom: 1 }], samples: [{ top: 'x', bottom: 1 }] });
        assert.fail('expected an error');
    } catch (e) {
        assert.ok(e instanceof BoringLogError);
        const paths = e.issues.map(i => i.path);
        assert.ok(paths.includes('/layers/0'));
        assert.ok(paths.includes('/samples/0/top'));
    }
});
