// HTTP API for rendering boring logs. Built as a function so tests can drive
// it with fastify.inject() without opening a port.
//
//   POST /api/render    body: boring log JSON  ->  SVG, PNG or HTML
//   POST /api/validate  body: boring log JSON  ->  { valid, errors, warnings }
//   GET  /api/schema                           ->  the JSON Schema
//   GET  /api/health                           ->  { status, version }
import Fastify from 'fastify';
import rateLimit from '@fastify/rate-limit';
import { Resvg } from '@resvg/resvg-js';
import { readFileSync } from 'node:fs';
import { renderBoringLog, validateBoringLog, schema, DEFAULT_COLUMNS } from '../src/index.js';
import { escapeXml } from '../src/text.js';
import { loadFonts } from './fonts.js';

const { version } = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));

const FORMATS = {
    svg: 'image/svg+xml',
    png: 'image/png',
    html: 'text/html',
};
const MAX_LAYERS = 2000;
const MAX_SAMPLES = 5000;
const MAX_PNG_PIXELS = 40e6;

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
export function parseQuery(query) {
    const problems = [];
    const known = new Set(['format', 'units', 'unit_weight', 'diameter_units', 'width', 'height', 'scale', 'png_scale',
        'fit_text', 'font_size', 'columns', 'hide_empty_columns', 'header', 'legend', 'infer_uscs', 'title', 'id_prefix', 'download']);
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
    for (const key of ['fit_text', 'hide_empty_columns', 'header', 'legend', 'infer_uscs']) set(key, flag(query[key], key, problems));
    if (query.title !== undefined) options.title = String(query.title).slice(0, 200);
    if (query.id_prefix !== undefined) {
        if (/^[A-Za-z][\w-]{0,40}$/.test(query.id_prefix)) options.id_prefix = query.id_prefix;
        else problems.push({ path: '?id_prefix', message: 'must start with a letter and contain only letters, digits, _ or -' });
    }
    if (query.columns !== undefined) {
        const columns = String(query.columns).split(',').map(c => c.trim()).filter(Boolean);
        const all = new Set([...DEFAULT_COLUMNS, 'energy_ratio']);
        const unknown = columns.filter(c => !all.has(c));
        if (unknown.length) problems.push({ path: '?columns', message: `unknown column(s): ${unknown.join(', ')}` });
        else options.columns = columns;
    }
    const pngScale = number(query.png_scale, 'png_scale', 0.5, 4, problems) ?? 2;
    const download = flag(query.download, 'download', problems) ?? false;
    return { options, pngScale, download, problems };
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

export async function buildApp({ logger = false, rateLimitMax = 60, bodyLimit = 1024 * 1024, trustProxy = '127.0.0.1' } = {}) {
    const app = Fastify({ logger, bodyLimit, trustProxy });
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
    app.addContentTypeParser('application/json', { parseAs: 'string' }, (request, body, done) => {
        if (body.trim() === '') return done(Object.assign(new Error('empty body'), { statusCode: 400, code: 'EMPTY_BODY' }));
        try {
            done(null, JSON.parse(body));
        } catch (e) {
            done(Object.assign(new Error(e.message), { statusCode: 400, code: 'INVALID_JSON' }));
        }
    });

    // Error bodies share one shape: { error, errors: [{ path, message }] }.
    app.setErrorHandler((err, request, reply) => {
        if (err.statusCode === 429) return reply.code(429).send(err);
        if (err.code === 'FST_ERR_CTP_BODY_TOO_LARGE') {
            return reply.code(413).send({ error: 'Request body too large', errors: [{ path: '', message: `limit is ${bodyLimit} bytes` }] });
        }
        if (err.code === 'FST_ERR_CTP_INVALID_MEDIA_TYPE') {
            return reply.code(415).send({ error: 'Unsupported Content-Type', errors: [{ path: '', message: 'send the boring log as application/json' }] });
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
        if (errors.length) {
            reply.code(422).send({ error: 'Invalid boring log', errors, warnings: result.warnings });
            return null;
        }
        return result;
    }

    app.get('/api/health', async () => ({
        status: 'ok',
        version,
        endpoints: ['POST /api/render', 'POST /api/validate', 'GET /api/schema', 'GET /api/health'],
    }));

    app.get('/api/schema', async (request, reply) => reply.type('application/schema+json').send(schema));

    app.post('/api/validate', async (request) => validateBoringLog(request.body));

    app.post('/api/render', async (request, reply) => {
        const format = chooseFormat(request.query.format, request.headers.accept);
        if (!format) {
            return reply.code(406).send({
                error: 'Unsupported output format',
                errors: [{ path: request.query.format !== undefined ? '?format' : 'Accept', message: `use one of: ${Object.keys(FORMATS).join(', ')}` }],
            });
        }
        const { options, pngScale, download, problems } = parseQuery(request.query);
        if (problems.length) return reply.code(400).send({ error: 'Invalid query parameters', errors: problems });

        const doc = request.body;
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

    return app;
}
