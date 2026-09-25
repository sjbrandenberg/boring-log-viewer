import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { Resvg } from '@resvg/resvg-js';
import { buildApp, chooseFormat, parseQuery } from '../server/app.js';
import { loadFonts, woffToSfnt } from '../server/fonts.js';

const coastal = readFileSync(new URL('./fixtures/coastal-style.json', import.meta.url), 'utf8');
let app;
before(async () => { app = await buildApp({ rateLimitMax: 1000 }); });
after(() => app.close());

const render = (query = '', body = coastal, headers = {}) =>
    app.inject({ method: 'POST', url: `/api/render${query}`, payload: body, headers: { 'content-type': 'application/json', ...headers } });
const pngSize = buf => [buf.readUInt32BE(16), buf.readUInt32BE(20)];

test('renders SVG by default', async () => {
    const res = await render();
    assert.equal(res.statusCode, 200);
    assert.equal(res.headers['content-type'], 'image/svg+xml; charset=utf-8');
    assert.equal(res.headers['content-disposition'], 'inline; filename="B-3.svg"');
    assert.match(res.body, /^<\?xml version="1.0" encoding="UTF-8"\?>\n<svg /);
    assert.equal(res.headers['access-control-allow-origin'], '*');
});

test('renders PNG at the requested scale', async () => {
    // Regression: passing fonts as buffers made resvg-js drop every option, so
    // all PNGs came out at 1x regardless of png_scale.
    const one = await render('?format=png&png_scale=1');
    const two = await render('?format=png');
    assert.equal(one.statusCode, 200);
    assert.equal(one.headers['content-type'], 'image/png');
    assert.equal(one.rawPayload.subarray(1, 4).toString(), 'PNG');
    const [w1, h1] = pngSize(one.rawPayload);
    assert.deepEqual(pngSize(two.rawPayload), [w1 * 2, h1 * 2]);
});

test('renders a standalone HTML page', async () => {
    const res = await render('?format=html&download=true');
    assert.equal(res.statusCode, 200);
    assert.equal(res.headers['content-type'], 'text/html; charset=utf-8');
    assert.equal(res.headers['content-disposition'], 'attachment; filename="B-3.html"');
    assert.match(res.body, /^<!doctype html>/);
    assert.match(res.body, /<title>B-3<\/title>/);
    assert.match(res.body, /<svg [^>]*>[\s\S]*<\/svg>/);
});

test('picks the format from the Accept header when ?format is absent', async () => {
    assert.equal((await render('', coastal, { accept: 'image/png' })).headers['content-type'], 'image/png');
    assert.equal((await render('', coastal, { accept: 'text/html,*/*;q=0.8' })).headers['content-type'], 'text/html; charset=utf-8');
    assert.equal((await render('?format=svg', coastal, { accept: 'image/png' })).headers['content-type'], 'image/svg+xml; charset=utf-8');
    const res = await render('', coastal, { accept: 'application/pdf' });
    assert.equal(res.statusCode, 406);
    assert.match(res.json().errors[0].message, /svg, png, html/);
});

test('chooseFormat follows q-values', () => {
    assert.equal(chooseFormat(undefined, 'text/html;q=0.5, image/png'), 'png');
    assert.equal(chooseFormat(undefined, 'image/png;q=0, text/html'), 'html');
    assert.equal(chooseFormat(undefined, '*/*'), 'svg');
    assert.equal(chooseFormat(undefined, undefined), 'svg');
    assert.equal(chooseFormat('pdf', 'image/png'), null);
});

test('query parameters become render options', async () => {
    const res = await render('?units=ft&columns=depth,graphic,description&legend=false&title=' + encodeURIComponent('My <log>'));
    assert.equal(res.statusCode, 200);
    assert.match(res.body, /Depth \(ft\)/);
    assert.doesNotMatch(res.body, /Legend|Water content/);
    assert.match(res.body, /My &lt;log&gt;/);
});

test('bad query parameters are rejected with every problem listed', async () => {
    const res = await render('?unit=ft&width=5&legend=maybe&columns=depth,colour&format=svg');
    assert.equal(res.statusCode, 400);
    const paths = res.json().errors.map(e => e.path).sort();
    assert.deepEqual(paths, ['?columns', '?legend', '?unit', '?width']);
});

test('parseQuery defaults', () => {
    assert.deepEqual(parseQuery({}), { options: {}, pngScale: 2, download: false, locaId: undefined, problems: [] });
    assert.equal(parseQuery({ id_prefix: '"><script>' }).problems[0].path, '?id_prefix');
});

test('invalid boring logs get 422 with paths', async () => {
    const res = await render('', JSON.stringify({ schema_version: '1.0', layers: [{ top: 3, bottom: 1, uscs: 'XX' }] }));
    assert.equal(res.statusCode, 422);
    const body = res.json();
    assert.equal(body.error, 'Invalid boring log');
    assert.deepEqual(body.errors.map(e => e.path).sort(), ['/layers/0', '/layers/0/uscs']);
});

test('warnings do not block rendering and are reported in a header', async () => {
    const res = await render('', JSON.stringify({ schema_version: '1.0', layers: [{ top: 0, bottom: 1 }, { top: 2, bottom: 3 }] }));
    assert.equal(res.statusCode, 200);
    assert.match(res.headers['x-boring-log-warnings'], /\/layers\/1: gap between 1 and 2/);
});

test('malformed, empty, oversized and non-JSON bodies get clear errors', async () => {
    const bad = await render('', '{"layers": [');
    assert.equal(bad.statusCode, 400);
    assert.equal(bad.json().error, 'Invalid JSON');
    assert.match(bad.json().errors[0].message, /position|end of JSON/, 'keeps JSON.parse detail');

    const empty = await render('', '');
    assert.equal(empty.statusCode, 400);

    const pdf = await app.inject({ method: 'POST', url: '/api/render', payload: '%PDF-1.4', headers: { 'content-type': 'application/pdf' } });
    assert.equal(pdf.statusCode, 415);
    const xml = await app.inject({ method: 'POST', url: '/api/render', payload: '<log/>', headers: { 'content-type': 'application/xml' } });
    assert.equal(xml.statusCode, 400);
    assert.equal(xml.json().error, 'Not an AGS4 or DIGGS file');
    // Plain text is read as an AGS4 file
    const text = await app.inject({ method: 'POST', url: '/api/render', payload: 'hello', headers: { 'content-type': 'text/plain' } });
    assert.equal(text.statusCode, 400);
    assert.equal(text.json().error, 'Not an AGS4 or DIGGS file');

    const small = await buildApp({ bodyLimit: 100 });
    const big = await small.inject({ method: 'POST', url: '/api/render', payload: coastal, headers: { 'content-type': 'application/json' } });
    assert.equal(big.statusCode, 413);
    await small.close();
});

test('API size limits', async () => {
    const layers = Array.from({ length: 2001 }, (_, i) => ({ top: i, bottom: i + 1 }));
    const res = await render('', JSON.stringify({ schema_version: '1.0', layers }));
    assert.equal(res.statusCode, 422);
    assert.match(res.json().errors[0].message, /at most 2000 layers/);

    const huge = await render('?format=png&png_scale=4&height=15000&fit_text=false');
    assert.equal(huge.statusCode, 422);
    assert.match(huge.json().errors[0].message, /megapixels/);
});

test('validate, schema, health and CORS preflight', async () => {
    const v = await app.inject({ method: 'POST', url: '/api/validate', payload: coastal, headers: { 'content-type': 'application/json' } });
    assert.deepEqual(v.json(), { valid: true, errors: [], warnings: [] });

    const s = await app.inject({ method: 'GET', url: '/api/schema' });
    assert.match(s.headers['content-type'], /^application\/schema\+json/);
    assert.equal(s.json().title, 'Boring log');

    const h = await app.inject({ method: 'GET', url: '/api/health' });
    assert.equal(h.json().status, 'ok');

    const pre = await app.inject({ method: 'OPTIONS', url: '/api/render', headers: { origin: 'https://example.org', 'access-control-request-method': 'POST' } });
    assert.equal(pre.statusCode, 204);
    assert.match(pre.headers['access-control-allow-methods'], /POST/);

    const missing = await app.inject({ method: 'GET', url: '/api/nope' });
    assert.equal(missing.statusCode, 404);
});

test('rate limiting returns 429', async () => {
    const limited = await buildApp({ rateLimitMax: 2 });
    const hit = () => limited.inject({ method: 'GET', url: '/api/health' });
    assert.equal((await hit()).statusCode, 200);
    assert.equal((await hit()).statusCode, 200);
    const res = await hit();
    assert.equal(res.statusCode, 429);
    assert.match(res.json().message, /2 requests per minute/);
    await limited.close();
});

test('PNG text is drawn with the bundled Arimo, not system fonts', () => {
    // Regression: the fonts were silently ignored and system fonts used instead.
    const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="200" height="40"><text x="5" y="25" font-family="Arial, Arimo" font-size="20">Silty SAND</text></svg>';
    const inked = opts => {
        const px = new Resvg(svg, opts).render().pixels;
        let n = 0;
        for (let i = 3; i < px.length; i += 4) if (px[i] > 128) n++;
        return n;
    };
    assert.equal(inked({ font: { loadSystemFonts: false } }), 0, 'control: no fonts, no text');
    // If resvg rejects the font option it silently drops *all* options and
    // loads system fonts, so also check that zoom took effect in the same render.
    const img = new Resvg(svg, { fitTo: { mode: 'zoom', value: 2 }, font: { fontFiles: loadFonts(), loadSystemFonts: false, defaultFontFamily: 'Arimo' } }).render();
    assert.equal(img.width, 400, 'options were applied');
    assert.ok(inked({ font: { fontFiles: loadFonts(), loadSystemFonts: false, defaultFontFamily: 'Arimo' } }) > 100, 'text drawn with Arimo');
});

test('woffToSfnt rejects non-WOFF input', () => {
    assert.throws(() => woffToSfnt(Buffer.from('not a font at all, just some bytes here padding padding')), /not a WOFF/);
});

test('infer_uscs=false turns off inferred USCS symbols', async () => {
    const on = await render();
    const off = await render('?infer_uscs=false');
    assert.equal(off.statusCode, 200);
    assert.match(on.body, />\(CH\)</);
    assert.doesNotMatch(off.body, />\(CH\)</);
});

// ---- AGS4 input

const agsFile = readFileSync(new URL('./fixtures/example.ags', import.meta.url), 'utf8');
const postAgs = (url, body = agsFile) => app.inject({ method: 'POST', url, payload: body, headers: { 'content-type': 'text/plain' } });

test('POST /api/ags converts every borehole in an AGS4 file', async () => {
    const res = await postAgs('/api/ags');
    assert.equal(res.statusCode, 200);
    const body = res.json();
    assert.deepEqual(body.documents.map(d => d.loca_id), ['BH01', 'BH02']);
    assert.equal(body.documents[0].document.metadata.boring_type, 'Cable percussion');
    assert.equal(body.warnings.length, 1);
});

test('an AGS4 file renders directly, choosing the borehole with ?loca_id', async () => {
    const none = await postAgs('/api/render');
    assert.equal(none.statusCode, 422);
    assert.match(none.json().errors[0].message, /2 boreholes: BH01, BH02; choose one with \?loca_id=/);
    const one = await postAgs('/api/render?loca_id=BH01&format=svg');
    assert.equal(one.statusCode, 200);
    assert.match(one.body, /-FILL\)/, 'made ground drawn as fill');
    assert.match(one.headers['content-disposition'], /filename="BH01.svg"/);
    const png = await postAgs('/api/render?loca_id=BH02&format=png');
    assert.equal(png.statusCode, 200);
    assert.equal(png.headers['content-type'], 'image/png');
    // A dynamic probe: a borehole with no strata
    const probe = await postAgs('/api/render', ['"GROUP","LOCA"', '"HEADING","LOCA_ID","LOCA_TYPE"', '"DATA","DP1","DP"'].join('\n'));
    assert.equal(probe.statusCode, 422);
    assert.match(probe.json().errors[0].message, /has no strata/);
    const missing = await postAgs('/api/render?loca_id=BH99');
    assert.equal(missing.json().error, 'Borehole not found');
    const ags3 = await postAgs('/api/render', ['"**PROJ"', '"*PROJ_ID"', '"X"'].join('\n'));
    assert.equal(ags3.statusCode, 422);
    assert.match(ags3.json().errors[0].message, /AGS3/);
    const noLoca = await postAgs('/api/ags', ['"GROUP","PROJ"', '"HEADING","PROJ_ID"', '"DATA","X"'].join('\n'));
    assert.equal(noLoca.statusCode, 422);
    assert.match(noLoca.json().errors[0].message, /no LOCA group/);
    // loca_id means nothing for a JSON body
    const jsonWithId = await render('?loca_id=BH01', coastal);
    assert.equal(jsonWithId.statusCode, 400);
});

// ---- DIGGS input

const diggsFile = readFileSync(new URL('./fixtures/example.diggs.xml', import.meta.url), 'utf8');
const postXml = (url, body = diggsFile) => app.inject({ method: 'POST', url, payload: body, headers: { 'content-type': 'application/xml' } });

test('POST /api/diggs converts every borehole in a DIGGS file', async () => {
    const res = await postXml('/api/diggs');
    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.json().documents.map(d => d.loca_id), ['B-1', 'B-2']);
    const wrong = await app.inject({ method: 'POST', url: '/api/diggs', payload: agsFile, headers: { 'content-type': 'text/plain' } });
    assert.equal(wrong.statusCode, 400);
    assert.equal(wrong.json().error, 'Not a DIGGS file');
});

test('a DIGGS file renders directly; boreholes without strata are refused', async () => {
    const one = await postXml('/api/render?loca_id=B-1&format=svg');
    assert.equal(one.statusCode, 200);
    assert.match(one.body, /Levee Upgrade &amp; Crossing/);
    const empty = await postXml('/api/render?loca_id=B-2');
    assert.equal(empty.statusCode, 422);
    assert.match(empty.json().errors[0].message, /B-2 has no strata \(LithologyObservations/);
    const broken = await postXml('/api/render', '<Diggs><x></Diggs>');
    assert.equal(broken.statusCode, 422);
    assert.equal(broken.json().error, 'Invalid DIGGS file');
});

test('files may be larger than the JSON limit', async () => {
    const small = await buildApp({ bodyLimit: 100, fileBodyLimit: 200000 });
    const res = await small.inject({ method: 'POST', url: '/api/diggs', payload: diggsFile, headers: { 'content-type': 'application/xml' } });
    assert.equal(res.statusCode, 200);
    const tiny = await buildApp({ bodyLimit: 100, fileBodyLimit: 1000 });
    const big = await tiny.inject({ method: 'POST', url: '/api/diggs', payload: diggsFile, headers: { 'content-type': 'application/xml' } });
    assert.equal(big.statusCode, 413);
    assert.match(big.json().errors[0].message, /limit is 1000 bytes/);
    await small.close();
    await tiny.close();
});
