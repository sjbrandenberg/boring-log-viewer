// Input cleanup shared by the validator and the renderer. Kept free of
// dependencies so the renderer can run without Ajv.

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
    for (const name of ['layers', 'samples', 'groundwater']) {
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
    issues.push(...checkDepths(doc).errors);
    if (issues.length) {
        throw new BoringLogError(`Boring log has ${issues.length} problem${issues.length > 1 ? 's' : ''}`, issues);
    }

    const byTop = (a, b) => a.top - b.top || a.bottom - b.bottom;
    return {
        ...doc,
        units: { length: 'm', unit_weight: 'kN/m3', diameter: 'mm', ...doc.units },
        metadata: { ...doc.metadata },
        layers: [...doc.layers].sort(byTop),
        samples: [...(doc.samples ?? [])].sort(byTop),
        groundwater: [...(doc.groundwater ?? [])].sort((a, b) => a.depth - b.depth),
    };
}
