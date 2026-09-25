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

// ASTM D2487 group names for the dual symbols it uses; other pairs are named
// from their two parts in the legend.
export const DUAL_NAMES = {
    'GW-GM': 'Well-graded gravel with silt',
    'GW-GC': 'Well-graded gravel with clay',
    'GP-GM': 'Poorly graded gravel with silt',
    'GP-GC': 'Poorly graded gravel with clay',
    'GC-GM': 'Silty clayey gravel',
    'SW-SM': 'Well-graded sand with silt',
    'SW-SC': 'Well-graded sand with clay',
    'SP-SM': 'Poorly graded sand with silt',
    'SP-SC': 'Poorly graded sand with clay',
    'SC-SM': 'Silty clayey sand',
    'CL-ML': 'Silty clay',
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

    // Sorting is the geologist's inverse of grading: "well-sorted" sand is
    // poorly graded, and "poorly sorted" sand is well graded.
    const words = text.toLowerCase().split(/[^a-z]+/).filter(Boolean)
        .flatMap((w, i, all) => (all[i + 1] === 'sorted' && (w === 'well' || w === 'poorly') ? [w === 'well' ? 'poorly' : 'well'] : [w]));
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

// ---------------------------------------------------------------- USCS inference
//
// inferUscs() is deliberately stricter than inferHatch(): its result is shown as a
// classification (in parentheses), so it only answers when the description
// fixes the symbol. The rules were reviewed against real NGL layer descriptions
// (tests/fixtures/uscs-review.json):
//   A  a USCS symbol written in the description, e.g. "(SP-SM)" or a leading "SC:"
//   B  an ASTM D2487 group name at the principal soil: "poorly graded SAND with
//      silt" SP-SM, "silty SAND" SM, "fat CLAY" CH, "elastic SILT" MH, "PEAT" PT
//   C  CLAY with a plasticity descriptor: high CH, low CL
//   D1 "silty clay" CL-ML
//   D2 other SILT group names ("SILT", "sandy SILT", "SILT with sand") ML
//   D3 SILT with high plasticity MH
//   D4 organic SILT/CLAY: low plasticity or non-plastic OL, high plasticity OH
// Mixed layers ("interbedded", "SAND to silty SAND", two main soils), ranges
// ("lean to fat CLAY"), bare SAND or GRAVEL, and "clayey SILT" get no symbol.

// Dual symbols D2487 uses
const DUALS = new Set(['GW-GM', 'GW-GC', 'GP-GM', 'GP-GC', 'SW-SM', 'SW-SC', 'SP-SM', 'SP-SC', 'GC-GM', 'SC-SM', 'CL-ML']);
const SYMBOLS_ANYWHERE = new RegExp(`(?<![A-Za-z])(${SYMBOL})(?:\\s*[-/]\\s*(${SYMBOL}))?(?![A-Za-z])`, 'g');
const LEADING_LABEL = new RegExp(`^\\s*(${SYMBOL})(?:\\s*[-/]\\s*(${SYMBOL}))?\\s*:`);
// "Gravel: SW, subangular" / "Gravel/cobbles: SW": NZ logs use SW here for
// "slightly weathered" (weathering grades UW, SW, MW, HW, CW), not the USCS symbol.
const PARTICLE_CLAUSE = /\b(?:gravel|cobbles?|boulders?)(?:\s*\/\s*(?:gravel|cobbles?|boulders?))*\s*:\s*[^.;]*/gi;
const SOILS = ['gravel', 'sand', 'silt', 'clay', 'peat'];
const MINOR_WORDS = new Set(['with', 'trace', 'some', 'minor', 'little', 'occasional', 'lenses', 'lens', 'layers', 'layer',
    'seams', 'seam', 'pockets', 'pocket', 'interbedded', 'interlayered', 'of', 'and', 'containing', 'contains', 'few',
    'bands', 'band', 'partings']);

function soilTokens(text) {
    return (text.match(/[A-Za-z][A-Za-z-]*/g) || []).map(raw => {
        const w = raw.toLowerCase().replace(/-+$/, '');
        return { raw, w: /^(gravel|sand|silt|clay)s$/.test(w) ? w.slice(0, -1) : w };
    });
}

const introducedAt = (tokens, i) => tokens.slice(Math.max(0, i - 3), i).some(t => MINOR_WORDS.has(t.w));

// The principal soil noun: an all-caps soil word (log convention), otherwise the
// first soil word not introduced by a minor-constituent word such as "with".
function principalIndex(tokens) {
    const isSoil = i => SOILS.includes(tokens[i].w);
    for (let i = 0; i < tokens.length; i++) {
        if (isSoil(i) && tokens[i].raw.length > 2 && tokens[i].raw === tokens[i].raw.toUpperCase()) return i;
    }
    for (let i = 0; i < tokens.length; i++) if (isSoil(i) && !introducedAt(tokens, i)) return i;
    return -1;
}

function symbolFitsSoil(symbol, noun) {
    if (noun === 'gravel') return symbol[0] === 'G';
    if (noun === 'sand') return symbol[0] === 'S';
    if (noun === 'silt' || noun === 'clay') return ['M', 'C', 'O'].includes(symbol[0]);
    if (noun === 'peat') return symbol === 'PT' || symbol[0] === 'O';
    return true;
}

function isMixedDescription(text) {
    const t = text.toLowerCase();
    if (/\b(interbedded|interlayered|alternating|interlaminated|layered)\b/.test(t)) return true;
    const soil = '(?:gravel|sand|silt|clay|peat)s?';
    return new RegExp(`\\b${soil}\\b\\s*(?:and|or|to|/|&)\\s*(?:\\w+\\s+){0,2}${soil}\\b`).test(t);
}

// Returns { uscs, rule } for a material description, or null when the
// description doesn't determine a symbol.
export function inferUscs(description) {
    if (!description || !String(description).trim()) return null;
    const text = String(description).trim();
    const tokens = soilTokens(text);
    const p = principalIndex(tokens);

    // A: a symbol written in the text (outside particle clauses).
    const found = [...new Set([...text.replace(PARTICLE_CLAUSE, ' ').matchAll(SYMBOLS_ANYWHERE)]
        .map(m => (m[2] ? `${m[1]}-${m[2]}` : m[1])))];
    if (found.length > 1) return null;
    if (found.length === 1) {
        const s = found[0];
        if (s.includes('-') && !DUALS.has(s)) return null;
        // A leading "SC:" is the log author's own label; anywhere else the symbol
        // must fit the principal soil. One that doesn't (an "SW" on a SILT layer)
        // is something else, so it is ignored and the other rules apply.
        if (LEADING_LABEL.test(text) || p < 0 || symbolFitsSoil(s, tokens[p].w)) return { uscs: s, rule: 'A' };
    }

    if (p < 0 || isMixedDescription(text)) return null;
    // Two different main soils in the first sentence or clause mean a mixed layer
    // (later sentences, like "Gravels are fine to coarse", describe constituents).
    const firstClause = soilTokens(text.split(/[.;]\s/)[0]);
    const mainSoils = new Set(firstClause.map((t, i) => (SOILS.includes(t.w) && !introducedAt(firstClause, i) ? t.w : null)).filter(Boolean));
    if (mainSoils.size > 1) return null;
    if (/\b(lean|fat|low|high)\s+to\s+(lean|fat|low|high|medium)\b/i.test(text)) return null;

    const noun = tokens[p].w;
    const before = tokens.slice(Math.max(0, p - 3), p).map(t => t.w);
    const b1 = before[before.length - 1] || '';
    const b2 = before.slice(-2).join(' ');
    const after = tokens.slice(p + 1, p + 3).map(t => t.w);
    const lower = text.toLowerCase();
    const high = /\b(high(ly)?[\s-]+plastic(ity)?)\b/.test(lower);
    const low = /\b(low[\s-]+plasticity|non[\s-]?plastic)\b/.test(lower);
    const result = (uscs, rule) => ({ uscs, rule });

    if (noun === 'peat') return result('PT', 'B');
    if (noun === 'sand' || noun === 'gravel') {
        const L = noun === 'sand' ? 'S' : 'G';
        const grading = b2 === 'poorly graded' || b1 === 'poorly-graded' ? 'P' : b2 === 'well graded' || b1 === 'well-graded' ? 'W' : '';
        const fines = after[0] === 'with' ? (after[1] === 'silt' ? 'M' : after[1] === 'clay' ? 'C' : '') : '';
        if (grading) return result(fines ? `${L}${grading}-${L}${fines}` : `${L}${grading}`, 'B');
        if (b1 === 'clayey' && before.includes('silty')) return result(`${L}C-${L}M`, 'B');
        if (b1 === 'silty') return result(`${L}M`, 'B');
        if (b1 === 'clayey') return result(`${L}C`, 'B');
        return null;
    }
    // "Organic SILT" is OL/OH; "organic stained SILT" is neither an organic soil
    // nor clearly inorganic, so it gets no symbol.
    const organicAt = before.lastIndexOf('organic');
    if (organicAt >= 0 && /^stain/.test(before[organicAt + 1] || '')) return null;
    if (organicAt >= 0) {
        if (high && !low) return result('OH', 'D4');
        if (low && !high) return result('OL', 'D4');
        return null;
    }
    if (noun === 'clay') {
        if (b1 === 'lean') return result('CL', 'B');
        if (b1 === 'fat') return result('CH', 'B');
        if (b1 === 'silty') return result('CL-ML', 'D1');
        if (high && !low) return result('CH', 'C');
        if (low && !high) return result('CL', 'C');
        return null;
    }
    if (noun === 'silt') {
        if (b1 === 'elastic') return result('MH', 'B');
        if (high && !low) return result('MH', 'D3');
        if (b1 === 'clayey') return null;
        return result('ML', 'D2');
    }
    return null;
}

// Resolves the hatch to draw for a layer: explicit hatch, then USCS (recorded,
// then strictly inferred), then the looser keyword inference. Returns an array
// of 0, 1 or 2 codes.
export function layerHatch(layer) {
    const code = layer.hatch ?? layer.uscs ?? layer.uscs_inferred ?? inferHatch(layer.description);
    if (!code || code === 'none') return [];
    return code.split(/[-/]/);
}
