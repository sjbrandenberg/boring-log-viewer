// Input cleanup shared by the validator and the renderer. Kept free of
// dependencies so the renderer can run without Ajv.

import { LITHOLOGY } from './lithology.js';
import { SAMPLER_NAMES } from './samplers.js';
import { cleanSvg, svgDataUri } from './svg-pattern.js';

export class BoringLogError extends Error {
    constructor(message, issues = []) {
        super(message);
        this.name = 'BoringLogError';
        this.issues = issues;
    }
}

// Database exports carry null for every missing value; treat null as "not
// given" by dropping those keys (recursively) instead of making every schema
// field nullable.
export function stripNulls(value) {
    if (Array.isArray(value)) return value.map(stripNulls);
    if (value && typeof value === 'object') {
        const out = {};
        for (const [k, v] of Object.entries(value)) {
            if (v !== null && v !== undefined) out[k] = stripNulls(v);
        }
        return out;
    }
    return value;
}

const USCS_CODES = new Set(['GW', 'GP', 'GM', 'GC', 'SW', 'SP', 'SM', 'SC', 'ML', 'CL', 'OL', 'MH', 'CH', 'OH', 'PT']);
// Built-in hatches for other materials and rock (FILL, SANDSTONE, ...)
const BUILT_IN_HATCHES = new Set([...USCS_CODES, ...Object.keys(LITHOLOGY)]);
const BUILT_IN_SAMPLERS = new Set(Object.keys(SAMPLER_NAMES));

// Checks the schema cannot express: a layer's hatch must be a USCS symbol or a
// soil pattern defined in the document, and a sample's type a built-in sampler
// or a sampler pattern defined in it.
const IMAGE_URI = /^data:image\/(png|jpeg|svg\+xml);base64,[A-Za-z0-9+/]+={0,2}$/;

// Each custom pattern's picture: its "svg" markup, cleaned, or its "image" data
// URI; checked here rather than only by the schema because the renderer can be
// called without validation, and only these may go into the log.
// Returns { images: { code: { image, width, height } }, issues }.
export function patternImages(doc) {
    const images = {};
    const issues = [];
    const patterns = doc?.patterns && typeof doc.patterns === 'object' ? doc.patterns : {};
    for (const [code, p] of Object.entries(patterns)) {
        if (p && typeof p === 'object' && p.svg !== undefined) {
            try {
                const { svg, width, height } = cleanSvg(p.svg);
                const w = p.width > 0 && p.height > 0 ? p.width : width;
                const h = p.width > 0 && p.height > 0 ? p.height : height;
                images[code] = { image: svgDataUri(svg), width: w, height: h };
            } catch (e) {
                issues.push({ path: `/patterns/${code}/svg`, message: e.message });
            }
            continue;
        }
        if (!p || typeof p.image !== 'string' || !IMAGE_URI.test(p.image)) {
            issues.push({ path: `/patterns/${code}`, message: 'needs "svg" (SVG markup) or "image" (a base64 data URI of a PNG, JPEG or SVG image)' });
            continue;
        }
        if (!(p.width > 0) || !(p.height > 0)) {
            issues.push({ path: `/patterns/${code}`, message: 'needs a positive width and height' });
            continue;
        }
        images[code] = { image: p.image, width: p.width, height: p.height };
    }
    return { images, issues };
}

export function checkPatternReferences(doc) {
    const errors = [];
    const patterns = doc.patterns && typeof doc.patterns === 'object' ? doc.patterns : {};
    const kindOf = code => (patterns[code] ? patterns[code].kind ?? 'soil' : null);
    (Array.isArray(doc.layers) ? doc.layers : []).forEach((layer, i) => {
        if (typeof layer?.hatch !== 'string' || layer.hatch === 'none') return;
        for (const code of layer.hatch.split(/[-/]/)) {
            const kind = kindOf(code);
            if (kind === 'sampler') errors.push({ path: `/layers/${i}/hatch`, message: `"${code}" is a sampler pattern, not a soil pattern` });
            else if (!kind && !BUILT_IN_HATCHES.has(code)) errors.push({ path: `/layers/${i}/hatch`, message: `unknown pattern "${code}": use a USCS symbol, a built-in hatch such as FILL or SANDSTONE, or define it in patterns` });
        }
    });
    (Array.isArray(doc.samples) ? doc.samples : []).forEach((sample, i) => {
        const type = sample?.type;
        if (typeof type !== 'string' || BUILT_IN_SAMPLERS.has(type)) return;
        const kind = kindOf(type);
        if (kind === 'soil') errors.push({ path: `/samples/${i}/type`, message: `"${type}" is a soil pattern; give it "kind": "sampler" to use it as a sampler symbol` });
        else if (!kind) errors.push({ path: `/samples/${i}/type`, message: `unknown sampler type "${type}": use a built-in type or define it in patterns` });
    });
    return errors;
}

// Checks the schema cannot express: intervals must have bottom > top.
// Overlapping layers are a warning; the renderer draws them anyway.
export function checkDepths(doc) {
    const errors = [];
    const warnings = [];
    const intervals = (list, name) => {
        (list ?? []).forEach((item, i) => {
            if (typeof item?.top === 'number' && typeof item?.bottom === 'number' && !(item.bottom > item.top)) {
                errors.push({ path: `/${name}/${i}`, message: `bottom (${item.bottom}) must be greater than top (${item.top})` });
            }
        });
    };
    intervals(doc.layers, 'layers');
    intervals(doc.samples, 'samples');

    const layers = (doc.layers ?? [])
        .map((l, i) => ({ ...l, i }))
        .filter(l => typeof l.top === 'number' && typeof l.bottom === 'number')
        .sort((a, b) => a.top - b.top);
    for (let k = 1; k < layers.length; k++) {
        const prev = layers[k - 1];
        const cur = layers[k];
        if (cur.top < prev.bottom - 1e-9) {
            warnings.push({ path: `/layers/${cur.i}`, message: `overlaps layer ${prev.i} (${prev.top}–${prev.bottom})` });
        } else if (cur.top > prev.bottom + 1e-9) {
            warnings.push({ path: `/layers/${cur.i}`, message: `gap between ${prev.bottom} and ${cur.top} (no layer described)` });
        }
    }
    return { errors, warnings };
}

// Returns a cleaned copy: nulls dropped, units defaulted, lists sorted by depth.
// Throws BoringLogError if the document cannot be drawn at all.
export function normalizeBoringLog(input) {
    let doc = input;
    if (typeof doc === 'string') {
        try {
            doc = JSON.parse(doc);
        } catch (e) {
            throw new BoringLogError(`Invalid JSON: ${e.message}`, [{ path: '', message: e.message }]);
        }
    }
    if (!doc || typeof doc !== 'object' || Array.isArray(doc)) {
        throw new BoringLogError('A boring log must be a JSON object', [{ path: '', message: 'must be object' }]);
    }
    doc = stripNulls(doc);

    const issues = [];
    if (!Array.isArray(doc.layers) || doc.layers.length === 0) {
        issues.push({ path: '/layers', message: 'must be a non-empty array' });
    }
    for (const name of ['layers', 'samples', 'groundwater', 'depth_notes']) {
        if (doc[name] !== undefined && !Array.isArray(doc[name])) issues.push({ path: `/${name}`, message: 'must be an array' });
    }
    const numeric = (list, name, fields) => {
        (Array.isArray(list) ? list : []).forEach((item, i) => {
            for (const f of fields) {
                if (typeof item?.[f] !== 'number' || !Number.isFinite(item[f])) {
                    issues.push({ path: `/${name}/${i}/${f}`, message: 'must be a number' });
                }
            }
        });
    };
    numeric(doc.layers, 'layers', ['top', 'bottom']);
    numeric(doc.samples, 'samples', ['top', 'bottom']);
    numeric(doc.groundwater, 'groundwater', ['depth']);
    numeric(doc.depth_notes, 'depth_notes', ['depth']);
    issues.push(...checkDepths(doc).errors, ...checkPatternReferences(doc));
    const pictures = patternImages(doc);
    issues.push(...pictures.issues);
    if (issues.length) {
        throw new BoringLogError(`Boring log has ${issues.length} problem${issues.length > 1 ? 's' : ''}`, issues);
    }

    const byTop = (a, b) => a.top - b.top || a.bottom - b.bottom;
    return {
        ...doc,
        units: { length: 'm', unit_weight: 'kN/m3', diameter: 'mm', ...doc.units },
        metadata: { ...doc.metadata },
        // Patterns carry their picture as an image data URI, whichever way it was given.
        ...(doc.patterns && typeof doc.patterns === 'object'
            ? { patterns: Object.fromEntries(Object.entries(doc.patterns).map(([code, p]) => [code, { ...p, ...pictures.images[code] }])) }
            : {}),
        layers: [...doc.layers].sort(byTop),
        samples: [...(doc.samples ?? [])].sort(byTop),
        groundwater: [...(doc.groundwater ?? [])].sort((a, b) => a.depth - b.depth),
        // A note without text has nothing to draw.
        depth_notes: (doc.depth_notes ?? []).filter(n => n.description).sort((a, b) => a.depth - b.depth),
    };
}
