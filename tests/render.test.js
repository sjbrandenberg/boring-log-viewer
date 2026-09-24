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

// y of the depth-scale tick labelled `label` (the tick line just before the label).
const tickY = (svg, label) => Number(svg.match(new RegExp(String.raw`<line x1="[\d.]+" y1="([\d.]+)"[^>]*/><text [^>]*text-anchor="end">${label}</`))[1]);

test('sample rows line up with their samplers even when their text is long', () => {
    // Each row is several lines tall (as in NGL's Kornbloom borings, where every
    // sample repeats the same long remark), so rows used to be pushed further
    // and further below their samplers.
    const remarks = 'Samples were obtained by (1) SPT, (2) auger sampling, (3) Shelby tube, and (4) piston tube. '.repeat(4);
    const doc = oneLayer({
        layers: [{ top: 0, bottom: 8, description: 'Silt' }],
        samples: [0, 1, 1.5, 2, 3, 4, 5, 6].map((top, i) => ({ top, bottom: top + 0.45, name: `S-${i + 1}`, type: 'SPT', remarks })),
    });
    const misaligned = svg => {
        const symbols = [...svg.matchAll(/<rect x="[\d.]+" y="([\d.]+)" width="[\d.]+" height="([\d.]+)" fill="#fff" stroke="#000" stroke-width="1.2"\/>/g)]
            .map(m => [Number(m[1]), Number(m[1]) + Number(m[2])]);
        return doc.samples.filter((s, i) => {
            const y = Number(svg.match(new RegExp(String.raw`<text x="[\d.]+" y="([\d.]+)"[^>]*>${s.name}</text>`))[1]);
            return !(y > symbols[i][0] && y < symbols[i][1] + 10);
        }).map(s => s.name);
    };
    assert.deepEqual(misaligned(renderBoringLog(doc)), []);
    assert.notDeepEqual(misaligned(renderBoringLog(doc, { fit_text: false })), [], 'without fit_text the rows are pushed down');
});

test('no sample row starts above the top of the log', () => {
    const svg = renderBoringLog(oneLayer({
        samples: [{ top: 0, bottom: 0.45, name: 'S-1', type: 'SPT', remarks: 'A long remark that wraps onto several lines in the narrow column. '.repeat(4) }],
    }), { fit_text: false });
    const firstLineY = Number(svg.match(/<text x="[\d.]+" y="([\d.]+)"[^>]*>S-1<\/text>/)[1]);
    assert.ok(firstLineY > tickY(svg, '0(\.0+)?'), 'the first row stays below depth 0');
});

test('depth notes are drawn in italics at their depth in the description column', () => {
    const doc = oneLayer({ depth_notes: [{ depth: 3, description: 'thin clay lens' }] });
    const svg = renderBoringLog(doc, { height: 500 });
    const m = svg.match(/<text x="[\d.]+" y="([\d.]+)" font-style="italic">thin clay lens<\/text>/);
    assert.ok(m, 'note is drawn in italics');
    // The note's first line is centered on its depth: baseline = middle + 0.25 font size.
    assert.ok(Math.abs(Number(m[1]) - 2.5 - tickY(svg, '3(\.0+)?')) < 1, 'note is level with its depth');
    assert.match(textOf(svg), /Brown silty SAND.*thin clay lens/);
});

test('a depth note crowded by the layer description is pushed down with a leader', () => {
    const doc = oneLayer({
        layers: [{ top: 0, bottom: 5, description: 'Brown silty SAND with gravel, cobbles, and occasional boulders; dense to very dense, moist' }],
        depth_notes: [{ depth: 0.05, description: 'trace roots' }],
    });
    const svg = renderBoringLog(doc, { height: 500, width: 600 });
    const noteY = Number(svg.match(/y="([\d.]+)" font-style="italic">trace roots</)[1]);
    const descY = Math.max(...[...svg.matchAll(/<text x="[\d.]+" y="([\d.]+)">([^<]*)<\/text>/g)]
        .filter(t => /SAND|gravel|boulders|moist/.test(t[2])).map(t => Number(t[1])));
    assert.ok(noteY > descY, 'note starts below the layer description');
    assert.match(svg, /<polyline points="[\d.,\s]+" fill="none" stroke="#000" stroke-width="0.5"\/>/, 'leader from its depth');
});

test('depth notes need a depth, and notes without text are not drawn', () => {
    assert.throws(() => renderBoringLog(oneLayer({ depth_notes: [{ description: 'no depth' }] })), BoringLogError);
    const svg = renderBoringLog(oneLayer({ depth_notes: [{ depth: 1, description: null }, { depth: 2, description: '' }] }));
    assert.doesNotMatch(svg, /font-style="italic"/);
});
