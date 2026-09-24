// Picks a graphic-log hatch for a layer. Ported from coastal_database's
// get_hatch_code.js, with its early return fixed (the keyword fallback never
// ran, so layers without a USCS symbol in the text got no hatch).

export const USCS_SYMBOLS = ['GW', 'GP', 'GM', 'GC', 'SW', 'SP', 'SM', 'SC', 'ML', 'CL', 'OL', 'MH', 'CH', 'OH', 'PT'];

export const USCS_NAMES = {
    GW: 'Well-graded gravel',
    GP: 'Poorly graded gravel',
    GM: 'Silty gravel',
    GC: 'Clayey gravel',
    SW: 'Well-graded sand',
    SP: 'Poorly graded sand',
    SM: 'Silty sand',
    SC: 'Clayey sand',
    ML: 'Silt',
    CL: 'Lean clay',
    OL: 'Organic silt or clay (low plasticity)',
    MH: 'Elastic silt',
    CH: 'Fat clay',
    OH: 'Organic silt or clay (high plasticity)',
    PT: 'Peat',
};

const SYMBOL = USCS_SYMBOLS.join('|');
const SYMBOL_IN_TEXT = new RegExp(`(?<![A-Za-z])(${SYMBOL})(?:[-/](${SYMBOL}))?(?![A-Za-z])`);

// Keywords that point to each group symbol, per principal soil type. On a tie
// the first entry wins, so the most common default for each type comes first.
const KEYWORDS = {
    gravel: { GP: ['poorly', 'graded', 'uniform', 'uniformly'], GW: ['well', 'graded', 'sandy'], GM: ['silty', 'silt'], GC: ['clayey', 'clay'] },
    sand: { SP: ['poorly', 'graded', 'uniform', 'uniformly'], SW: ['well', 'graded', 'gravelly'], SM: ['silty', 'silt'], SC: ['clayey', 'clay'] },
    silt: { ML: ['lean', 'low', 'plasticity', 'sandy', 'nonplastic'], MH: ['elastic', 'fat', 'high', 'plasticity'] },
    clay: { CL: ['lean', 'low', 'plasticity', 'sandy', 'silty'], CH: ['fat', 'high', 'plasticity'] },
};
const MINOR_MARKERS = new Set(['with', 'trace', 'some', 'little', 'and', 'occasional']);

// Returns a hatch code ('SM', 'SP-SM', ...) or null if none can be inferred.
export function inferHatch(description) {
    if (!description) return null;
    const text = String(description);

    // 1. An explicit group symbol anywhere in the description, e.g. "(SP-SM)".
    const symbol = text.match(SYMBOL_IN_TEXT);
    if (symbol) return symbol[2] ? `${symbol[1]}-${symbol[2]}` : symbol[1];

    const words = text.toLowerCase().split(/[^a-z]+/).filter(Boolean);
    if (words.includes('peat')) return 'PT';

    // 2. The principal soil type. Logs conventionally capitalize it
    // ("silty SAND with gravel"), so prefer an all-caps noun; otherwise take
    // the first noun not introduced by a minor-constituent word like "with".
    const original = text.split(/[^A-Za-z]+/).filter(Boolean);
    const types = Object.keys(KEYWORDS);
    let principal = original.map(w => w.toLowerCase()).find((w, i) => types.includes(w) && original[i] === original[i].toUpperCase());
    if (!principal) {
        principal = words.find((w, i) => types.includes(w) && !MINOR_MARKERS.has(words[i - 1]));
    }
    if (!principal) principal = words.find(w => types.includes(w));
    if (!principal) return null;

    const organic = words.includes('organic');
    if (organic && (principal === 'silt' || principal === 'clay')) {
        return words.some(w => ['fat', 'high', 'elastic'].includes(w)) ? 'OH' : 'OL';
    }

    // 3. The group symbol whose keywords overlap the description most.
    let best = null;
    let bestScore = -1;
    for (const [code, keys] of Object.entries(KEYWORDS[principal])) {
        const score = keys.reduce((n, k) => n + (words.includes(k) ? 1 : 0), 0);
        if (score > bestScore) {
            best = code;
            bestScore = score;
        }
    }
    return best;
}

// Resolves the hatch to draw for a layer: explicit hatch, then USCS, then
// inference from the description. Returns an array of 0, 1 or 2 codes.
export function layerHatch(layer) {
    const code = layer.hatch ?? layer.uscs ?? inferHatch(layer.description);
    if (!code || code === 'none') return [];
    return code.split(/[-/]/);
}
