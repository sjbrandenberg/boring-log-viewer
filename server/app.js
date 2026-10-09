// HTTP API for rendering boring logs. Built as a function so tests can drive
// it with fastify.inject() without opening a port.
//
//   POST /api/render    body: boring log JSON  ->  SVG, PNG or HTML
//                       (or an AGS4 file as text/plain, or a DIGGS file as
//                       application/xml; ?loca_id= picks the borehole)
//   POST /api/ags       body: AGS4 file        ->  { documents: [{ loca_id, document }], warnings }
//   POST /api/diggs     body: DIGGS XML file   ->  { documents: [{ loca_id, document }], warnings }
//   POST /api/validate  body: boring log JSON  ->  { valid, errors, warnings }
//   POST /api/site      body: { name?, borings: [boring log JSON, ...] }, a bare
//                       array of them, or an AGS4 / DIGGS file (every borehole
//                       with strata)  ->  the site page (HTML: 3D model,
//                       suggested cross-sections, logs and map) or, with
//                       ?format=json, the summary, sections (with SVGs) and
//                       3D model as data
//   POST /api/site/section  same body; ?id=A (a suggested section) or
//                       ?line=lat,lon;lat,lon[;...]  ->  SVG, PNG, HTML or JSON
//   GET  /api/schema                           ->  the JSON Schema
//   GET  /api/health                           ->  { status, version }
import Fastify from 'fastify';
import rateLimit from '@fastify/rate-limit';
import { Resvg } from '@resvg/resvg-js';
import { readFileSync } from 'node:fs';
import {
    renderBoringLog, validateBoringLog, schema, DEFAULT_COLUMNS, agsToBoringLogs, looksLikeAgs, AgsError, diggsToBoringLogs, looksLikeDiggs, DiggsError,
} from '../src/index.js';
import { escapeXml } from '../src/text.js';
import { renderSection, placeAlongLine, lineLength, lineBearing, MAX_SECTION_LENGTH } from '../src/section.js';
import { siteBorings, siteSummary, siteModel } from '../src/site.js';
import { loadFonts } from './fonts.js';
import { sitePage } from './sitepage.js';

const { version } = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));

const FORMATS = {
    svg: 'image/svg+xml',
    png: 'image/png',
    html: 'text/html',
};
const MAX_LAYERS = 2000;
const MAX_SAMPLES = 5000;
const specimenCount = doc => (Array.isArray(doc?.samples) ? doc.samples : []).reduce((n, s) => n + (Array.isArray(s?.specimens) ? s.specimens.length : 0), 0);
const MAX_PNG_PIXELS = 40e6;
const MAX_BORINGS = 200;

// Parses a query-string boolean; undefined when absent.
function flag(value, name, problems) {
    if (value === undefined) return undefined;
    if (['1', 'true', 'yes'].includes(value)) return true;
    if (['0', 'false', 'no'].includes(value)) return false;
    problems.push({ path: `?${name}`, message: 'must be true or false' });
    return undefined;
}

function number(value, name, min, max, problems) {
    if (value === undefined) return undefined;
    const n = Number(value);
    if (!Number.isFinite(n) || n < min || n > max) {
        problems.push({ path: `?${name}`, message: `must be a number from ${min} to ${max}` });
        return undefined;
    }
    return n;
}

// Render options from the query string. Unknown parameters are rejected so
// a typo (e.g. ?unit=ft) is reported instead of silently ignored.
// `custom` lists the custom column ids of the document's layout, which ?columns may use.
export function parseQuery(query, custom = []) {
    const problems = [];
    const known = new Set(['format', 'units', 'unit_weight', 'diameter_units', 'width', 'height', 'scale', 'png_scale',
        'fit_text', 'font_size', 'columns', 'hide_empty_columns', 'header', 'legend', 'references', 'infer_uscs', 'infer_materials', 'title', 'id_prefix', 'download', 'loca_id']);
    for (const key of Object.keys(query)) {
        if (!known.has(key)) problems.push({ path: `?${key}`, message: 'unknown query parameter' });
    }
    const options = {};
    const set = (key, value) => { if (value !== undefined) options[key] = value; };
    const oneOf = (key, allowed) => {
        const v = query[key];
        if (v === undefined) return;
        if (allowed.includes(v)) options[key] = v;
        else problems.push({ path: `?${key}`, message: `must be one of: ${allowed.join(', ')}` });
    };
    oneOf('units', ['m', 'ft']);
    oneOf('unit_weight', ['kN/m3', 'pcf']);
    oneOf('diameter_units', ['mm', 'cm', 'm', 'in', 'ft']);
    set('width', number(query.width, 'width', 300, 4000, problems));
    set('height', number(query.height, 'height', 50, 20000, problems));
    set('scale', number(query.scale, 'scale', 0.1, 10000, problems));
    set('font_size', number(query.font_size, 'font_size', 6, 24, problems));
    for (const key of ['fit_text', 'hide_empty_columns', 'header', 'legend', 'references', 'infer_uscs', 'infer_materials']) set(key, flag(query[key], key, problems));
    if (query.title !== undefined) options.title = String(query.title).slice(0, 200);
    if (query.id_prefix !== undefined) {
        if (/^[A-Za-z][\w-]{0,40}$/.test(query.id_prefix)) options.id_prefix = query.id_prefix;
        else problems.push({ path: '?id_prefix', message: 'must start with a letter and contain only letters, digits, _ or -' });
    }
    if (query.columns !== undefined) {
        const columns = String(query.columns).split(',').map(c => c.trim()).filter(Boolean);
        // Built-in columns, or custom ones from the document's layout.
        const all = new Set([...DEFAULT_COLUMNS, 'energy_ratio', ...custom]);
        const unknown = columns.filter(c => !all.has(c));
        if (unknown.length) problems.push({ path: '?columns', message: `unknown column(s): ${unknown.join(', ')}${custom.length ? '' : ' (custom columns must be in the document\'s layout)'}` });
        else options.columns = columns;
    }
    const pngScale = number(query.png_scale, 'png_scale', 0.5, 4, problems) ?? 2;
    const download = flag(query.download, 'download', problems) ?? false;
    const locaId = query.loca_id === undefined ? undefined : String(query.loca_id);
    return { options, pngScale, download, locaId, problems };
}

// Output format: ?format= wins; otherwise the first acceptable type in the
// Accept header; otherwise SVG.
export function chooseFormat(queryFormat, accept) {
    if (queryFormat !== undefined) return FORMATS[queryFormat] ? queryFormat : null;
    if (!accept) return 'svg';
    const wanted = accept.split(',')
        .map((part, i) => {
            const [type, ...params] = part.trim().split(';');
            const q = params.map(p => p.trim()).find(p => p.startsWith('q='));
            return { type: type.trim().toLowerCase(), q: q ? Number(q.slice(2)) : 1, i };
        })
        .filter(w => w.q > 0)
        .sort((a, b) => b.q - a.q || a.i - b.i);
    for (const { type } of wanted) {
        if (type === '*/*' || type === 'image/*') return 'svg';
        const hit = Object.entries(FORMATS).find(([, mime]) => mime === type);
        if (hit) return hit[0];
        if (type === 'application/xhtml+xml') return 'html';
    }
    return null;
}

function htmlPage(svg, title) {
    return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeXml(title)}</title>
<style>
body { margin: 0; background: #fff; }
svg { display: block; max-width: 100%; height: auto; }
@media print { @page { margin: 10mm; } svg { width: 100%; } }
</style>
</head>
<body>
${svg}
</body>
</html>
`;
}

function filename(doc, ext) {
    const name = doc?.metadata?.boring_name ?? 'boring-log';
    return `${String(name).replace(/[^A-Za-z0-9._-]+/g, '_').replace(/^_+|_+$/g, '') || 'boring-log'}.${ext}`;
}

// Options of the site endpoints from the query string; unknown parameters are
// rejected, as for /api/render.
export function parseSiteQuery(query, section = false) {
    const problems = [];
    const known = new Set(['format', 'name', 'units', 'style', 'width', 'download', 'svg', 'grid', 'png_scale', 'id', 'line', 'corridor', 'title']);
    const only = section ? ['grid', 'svg'] : ['png_scale', 'id', 'line', 'corridor', 'title'];
    for (const key of Object.keys(query)) {
        if (!known.has(key) || only.includes(key)) problems.push({ path: `?${key}`, message: 'unknown query parameter' });
    }
    const oneOf = (key, allowed) => {
        const v = query[key];
        if (v === undefined || allowed.includes(v)) return v;
        problems.push({ path: `?${key}`, message: `must be one of: ${allowed.join(', ')}` });
        return undefined;
    };
    const out = {
        format: oneOf('format', section ? ['svg', 'png', 'html', 'json'] : ['html', 'json']),
        name: query.name === undefined ? undefined : String(query.name).slice(0, 200),
        units: oneOf('units', ['m', 'ft']),
        style: oneOf('style', ['colour', 'hatch']),
        width: number(query.width, 'width', 400, 6000, problems),
        download: flag(query.download, 'download', problems) ?? false,
        svg: flag(query.svg, 'svg', problems) ?? true,
        grid: number(query.grid, 'grid', 2, 100, problems),
        pngScale: number(query.png_scale, 'png_scale', 0.5, 4, problems) ?? 2,
        corridor: number(query.corridor, 'corridor', 1, 5000, problems),
        title: query.title === undefined ? undefined : String(query.title).slice(0, 200),
        id: query.id === undefined ? undefined : String(query.id),
        line: undefined,
    };
    if (out.grid !== undefined && !Number.isInteger(out.grid)) problems.push({ path: '?grid', message: 'must be a whole number' });
    if (query.line !== undefined) {
        const points = String(query.line).split(';').map(p => p.split(',').map(Number));
        if (points.length < 2 || points.length > 50 || points.some(p => p.length !== 2 || !p.every(Number.isFinite) || Math.abs(p[0]) > 90 || Math.abs(p[1]) > 180)) {
            problems.push({ path: '?line', message: 'must be 2 to 50 points as lat,lon;lat,lon;...' });
        } else {
            out.line = points.map(([lat, lon]) => ({ lat, lon }));
            const length = lineLength(out.line);
            if (length > MAX_SECTION_LENGTH) problems.push({ path: '?line', message: `is ${(length / 1000).toFixed(1)} km long; a section line can be at most ${MAX_SECTION_LENGTH / 1000} km` });
        }
    }
    if (section && (out.id === undefined) === (out.line === undefined)) problems.push({ path: '?id', message: 'give either ?id= (a suggested section, e.g. A) or ?line=lat,lon;lat,lon' });
    if (out.corridor !== undefined && out.line === undefined && section) problems.push({ path: '?corridor', message: 'only used with ?line=' });
    return { ...out, problems };
}

const safeName = (name, fallback) => String(name ?? '').replace(/[^A-Za-z0-9._-]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 80) || fallback;

// bodyLimit applies to JSON; AGS4 and DIGGS files, which carry whole projects,
// may be up to fileBodyLimit.
export async function buildApp({ logger = false, rateLimitMax = 60, bodyLimit = 1024 * 1024, fileBodyLimit = 10 * 1024 * 1024, trustProxy = '127.0.0.1' } = {}) {
    const app = Fastify({ logger, bodyLimit: Math.max(bodyLimit, fileBodyLimit), trustProxy });
    const fontFiles = loadFonts();

    // The API is public and takes no credentials, so any site may call it.
    app.addHook('onRequest', async (request, reply) => {
        reply.header('Access-Control-Allow-Origin', '*');
        reply.header('Access-Control-Expose-Headers', 'Content-Disposition');
        reply.header('X-Content-Type-Options', 'nosniff');
    });
    app.options('/api/*', async (request, reply) => {
        reply
            .header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
            .header('Access-Control-Allow-Headers', 'Content-Type, Accept')
            .header('Access-Control-Max-Age', '86400')
            .code(204)
            .send();
    });

    await app.register(rateLimit, {
        max: rateLimitMax,
        timeWindow: '1 minute',
        errorResponseBuilder: (request, context) => ({
            statusCode: 429,
            error: 'Too many requests',
            message: `Rate limit is ${context.max} requests per minute; retry in ${Math.ceil(context.ttl / 1000)} s.`,
        }),
    });

    // Own JSON parser, so a syntax error reports JSON.parse's message (with
    // its position) rather than Fastify's generic one.
    app.removeAllContentTypeParsers();
    const tooLarge = limit => Object.assign(new Error('too large'), { statusCode: 413, code: 'FST_ERR_CTP_BODY_TOO_LARGE', limit });
    app.addContentTypeParser('application/json', { parseAs: 'string' }, (request, body, done) => {
        // A site carries many borings, so it may be as large as a file.
        const limit = request.url.startsWith('/api/site') ? Math.max(bodyLimit, fileBodyLimit) : bodyLimit;
        if (Buffer.byteLength(body) > limit) return done(tooLarge(limit));
        if (body.trim() === '') return done(Object.assign(new Error('empty body'), { statusCode: 400, code: 'EMPTY_BODY' }));
        try {
            done(null, JSON.parse(body));
        } catch (e) {
            done(Object.assign(new Error(e.message), { statusCode: 400, code: 'INVALID_JSON' }));
        }
    });
    // AGS4 files arrive as plain text, DIGGS files as XML.
    app.addContentTypeParser(['text/plain', 'application/x-ags', 'text/csv', 'application/xml', 'text/xml'], { parseAs: 'string' }, (request, body, done) => {
        if (Buffer.byteLength(body) > fileBodyLimit) return done(tooLarge(fileBodyLimit));
        done(null, body);
    });

    // Error bodies share one shape: { error, errors: [{ path, message }] }.
    app.setErrorHandler((err, request, reply) => {
        if (err.statusCode === 429) return reply.code(429).send(err);
        if (err.code === 'FST_ERR_CTP_BODY_TOO_LARGE') {
            return reply.code(413).send({ error: 'Request body too large', errors: [{ path: '', message: `limit is ${err.limit ?? fileBodyLimit} bytes` }] });
        }
        if (err.code === 'FST_ERR_CTP_INVALID_MEDIA_TYPE') {
            return reply.code(415).send({ error: 'Unsupported Content-Type', errors: [{ path: '', message: 'send the boring log as application/json, an AGS4 file as text/plain, or a DIGGS file as application/xml' }] });
        }
        if (err.code === 'EMPTY_BODY') {
            return reply.code(400).send({ error: 'Empty request body', errors: [{ path: '', message: 'send the boring log JSON as the request body' }] });
        }
        if (err.code === 'INVALID_JSON') {
            return reply.code(400).send({ error: 'Invalid JSON', errors: [{ path: '', message: err.message }] });
        }
        request.log.error(err);
        return reply.code(500).send({ error: 'Internal server error', errors: [] });
    });
    app.setNotFoundHandler((request, reply) => {
        reply.code(404).send({ error: 'Not found', errors: [{ path: request.url, message: 'see GET /api/health for the available endpoints' }] });
    });

    // Validates the body and applies API size limits. Returns the validation
    // result, or sends an error reply and returns null.
    function checkDocument(doc, reply) {
        const result = validateBoringLog(doc);
        const errors = [...result.errors];
        if (Array.isArray(doc?.layers) && doc.layers.length > MAX_LAYERS) errors.push({ path: '/layers', message: `at most ${MAX_LAYERS} layers per request` });
        if (Array.isArray(doc?.samples) && doc.samples.length > MAX_SAMPLES) errors.push({ path: '/samples', message: `at most ${MAX_SAMPLES} samples per request` });
        if (specimenCount(doc) > MAX_SAMPLES) errors.push({ path: '/samples', message: `at most ${MAX_SAMPLES} specimens per request` });
        if (errors.length) {
            reply.code(422).send({ error: 'Invalid boring log', errors, warnings: result.warnings });
            return null;
        }
        return result;
    }

    app.get('/api/health', async () => ({
        status: 'ok',
        version,
        endpoints: ['POST /api/render', 'POST /api/ags', 'POST /api/diggs', 'POST /api/validate', 'POST /api/site', 'POST /api/site/section', 'GET /api/schema', 'GET /api/health'],
    }));

    app.get('/api/schema', async (request, reply) => reply.type('application/schema+json').send(schema));

    app.post('/api/validate', async (request) => validateBoringLog(request.body));

    // Converts an AGS4 or DIGGS file (kind 'ags', 'diggs', or either), or sends
    // an error reply and returns null.
    const FILE_KINDS = {
        ags: { label: 'AGS4', looks: looksLikeAgs, convert: agsToBoringLogs, Err: AgsError, how: 'an AGS4 file with Content-Type: text/plain' },
        diggs: { label: 'DIGGS', looks: looksLikeDiggs, convert: diggsToBoringLogs, Err: DiggsError, how: 'a DIGGS XML file with Content-Type: application/xml' },
    };
    function fromFile(text, reply, only) {
        const kinds = only ? [FILE_KINDS[only]] : Object.values(FILE_KINDS);
        const kind = typeof text === 'string' ? kinds.find(k => k.looks(text)) : null;
        if (!kind) {
            const what = kinds.map(k => k.label).join(' or ');
            reply.code(400).send({ error: `Not ${only === 'diggs' ? 'a' : 'an'} ${what} file`, errors: [{ path: '', message: `send ${kinds.map(k => k.how).join(', or ')}` }] });
            return null;
        }
        try {
            return { ...kind.convert(text), kind };
        } catch (e) {
            if (!(e instanceof kind.Err)) throw e;
            reply.code(422).send({ error: `Invalid ${kind.label} file`, errors: [{ path: '', message: e.message }] });
            return null;
        }
    }

    for (const only of ['ags', 'diggs']) {
        app.post(`/api/${only}`, async (request, reply) => {
            const converted = fromFile(request.body, reply, only);
            if (!converted) return reply;
            return { documents: converted.documents, warnings: converted.warnings };
        });
    }

    app.post('/api/render', async (request, reply) => {
        const format = chooseFormat(request.query.format, request.headers.accept);
        if (!format) {
            return reply.code(406).send({
                error: 'Unsupported output format',
                errors: [{ path: request.query.format !== undefined ? '?format' : 'Accept', message: `use one of: ${Object.keys(FORMATS).join(', ')}` }],
            });
        }
        const body = request.body;
        const custom = body && typeof body === 'object' && Array.isArray(body.layout?.columns) ? body.layout.columns.filter(e => e?.source && typeof e.id === 'string').map(e => e.id) : [];
        const { options, pngScale, download, locaId, problems } = parseQuery(request.query, custom);
        if (problems.length) return reply.code(400).send({ error: 'Invalid query parameters', errors: problems });

        let doc = request.body;
        if (typeof doc === 'string') {
            // An AGS4 or DIGGS file: draw one of its boreholes.
            const converted = fromFile(doc, reply);
            if (!converted) return reply;
            const ids = converted.documents.map(d => d.loca_id);
            const pick = locaId !== undefined ? converted.documents.find(d => d.loca_id === locaId) : converted.documents.length === 1 ? converted.documents[0] : null;
            if (!pick) {
                return reply.code(422).send({
                    error: locaId !== undefined ? 'Borehole not found' : 'Choose a borehole',
                    errors: [{ path: '?loca_id', message: `the file has ${ids.length} borehole${ids.length === 1 ? '' : 's'}: ${ids.slice(0, 50).join(', ')}${ids.length > 50 ? ', ...' : ''}; choose one with ?loca_id=` }],
                });
            }
            if (!pick.document.layers.length) {
                return reply.code(422).send({
                    error: 'Nothing to draw',
                    errors: [{ path: '/layers', message: `borehole ${pick.loca_id} has no strata (${converted.kind.label === 'AGS4' ? 'GEOL rows with a top and base' : 'LithologyObservations with a depth'})` }],
                });
            }
            doc = pick.document;
        } else if (locaId !== undefined) {
            return reply.code(400).send({ error: 'Invalid query parameters', errors: [{ path: '?loca_id', message: 'only used with an AGS4 or DIGGS file' }] });
        }
        const result = checkDocument(doc, reply);
        if (!result) return reply;

        const svg = renderBoringLog(doc, options);
        if (result.warnings.length) {
            // Header values must be single-line ASCII.
            reply.header('X-Boring-Log-Warnings', result.warnings.map(w => `${w.path}: ${w.message}`).join('; ').replace(/[^\x20-\x7e]/g, '?').slice(0, 1000));
        }
        const disposition = (ext) => reply.header('Content-Disposition', `${download ? 'attachment' : 'inline'}; filename="${filename(doc, ext)}"`);

        if (format === 'svg') {
            disposition('svg');
            return reply.type('image/svg+xml; charset=utf-8').send(`<?xml version="1.0" encoding="UTF-8"?>\n${svg}\n`);
        }
        if (format === 'html') {
            disposition('html');
            return reply.type('text/html; charset=utf-8').send(htmlPage(svg, options.title ?? doc.metadata?.boring_name ?? 'Boring log'));
        }
        const [, w, h] = svg.match(/^<svg [^>]*width="(\d+)" height="(\d+)"/);
        if (w * h * pngScale * pngScale > MAX_PNG_PIXELS) {
            return reply.code(422).send({
                error: 'Image too large',
                errors: [{ path: '?png_scale', message: `${w}×${h} px at ${pngScale}× exceeds ${MAX_PNG_PIXELS / 1e6} megapixels; lower png_scale or use format=svg` }],
            });
        }
        const png = new Resvg(svg, {
            fitTo: { mode: 'zoom', value: pngScale },
            font: { fontFiles, loadSystemFonts: false, defaultFontFamily: 'Arimo' },
        }).render().asPng();
        disposition('png');
        return reply.type('image/png').send(png);
    });

    // The borings of a site from the request body, validated, or sends an
    // error reply and returns null: { name, docs, warnings }.
    function siteFromBody(body, reply, name) {
        let docs;
        let fileWarnings = [];
        if (typeof body === 'string') {
            const converted = fromFile(body, reply);
            if (!converted) return null;
            docs = converted.documents.filter(d => d.document.layers.length).map(d => d.document);
            fileWarnings = converted.warnings.map(w => (typeof w === 'string' ? { path: '', message: w } : w));
            const skipped = converted.documents.length - docs.length;
            if (skipped) fileWarnings.push({ path: '', message: `${skipped} borehole${skipped === 1 ? '' : 's'} without strata left out` });
        } else if (Array.isArray(body)) {
            docs = body;
        } else if (body && typeof body === 'object' && Array.isArray(body.borings)) {
            docs = body.borings;
            if (name === undefined && typeof body.name === 'string') name = body.name.slice(0, 200);
        } else {
            reply.code(400).send({ error: 'Invalid site', errors: [{ path: '', message: 'send { "name": "...", "borings": [boring log, ...] }, an array of boring logs, or an AGS4 or DIGGS file' }] });
            return null;
        }
        if (!docs.length) {
            reply.code(422).send({ error: 'Invalid site', errors: [{ path: '/borings', message: 'no borings' }] });
            return null;
        }
        if (docs.length > MAX_BORINGS) {
            reply.code(422).send({ error: 'Invalid site', errors: [{ path: '/borings', message: `at most ${MAX_BORINGS} borings per request` }] });
            return null;
        }
        const errors = [];
        const warnings = [...fileWarnings];
        const prefix = typeof body === 'string' ? '/documents' : '/borings';
        docs.forEach((doc, i) => {
            const result = validateBoringLog(doc);
            const at = e => ({ ...e, path: `${prefix}/${i}${e.path}` });
            errors.push(...result.errors.map(at));
            warnings.push(...result.warnings.map(at));
            if (Array.isArray(doc?.layers) && doc.layers.length > MAX_LAYERS) errors.push({ path: `${prefix}/${i}/layers`, message: `at most ${MAX_LAYERS} layers per boring` });
            if (Array.isArray(doc?.samples) && doc.samples.length > MAX_SAMPLES) errors.push({ path: `${prefix}/${i}/samples`, message: `at most ${MAX_SAMPLES} samples per boring` });
            if (specimenCount(doc) > MAX_SAMPLES) errors.push({ path: `${prefix}/${i}/samples`, message: `at most ${MAX_SAMPLES} specimens per boring` });
        });
        if (errors.length) {
            reply.code(422).send({ error: 'Invalid boring log', errors: errors.slice(0, 200), warnings: warnings.slice(0, 200) });
            return null;
        }
        return { name, docs, warnings };
    }

    // Options for renderSection; those not given are left out, so its defaults apply.
    const sectionOptions = (q, s) => Object.fromEntries(Object.entries({
        length: s.length, style: q.style, units: q.units, width: q.width, id: s.id, bearing: lineBearing(s.line) ?? undefined,
        title: q.title ?? `Cross-section ${s.id}–${s.id}′`, id_prefix: `s${String(s.id).replace(/[^A-Za-z0-9]/g, '')}`,
    }).filter(([, v]) => v !== undefined));

    app.post('/api/site', async (request, reply) => {
        const q = parseSiteQuery(request.query);
        if (q.problems.length) return reply.code(400).send({ error: 'Invalid query parameters', errors: q.problems });
        const site = siteFromBody(request.body, reply, q.name);
        if (!site) return reply;
        const format = q.format ?? (request.headers.accept?.includes('application/json') && !request.headers.accept.includes('text/html') ? 'json' : 'html');
        const file = safeName(site.name, 'site');
        if (format === 'html') {
            const html = sitePage({ name: site.name, borings: site.docs });
            if (!html) return reply.code(503).send({ error: 'Site page not built', errors: [{ path: '', message: 'run npm run build on the server, or use ?format=json' }] });
            reply.header('Content-Disposition', `${q.download ? 'attachment' : 'inline'}; filename="${file}.html"`);
            return reply.type('text/html; charset=utf-8').send(html);
        }
        const summary = siteSummary(site.docs);
        const borings = siteBorings(site.docs);
        const located = borings.filter(b => b.lat !== null);
        const warnings = [...site.warnings];
        const unlocated = borings.length - located.length;
        if (unlocated) warnings.push({ path: '', message: `${unlocated} boring${unlocated === 1 ? ' has' : 's have'} no coordinates, so ${unlocated === 1 ? 'it is' : 'they are'} left out of the sections and the 3D model` });
        const sections = summary.sections.map(s => {
            if (!q.svg) return s;
            const { svg, warnings: w } = renderSection(placeAlongLine(located, s.line, s.corridor), sectionOptions(q, s));
            return { ...s, svg, warnings: w };
        });
        if (q.download) reply.header('Content-Disposition', `attachment; filename="${file}.json"`);
        return {
            name: site.name ?? null,
            borings: summary.borings,
            sections,
            model: siteModel(borings, { grid: q.grid ?? 0 }),
            warnings,
        };
    });

    app.post('/api/site/section', async (request, reply) => {
        const q = parseSiteQuery(request.query, true);
        if (q.problems.length) return reply.code(400).send({ error: 'Invalid query parameters', errors: q.problems });
        const site = siteFromBody(request.body, reply, q.name);
        if (!site) return reply;
        const borings = siteBorings(site.docs);
        const located = borings.filter(b => b.lat !== null);
        let s;
        if (q.id !== undefined) {
            const all = siteSummary(site.docs).sections;
            s = all.find(x => x.id === q.id);
            if (!s) {
                return reply.code(404).send({ error: 'Section not found', errors: [{ path: '?id', message: all.length ? `the suggested sections are ${all.map(x => x.id).join(', ')}` : 'this site has no suggested sections (it needs two or more borings with coordinates)' }] });
            }
        } else {
            const corridor = q.corridor ?? 100;
            const placed = placeAlongLine(located, q.line, corridor);
            s = {
                id: 'A', name: 'Cross-section', kind: 'line', description: 'Along the line given.', line: q.line, corridor, length: Math.round(lineLength(q.line) * 10) / 10,
                borings: placed.map(p => ({ name: p.name, index: p.index, chainage: Math.round(p.chainage * 10) / 10, offset: Math.round(p.offset * 10) / 10, side: p.side })),
            };
        }
        const placed = placeAlongLine(located, s.line, s.corridor);
        if (!placed.length) {
            return reply.code(422).send({ error: 'Nothing to draw', errors: [{ path: '?line', message: `no boring with coordinates within ${s.corridor} m of the line; widen ?corridor=` }] });
        }
        const { svg, warnings } = renderSection(placed, sectionOptions(q, s));
        const format = q.format ?? chooseFormat(undefined, request.headers.accept) ?? 'svg';
        const file = `${safeName(site.name, 'site')}_section_${safeName(s.id, 'A')}`;
        const disposition = ext => reply.header('Content-Disposition', `${q.download ? 'attachment' : 'inline'}; filename="${file}.${ext}"`);
        if (format === 'json') return { ...s, svg, warnings };
        if (format === 'svg') {
            disposition('svg');
            return reply.type('image/svg+xml; charset=utf-8').send(`<?xml version="1.0" encoding="UTF-8"?>\n${svg}\n`);
        }
        if (format === 'html') {
            disposition('html');
            return reply.type('text/html; charset=utf-8').send(htmlPage(svg, q.title ?? `${site.name ? `${site.name}: ` : ''}Cross-section ${s.id}–${s.id}′`));
        }
        const [, w, h] = svg.match(/^<svg [^>]*width="([\d.]+)" height="([\d.]+)"/);
        if (w * h * q.pngScale * q.pngScale > MAX_PNG_PIXELS) {
            return reply.code(422).send({ error: 'Image too large', errors: [{ path: '?png_scale', message: `${w}×${h} px at ${q.pngScale}× exceeds ${MAX_PNG_PIXELS / 1e6} megapixels; lower png_scale or use format=svg` }] });
        }
        const png = new Resvg(svg, { fitTo: { mode: 'zoom', value: q.pngScale }, font: { fontFiles, loadSystemFonts: false, defaultFontFamily: 'Arimo' } }).render().asPng();
        disposition('png');
        return reply.type('image/png').send(png);
    });

    return app;
}
