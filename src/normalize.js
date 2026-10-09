// Input cleanup shared by the validator and the renderer. Kept free of
// dependencies so the renderer can run without Ajv.

import { LITHOLOGY } from './lithology.js';
import { SAMPLER_NAMES } from './samplers.js';
import { cleanSvg, svgDataUri } from './svg-pattern.js';
import { BUILT_IN_COLUMNS } from './columns.js';

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

// "No recovery" is the outcome of a sample, not a sampler type or a sample
// number, but it is often entered as one ("type": "NoRecovery", "name": "NR").
// Such samples are read as recovery 0 (shown as "No recovery" in the remarks)
// with a warning. A custom sampler pattern with that code is left alone.
const NO_RECOVERY_TEXT = /^\s*(no[\s_.-]*(sample[\s_.-]*)?rec(overy|\.)?|n\.?\s?r\.?|not[\s_-]*recovered)\s*$/i;

export function fixNoRecoverySamples(doc) {
    const warnings = [];
    if (!doc || typeof doc !== 'object' || !Array.isArray(doc.samples)) return { doc, warnings };
    const patterns = doc.patterns && typeof doc.patterns === 'object' ? doc.patterns : {};
    let changed = false;
    const samples = doc.samples.map((sample, i) => {
        if (!sample || typeof sample !== 'object') return sample;
        const out = { ...sample };
        let fixed = false;
        if (typeof out.type === 'string' && NO_RECOVERY_TEXT.test(out.type) && !Object.prototype.hasOwnProperty.call(patterns, out.type)) {
            warnings.push({ path: `/samples/${i}/type`, message: `"${out.type}" is not a sampler type; read as no recovery (use the sampler that was tried as "type" and "recovery": 0)` });
            delete out.type;
            fixed = true;
        }
        if (typeof out.name === 'string' && NO_RECOVERY_TEXT.test(out.name)) {
            warnings.push({ path: `/samples/${i}/name`, message: `"${out.name}" is not a sample number; read as no recovery (use "recovery": 0)` });
            delete out.name;
            fixed = true;
        }
        if (!fixed) return sample;
        changed = true;
        out.recovery = 0;
        return out;
    });
    return { doc: changed ? { ...doc, samples } : doc, warnings };
}

// Lab results belong to specimens (NGL: SAMP -> SPEC -> INDX, PLAS). Results
// given on a sample itself, as in older documents, are kept as a specimen with
// no depths of its own: its results are shown level with the sample, but no
// specimen box is made up for it.
export const LAB_FIELDS = ['water_content', 'total_unit_weight', 'dry_unit_weight', 'specific_gravity', 'fines_content', 'liquid_limit', 'plastic_limit', 'nonplastic'];
const SAMPLE_LAB_FIELDS = LAB_FIELDS.filter(f => f !== 'total_unit_weight');

export function sampleLabWarnings(doc) {
    const warnings = [];
    (Array.isArray(doc?.samples) ? doc.samples : []).forEach((s, i) => {
        if (typeof s?.description === 'string' && s.description) warnings.push({ path: `/samples/${i}/description`, message: 'samples have remarks, not a description: it is shown at the start of the sample remarks; put it in "remarks"' });
        const fields = SAMPLE_LAB_FIELDS.filter(f => s?.[f] !== undefined);
        if (fields.length) warnings.push({ path: `/samples/${i}`, message: `lab results on the sample (${fields.join(', ')}) are shown level with the sample, without a specimen box; give them in "specimens" with the specimen's top and bottom` });
    });
    return warnings;
}

// A sample's specimens. One with a top (SPEC_TOP) is `located`: drawn as a box
// from its top to its bottom (or at its top when there is no bottom). One without
// is not drawn as a box; its row is placed by its sample's depths.
export function specimensOf(sample) {
    const out = [];
    const legacy = {};
    for (const f of SAMPLE_LAB_FIELDS) if (sample?.[f] !== undefined) legacy[f] = sample[f];
    if (Object.keys(legacy).length) out.push({ top: sample.top, bottom: sample.bottom, ...legacy, located: false });
    for (const sp of (Array.isArray(sample?.specimens) ? sample.specimens : [])) {
        if (!sp || typeof sp !== 'object') continue;
        if (typeof sp.top === 'number') out.push({ ...sp, bottom: sp.bottom ?? sp.top, located: true });
        else out.push({ ...sp, top: sample.top, bottom: sample.bottom, located: false });
    }
    return out;
}

// The note on a sample's recovery shown in the remarks: "No recovery", or
// "Recovery 0.36 m (80%)" with the length converted by `toDisplay`. The sample's
// top and bottom must already be in the display units.
export function recoveryRemark(sample, toDisplay = v => v, unit = '') {
    const rec = sample?.recovery;
    if (typeof rec !== 'number' || !Number.isFinite(rec)) return undefined;
    if (rec <= 0) return 'No recovery';
    const len = sample.bottom - sample.top;
    const display = toDisplay(rec);
    const shown = Number(display.toFixed(2));
    const pct = len > 0 ? ` (${Math.round((display / len) * 100)}%)` : '';
    return `Recovery ${shown}${unit ? ` ${unit}` : ''}${pct}`;
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

// Checks the schema cannot express for `layout.columns`: a built-in id, or a new
// id with a source; no id twice.
export function checkLayout(doc) {
    const errors = [];
    const columns = doc?.layout?.columns;
    if (!Array.isArray(columns)) return errors;
    const seen = new Set();
    columns.forEach((entry, i) => {
        const path = `/layout/columns/${i}`;
        const id = typeof entry === 'string' ? entry : entry?.id;
        if (typeof id !== 'string') return; // reported by the schema
        const builtIn = BUILT_IN_COLUMNS.includes(id);
        if (seen.has(id)) errors.push({ path, message: `column "${id}" is listed twice` });
        seen.add(id);
        if (builtIn && entry?.source) errors.push({ path: `${path}/source`, message: `"${id}" is a built-in column; give a custom column an id of its own` });
        if (!builtIn && !entry?.source) {
            errors.push({ path, message: `unknown column "${id}": use a built-in column (${BUILT_IN_COLUMNS.join(', ')}), or give a custom column a "source" ("sample", "specimen" or "blank")` });
        }
    });
    return errors;
}

// Checks the schema cannot express: intervals must have bottom > top.
// Overlapping layers are a warning; the renderer draws them anyway.
export function checkDepths(doc) {
    const errors = [];
    const warnings = [];
    const intervals = (list, name) => {
        if (!Array.isArray(list)) return; // reported by the schema
        list.forEach((item, i) => {
            if (typeof item?.top === 'number' && typeof item?.bottom === 'number' && !(item.bottom > item.top)) {
                errors.push({ path: `/${name}/${i}`, message: `bottom (${item.bottom}) must be greater than top (${item.top})` });
            }
        });
    };
    intervals(doc.layers, 'layers');
    intervals(doc.samples, 'samples');
    // A specimen may be at a single depth (bottom = top), and should lie within its sample.
    (Array.isArray(doc.samples) ? doc.samples : []).forEach((sample, i) => {
        (Array.isArray(sample?.specimens) ? sample.specimens : []).forEach((sp, k) => {
            const path = `/samples/${i}/specimens/${k}`;
            if (typeof sp?.top === 'number' && typeof sp?.bottom === 'number' && sp.bottom < sp.top) {
                errors.push({ path, message: `bottom (${sp.bottom}) must not be less than top (${sp.top})` });
                return;
            }
            if (typeof sp?.top !== 'number') return;
            const top = sp.top;
            const bottom = sp.bottom ?? sp.top;
            if (typeof bottom === 'number' && typeof sample.top === 'number' && typeof sample.bottom === 'number'
                && (top < sample.top - 1e-9 || bottom > sample.bottom + 1e-9)) {
                warnings.push({ path, message: `specimen (${top}–${bottom}) is outside its sample (${sample.top}–${sample.bottom})` });
            }
        });
    });

    const layers = (Array.isArray(doc.layers) ? doc.layers : [])
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
    doc = fixNoRecoverySamples(stripNulls(doc)).doc;

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
    (Array.isArray(doc.samples) ? doc.samples : []).forEach((sample, i) => {
        if (sample?.specimens === undefined) return;
        if (!Array.isArray(sample.specimens)) {
            issues.push({ path: `/samples/${i}/specimens`, message: 'must be an array' });
            return;
        }
        sample.specimens.forEach((sp, k) => {
            for (const f of ['top', 'bottom']) {
                if (sp?.[f] !== undefined && (typeof sp[f] !== 'number' || !Number.isFinite(sp[f]))) issues.push({ path: `/samples/${i}/specimens/${k}/${f}`, message: 'must be a number' });
            }
        });
    });
    numeric(doc.groundwater, 'groundwater', ['depth']);
    numeric(doc.depth_notes, 'depth_notes', ['depth']);
    issues.push(...checkDepths(doc).errors, ...checkPatternReferences(doc), ...checkLayout(doc));
    const pictures = patternImages(doc);
    issues.push(...pictures.issues);
    if (issues.length) {
        throw new BoringLogError(`Boring log has ${issues.length} problem${issues.length > 1 ? 's' : ''}`, issues);
    }

    const byTop = (a, b) => a.top - b.top || a.bottom - b.bottom;
    const samples = [...(doc.samples ?? [])].sort(byTop);
    // Every specimen, with the sample it was cut from; the samples keep only their own fields.
    const specimens = samples.flatMap((s, i) => specimensOf(s).map(sp => ({ ...sp, sample: s.name, sample_index: i }))).sort(byTop);
    const bareSamples = samples.map(s => {
        const out = { ...s };
        delete out.specimens;
        // A sample's text is its remarks; a description (older documents) goes first in them.
        if (typeof out.description === 'string' && out.description) out.remarks = out.remarks ? `${out.description}; ${out.remarks}` : out.description;
        delete out.description;
        for (const f of SAMPLE_LAB_FIELDS) delete out[f];
        return out;
    });
    return {
        ...doc,
        units: { length: 'm', unit_weight: 'kN/m3', diameter: 'mm', ...doc.units },
        metadata: { ...doc.metadata },
        // Patterns carry their picture as an image data URI, whichever way it was given.
        ...(doc.patterns && typeof doc.patterns === 'object'
            ? { patterns: Object.fromEntries(Object.entries(doc.patterns).map(([code, p]) => [code, { ...p, ...pictures.images[code] }])) }
            : {}),
        layers: [...doc.layers].sort(byTop),
        samples: bareSamples,
        // (Only when there are any, so documents without specimens keep their pattern ids.)
        ...(specimens.length ? { specimens } : {}),
        groundwater: [...(doc.groundwater ?? [])].sort((a, b) => a.depth - b.depth),
        // A note without text has nothing to draw.
        depth_notes: (doc.depth_notes ?? []).filter(n => n.description).sort((a, b) => a.depth - b.depth),
        // (Only when given, so documents without references keep their pattern ids.)
        ...(Array.isArray(doc.references) ? { references: doc.references.filter(r => r && typeof r.text === 'string' && r.text.trim()) } : {}),
    };
}
