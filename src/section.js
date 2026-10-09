// Cross-sections: borings placed along a line drawn on the map, with layers
// connected between neighbouring borings where they are the same main soil.
// Pure functions, like render.js: no DOM, so they run in the browser and in tests.
//
// The connections are an automatic interpretation, not a geologic model:
//   - each boring's layers are grouped into units: consecutive layers of the
//     same main soil (gravel, sand, silt, clay, organic) or material (fill,
//     pavement, rock...);
//   - units of neighbouring borings are matched top to bottom by sequence
//     alignment (no crossing connections), only between units of the same
//     main soil, preferring units at similar depths or elevations;
//   - a unit with no match pinches out between the two borings.
import { normalizeBoringLog } from './normalize.js';
import { checkUscs, describedUscs, inferUscs, layerHatch, USCS_SYMBOLS } from './classify.js';
import { inferMaterial } from './materials.js';
import { HATCH_TILES } from './hatches.js';
import { LITHOLOGY } from './lithology.js';
import { builtInTile, hatchName } from './render.js';
import { FONT_FAMILY, measureText, escapeXml } from './text.js';

const TO_M = { m: 1, ft: 0.3048 };
const r = n => Math.round(n * 100) / 100;

// ---------------------------------------------------------------- the line

// Positions on a local flat projection, in metres from the line's first point.
function projector(origin) {
    const k = Math.cos((origin.lat * Math.PI) / 180);
    return p => ({ x: (p.lon - origin.lon) * 111320 * k, y: (p.lat - origin.lat) * 110540 });
}

// Places points along a polyline: for each point, the distance along the line
// to its nearest position on it (chainage) and the distance from the line
// (offset), both in metres. line: [{ lat, lon }, ...] with 2 or more vertices.
// Returns the points within `corridor` metres, sorted by chainage, each with
// { chainage, offset, side } added (side: 'L' or 'R' looking along the line).
// Points beyond either end of the line are left out.
export function placeAlongLine(points, line, corridor = 100) {
    if (!Array.isArray(line) || line.length < 2) return [];
    const proj = projector(line[0]);
    const verts = line.map(proj);
    const out = [];
    for (const p of points) {
        const q = proj(p);
        let best = null;
        let along = 0;
        for (let i = 0; i < verts.length - 1; i++) {
            const a = verts[i];
            const b = verts[i + 1];
            const dx = b.x - a.x;
            const dy = b.y - a.y;
            const len2 = dx * dx + dy * dy;
            const len = Math.sqrt(len2);
            if (len === 0) continue;
            const t = ((q.x - a.x) * dx + (q.y - a.y) * dy) / len2;
            const first = i === 0;
            const last = i === verts.length - 2;
            // A small tolerance (2 % or 5 m) past the line's ends.
            const tol = Math.max(0.02, 5 / len);
            if ((t < 0 && (!first || t < -tol)) || (t > 1 && (!last || t > 1 + tol))) {
                along += len;
                continue;
            }
            const tc = Math.min(1, Math.max(0, t));
            const cx = a.x + tc * dx;
            const cy = a.y + tc * dy;
            const offset = Math.hypot(q.x - cx, q.y - cy);
            if (!best || offset < best.offset) {
                const cross = dx * (q.y - a.y) - dy * (q.x - a.x);
                best = { chainage: along + tc * len, offset, side: cross > 0 ? 'L' : 'R' };
            }
            along += len;
        }
        if (best && best.offset <= corridor) out.push({ ...p, ...best });
    }
    return out.sort((a, b) => a.chainage - b.chainage);
}

// The longest cross-section (or 3D slice) line that can be drawn, m.
export const MAX_SECTION_LENGTH = 10000;

export function lineLength(line) {
    if (!Array.isArray(line) || line.length < 2) return 0;
    const v = line.map(projector(line[0]));
    let len = 0;
    for (let i = 1; i < v.length; i++) len += Math.hypot(v[i].x - v[i - 1].x, v[i].y - v[i - 1].y);
    return len;
}

// Direction of a section line from its first point (A) to its last (A′):
// degrees clockwise from north. Null for a line without length.
export function lineBearing(line) {
    if (!Array.isArray(line) || line.length < 2) return null;
    const proj = projector(line[0]);
    const end = proj(line[line.length - 1]);
    if (Math.hypot(end.x, end.y) < 1e-6) return null;
    return (Math.atan2(end.x, end.y) * 180 / Math.PI + 360) % 360;
}

const POINTS = ['N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE', 'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW'];
// The 16-point compass name of a bearing (degrees).
export const compassPoint = deg => POINTS[Math.round((((deg % 360) + 360) % 360) / 22.5) % 16];

// ---------------------------------------------------------------- layers and units

// Silt and clay are kept apart (CL connects to CH, never to ML).
const MAIN_SOIL = { G: 'gravel', S: 'sand', M: 'silt', C: 'clay', O: 'organic', P: 'organic' };
const PAVEMENT = new Set(['ASPHALT', 'CONCRETE', 'BASE_COURSE']);

// The kind of material a hatch code stands for, for matching between borings:
// a USCS main soil, or a material class. Null for intervals that should never
// connect (no recovery, water, voids) and unknown codes.
export function soilClass(code) {
    if (!code) return null;
    const uscs = code.split('-').filter(c => USCS_SYMBOLS.includes(c));
    // CL-ML (ASTM D2487 "silty clay", also written ML-CL) is a clay.
    if (uscs.some(c => c[0] === 'C') && uscs.some(c => c[0] === 'M')) return ['clay'];
    if (uscs.length) return uscs.map(c => MAIN_SOIL[c[0]]);
    const info = LITHOLOGY[code];
    if (!info) return null;
    if (info.group === 'Non-material intervals') return null;
    if (info.group === 'Fill and man-made') return [PAVEMENT.has(code) ? 'pavement' : 'fill'];
    if (info.group.startsWith('Rock')) return ['rock'];
    return [code];
}

// Colours for the layers between borings (style 'colour'): one per main soil,
// with silt and clay apart, and for fill, pavement, rock and other materials.
export const SECTION_COLOURS = {
    gravel: { fill: '#f6c08f', name: 'Gravel' },
    sand: { fill: '#fbe38e', name: 'Sand' },
    silt: { fill: '#d3e9bd', name: 'Silt' },
    clay: { fill: '#93c591', name: 'Clay' },
    organic: { fill: '#b9a08c', name: 'Organic soil or peat' },
    fill: { fill: '#d6d6d6', name: 'Fill' },
    pavement: { fill: '#a8a8a8', name: 'Pavement' },
    rock: { fill: '#c3b9d9', name: 'Rock' },
    other: { fill: '#ece2cf', name: 'Other material' },
};
const COLOUR_OF_LETTER = { G: 'gravel', S: 'sand', M: 'silt', C: 'clay', O: 'organic', P: 'organic' };

export function colourClass(code) {
    if (!code) return null;
    const parts = code.split('-');
    const first = parts[0];
    if (USCS_SYMBOLS.includes(first)) return parts.some(c => c[0] === 'C') && parts.some(c => c[0] === 'M') ? 'clay' : COLOUR_OF_LETTER[first[0]];
    const info = LITHOLOGY[code];
    if (!info || info.group === 'Non-material intervals') return null;
    if (info.group === 'Fill and man-made') return PAVEMENT.has(code) ? 'pavement' : 'fill';
    if (info.group.startsWith('Rock')) return 'rock';
    if (code === 'TOPSOIL') return 'organic';
    return 'other';
}

const ADJECTIVE = {
    GW: 'well-graded', GP: 'poorly graded', GM: 'silty', GC: 'clayey', SW: 'well-graded', SP: 'poorly graded', SM: 'silty', SC: 'clayey',
    ML: '', MH: 'elastic', CL: 'lean', CH: 'fat', OL: 'organic', OH: 'organic', PT: '',
};
const NOUN = { G: 'GRAVEL', S: 'SAND', M: 'SILT', C: 'CLAY', O: 'SOIL', P: 'PEAT' };

// A short name for a group of layers, from their hatch codes (thickest first):
// ['SC', 'SM'] -> 'Clayey and silty SAND (SC, SM)', ['ML', 'CL'] ->
// 'SILT and lean CLAY (ML, CL)', ['FILL'] -> 'Fill'.
export function unitLabel(codes, guessed = new Set()) {
    const groups = new Map();
    const add = (noun, adj) => {
        if (!groups.has(noun)) groups.set(noun, []);
        if (adj && !groups.get(noun).includes(adj)) groups.get(noun).push(adj);
    };
    const uscs = [];
    for (const code of codes) {
        const parts = code.split('-');
        if (USCS_SYMBOLS.includes(parts[0])) {
            uscs.push(code);
            // CL-ML (or ML-CL) is ASTM's silty clay.
            if (parts.some(c => c[0] === 'C') && parts.some(c => c[0] === 'M')) {
                add(NOUN.C, 'silty');
                continue;
            }
            const main = parts[0][0];
            for (const part of parts) {
                if (!USCS_SYMBOLS.includes(part)) continue;
                // A dual symbol of one main soil (SP-SM) adds its adjectives to that soil.
                const noun = part[0] === main || part[0] === 'O' ? NOUN[main] : NOUN[part[0]];
                add(noun, ADJECTIVE[part]);
            }
        } else if (LITHOLOGY[code]) add(LITHOLOGY[code].name, '');
    }
    const list = words => (words.length > 1 ? `${words.slice(0, -1).join(', ')} and ${words[words.length - 1]}` : words[0] ?? '');
    const textOf = list([...groups].map(([noun, adjs]) => (adjs.length ? `${list(adjs)} ${noun}` : noun)));
    const label = textOf.charAt(0).toUpperCase() + textOf.slice(1);
    return uscs.length ? `${label} (${uscs.map(c => (guessed.has(c) ? `${c}*` : c)).join(', ')})` : label;
}

// A layer's hatch codes, as the boring log draws them (recorded hatch, a
// material named in the description, USCS recorded or inferred).
// A recorded USCS value that isn't a possible symbol (GP-GW, SM-ML) is
// replaced in the section by our guess: the symbol read from the description,
// else its first real group symbol. Returns { codes, guess } where guess is
// { from, to, how } when that happened.
export function layerCodes(l, opt) {
    // A heading such as "GRAVEL AND SAND:" that reads as a mixed layer is looked past ("...silty sand with gravels" is SM).
        const described = opt.infer_uscs && !l.uscs && !l.hatch ? describedUscs(l.description) : null;
        const inferred = described ? { uscs: described } : null;
    const material = opt.infer_materials && !l.hatch ? inferMaterial(l.description) : null;
    let uscs = l.uscs;
    let guess = null;
    const check = typeof l.uscs === 'string' ? checkUscs(l.uscs, l.description) : null;
    if (check?.invalid) {
        const first = l.uscs.split(/[-/]/).find(c => USCS_SYMBOLS.includes(c)) ?? null;
        const to = check.inferred ?? first;
        if (to) {
            uscs = to;
            if (!l.hatch && !material) guess = { from: l.uscs, to, how: check.inferred ? 'read from the description' : 'its first symbol' };
        } else uscs = undefined;
    }
    const codes = layerHatch({ ...l, uscs, ...(inferred ? { uscs_inferred: inferred.uscs } : {}), ...(material ? { material_inferred: material } : {}) });
    const combined = codes.join('-');
    return { codes: codes.length === 2 && HATCH_TILES[combined] ? [combined] : codes, guess };
}

// The code that stands for a layer as a whole: a split dual USCS symbol
// (CL-ML drawn as two halves) is taken together.
export const layerKey = l => (l.codes.length === 2 && l.codes.every(c => USCS_SYMBOLS.includes(c)) ? l.codes.join('-') : l.codes[0] ?? null);
const layerClasses = l => (l.codes.length === 2 && l.codes.every(c => USCS_SYMBOLS.includes(c)) ? soilClass(layerKey(l)) ?? [] : l.codes.flatMap(c => soilClass(c) ?? []));

// A silty clay (CL-ML or ML-CL): a clay that may also be joined to a silt.
const siltyClay = l => {
    const parts = (layerKey(l) ?? '').split('-').filter(c => USCS_SYMBOLS.includes(c));
    return parts.some(c => c[0] === 'C') && parts.some(c => c[0] === 'M');
};

// Groups a boring's layers into units of one material class. Each unit:
// { top, bottom, classes: Set, links: Set, code (hatch of its thickest
// layer), layers }. links are the classes it may be joined to in another
// boring: its own, plus silt when it holds a silty clay (CL-ML), so ML joins
// CL-ML, which joins CL, while ML never joins a plain CL. Depths are in metres.
export function boringUnits(layers) {
    const units = [];
    for (const l of layers) {
        const classes = new Set(layerClasses(l));
        const prev = units[units.length - 1];
        const same = prev && classes.size && prev.classes.size === classes.size && [...classes].every(c => prev.classes.has(c))
            && Math.abs(prev.bottom - l.top) < 1e-6;
        if (same) {
            prev.bottom = l.bottom;
            prev.layers.push(l);
            if (siltyClay(l)) prev.links.add('silt');
            if (l.bottom - l.top > prev.thickest) {
                prev.thickest = l.bottom - l.top;
                prev.code = l.codes[0] ?? null;
            }
        } else {
            const links = new Set(classes);
            if (siltyClay(l)) links.add('silt');
            units.push({ top: l.top, bottom: l.bottom, classes, links, code: l.codes[0] ?? null, thickest: l.bottom - l.top, layers: [l] });
        }
    }
    return units;
}

// Matches the units of two neighbouring borings: the non-crossing set of pairs
// of the same main soil with the highest total score, where a pair scores
// 1 plus how much the two overlap in level (0-1 of the thinner one), less a
// penalty for large differences in level. `level` gives a unit's (top, bottom)
// on the common vertical axis (elevation or depth). Returns [[i, j], ...].
// How well two units match: -Infinity for different main soils, else 1 plus
// their overlap in level (0-1 of the thinner one), less a penalty for a gap
// between them. `overlap` is returned too: 0 means they share no level.
export function pairScore(ua, ub, level = u => [u.top, u.bottom]) {
    const linked = (x, y) => [...x.classes].some(c => (y.links ?? y.classes).has(c));
    if (!linked(ua, ub) && !linked(ub, ua)) return { score: -Infinity, overlap: 0 };
    const [at, ab] = level(ua);
    const [bt, bb] = level(ub);
    const lo = Math.max(Math.min(at, ab), Math.min(bt, bb));
    const hi = Math.min(Math.max(at, ab), Math.max(bt, bb));
    const thin = Math.max(1e-6, Math.min(Math.abs(ab - at), Math.abs(bb - bt)));
    const overlap = Math.min(1, Math.max(0, hi - lo) / thin);
    const gap = Math.max(0, lo - hi);
    const span = Math.max(Math.abs(ab - at), Math.abs(bb - bt), 1e-6);
    return { score: 1 + overlap - Math.min(1.5, gap / (2 * span)), overlap };
}

export function matchUnits(a, b, level = u => [u.top, u.bottom]) {
    const n = a.length;
    const m = b.length;
    const score = (ua, ub) => pairScore(ua, ub, level).score;
    // best[i][j]: best total for a[i..] and b[j..]
    const best = Array.from({ length: n + 1 }, () => new Float64Array(m + 1));
    const move = Array.from({ length: n + 1 }, () => new Uint8Array(m + 1));
    for (let i = n - 1; i >= 0; i--) {
        for (let j = m - 1; j >= 0; j--) {
            const s = score(a[i], b[j]);
            const pair = s > 0 ? s + best[i + 1][j + 1] : -Infinity;
            const skipA = best[i + 1][j];
            const skipB = best[i][j + 1];
            if (pair >= skipA && pair >= skipB) {
                best[i][j] = pair;
                move[i][j] = 1;
            } else if (skipA >= skipB) {
                best[i][j] = skipA;
                move[i][j] = 2;
            } else {
                best[i][j] = skipB;
                move[i][j] = 3;
            }
        }
    }
    const pairs = [];
    let i = 0;
    let j = 0;
    while (i < n && j < m) {
        if (move[i][j] === 1) pairs.push([i++, j++]);
        else if (move[i][j] === 2) i++;
        else j++;
    }
    return pairs;
}

// ---------------------------------------------------------------- drawing

function text(x, y, str, { size, anchor = 'start', bold = false, italic = false, rotate, fill } = {}) {
    const attrs = [`x="${r(x)}"`, `y="${r(y)}"`];
    if (size) attrs.push(`font-size="${r(size)}"`);
    if (anchor !== 'start') attrs.push(`text-anchor="${anchor}"`);
    if (bold) attrs.push('font-weight="bold"');
    if (italic) attrs.push('font-style="italic"');
    if (fill) attrs.push(`fill="${fill}"`);
    if (rotate) attrs.push(`transform="rotate(${rotate} ${r(x)} ${r(y)})"`);
    return `<text ${attrs.join(' ')}>${escapeXml(str)}</text>`;
}
const line = (x1, y1, x2, y2, w = 0.75, extra = '') => `<line x1="${r(x1)}" y1="${r(y1)}" x2="${r(x2)}" y2="${r(y2)}" stroke="#000" stroke-width="${w}"${extra}/>`;

function niceStep(raw) {
    const p = 10 ** Math.floor(Math.log10(raw));
    const f = raw / p;
    return (f <= 1 ? 1 : f <= 2 ? 2 : f <= 5 ? 5 : 10) * p;
}

const DEFAULTS = {
    width: 1000,        // SVG width, px (grows if borings need more room)
    height: 420,        // height of the section body, px
    units: null,        // 'm' or 'ft'; defaults to the first boring's units
    title: 'Cross-section A–A′',
    font_size: 10,
    infer_uscs: true,
    infer_materials: true,
    column_width: 16,   // px
    style: 'colour',    // between borings: 'colour' (a colour per main soil, with labels) or 'hatch' (USCS hatches)
    length: null,       // length of the section line, m: the section runs from 0 (A) to it (A′)
    bearing: null,      // direction from A to A′, degrees from north (lineBearing); shown over A and A′
    id: 'A',            // the section's letter: its ends are id and id′
    id_prefix: 'sec',
};

// entries: [{ doc, chainage, offset?, side?, name? }] with chainage in metres,
// in order along the line. Returns { svg, warnings }.
export function renderSection(entries, options = {}) {
    const opt = { ...DEFAULTS, ...options };
    const fs = opt.font_size;
    const warnings = [];
    if (!entries.length) throw new Error('No borings to draw');

    const borings = entries.map(e => {
        const doc = normalizeBoringLog(e.doc);
        const toM = TO_M[doc.units.length] ?? 1;
        const layers = doc.layers.map(l => ({ ...l, top: l.top * toM, bottom: l.bottom * toM, ...layerCodes(l, opt) }));
        const elev = typeof doc.metadata.elevation === 'number' ? doc.metadata.elevation * toM : null;
        return {
            name: e.name ?? doc.metadata.boring_name ?? 'Boring',
            chainage: e.chainage,
            offset: e.offset,
            side: e.side,
            elev,
            depth: Math.max(0, ...layers.map(l => l.bottom)),
            layers,
            units: boringUnits(layers),
            groundwater: doc.groundwater.map(g => g.depth * toM),
            docUnits: doc.units.length,
        };
    });
    const units = opt.units ?? borings[0].docUnits ?? 'm';
    const k = 1 / TO_M[units]; // metres -> display units
    // Elevations only when every boring has one; otherwise depths below ground.
    const useElev = borings.every(b => b.elev !== null);
    if (!useElev && borings.some(b => b.elev !== null)) warnings.push('Not every boring has a ground elevation, so the section is drawn by depth below ground.');
    // Vertical position of a depth in a boring, in display units (up is larger for elevations).
    const levelOf = (b, d) => (useElev ? (b.elev - d) * k : d * k);

    // Vertical range.
    const tops = borings.map(b => levelOf(b, 0));
    const bottoms = borings.map(b => levelOf(b, b.depth));
    const vHi = useElev ? Math.max(...tops) : 0;
    // The axis runs a little past the deepest boring (about 8 %, to a round
    // number), so the bottoms of the borings and their depths are easy to read.
    const deepest = useElev ? Math.min(...bottoms) : Math.max(...bottoms);
    const extra = Math.abs(deepest - vHi) * 0.08;
    const roundTo = niceStep(Math.max(Math.abs(deepest - vHi) / 10, 1e-6));
    const vLo = useElev ? Math.floor((deepest - extra) / roundTo) * roundTo : Math.ceil((deepest + extra) / roundTo) * roundTo;
    const vSpan = Math.max(1e-6, Math.abs(vHi - vLo));

    // Layout.
    const cw = opt.column_width;
    const left = 64;
    const right = 24;
    const titleH = fs * 2.4;
    const hasBearing = typeof opt.bearing === 'number' && Number.isFinite(opt.bearing);
    const dirH = hasBearing ? fs * 1.6 : 0;
    const nameH = fs * 4.2 + dirH;
    const top0 = 10 + titleH + nameH;
    const plotH = opt.height;
    const sy = plotH / vSpan;
    const yOf = v => (useElev ? top0 + (vHi - v) * sy : top0 + v * sy);

    const chs = borings.map(b => b.chainage * k);
    const chMin = Math.min(...chs);
    const chMax = Math.max(...chs);
    const minGap = cw + 28;
    let width = opt.width;
    const plotW = width - left - right;
    // The section runs the length of the line (A to A′) when it is given,
    // else a little past the outer borings.
    const lineLen = opt.length > 0 ? opt.length * k : null;
    const pad = chMax > chMin ? (chMax - chMin) * 0.06 : 10 * k;
    let lo = lineLen !== null ? Math.min(0, chMin) : chMin - pad;
    let hi = lineLen !== null ? Math.max(lineLen, chMax) : chMax + pad;
    let sx = plotW / Math.max(1e-6, hi - lo);
    // Room for the outer columns inside the frame.
    const room = cw / 2 + 4;
    if ((chMin - lo) * sx < room) lo = chMin - room / sx;
    if ((hi - chMax) * sx < room) hi = chMax + room / sx;
    sx = plotW / Math.max(1e-6, hi - lo);
    const xOf = c => left + (c - lo) * sx;
    // Borings closer than minGap px are spread apart; the chainage labels stay true.
    const xs = chs.map(xOf);
    for (let i = 1; i < xs.length; i++) if (xs[i] - xs[i - 1] < minGap) xs[i] = xs[i - 1] + minGap;
    const needed = xs[xs.length - 1] + room + right;
    if (needed > width) width = Math.ceil(needed);
    const spread = xs.some((x, i) => i > 0 && Math.abs((x - xs[i - 1]) - (chs[i] - chs[i - 1]) * sx) > 0.5);

    const out = [];
    const defs = [];
    const id = `${opt.id_prefix}`;
    const usedCodes = new Set();
    const fillFor = code => {
        if (!code || !builtInTile(code)) return '#fff';
        usedCodes.add(code);
        return `url(#${id}-${code})`;
    };
    const bgFor = code => (code && builtInTile(code)?.background) || null;

    // Grid and axes.
    const plotBottom = top0 + plotH;
    const vStep = niceStep(40 / sy);
    const vDec = vStep >= 1 ? 0 : Math.min(3, Math.ceil(-Math.log10(vStep)));
    for (let v = Math.ceil(Math.min(vLo, vHi) / vStep - 1e-9) * vStep; v <= Math.max(vLo, vHi) + 1e-9; v += vStep) {
        const y = yOf(v);
        out.push(`<line x1="${left}" y1="${r(y)}" x2="${r(width - right)}" y2="${r(y)}" stroke="#ccc" stroke-width="0.5" stroke-dasharray="3 3"/>`);
        out.push(line(left - 4, y, left, y));
        out.push(text(left - 6, y + fs * 0.35, (Math.abs(v) < 1e-9 ? 0 : v).toFixed(vDec), { anchor: 'end' }));
    }
    out.push(line(left, top0, left, plotBottom));
    out.push(text(14, top0 + plotH / 2, useElev ? `Elevation (${units})` : `Depth (${units})`, { anchor: 'middle', bold: true, rotate: -90 }));
    // Chainage axis.
    out.push(line(left, plotBottom + 6, width - right, plotBottom + 6));
    if (!spread) {
        const hStep = niceStep(70 / sx);
        const hDec = hStep >= 1 ? 0 : Math.min(3, Math.ceil(-Math.log10(hStep)));
        for (let c = Math.ceil(lo / hStep - 1e-9) * hStep; c <= hi + 1e-9; c += hStep) {
            const x = xOf(c);
            if (x < left || x > width - right) continue;
            out.push(line(x, plotBottom + 6, x, plotBottom + 10));
            out.push(text(x, plotBottom + 10 + fs, c.toFixed(hDec), { anchor: 'middle' }));
        }
    } else {
        // Spread borings: label each with its own distance instead of a scale.
        xs.forEach((x, i) => {
            out.push(line(x, plotBottom + 6, x, plotBottom + 10));
            out.push(text(x, plotBottom + 10 + fs, chs[i].toFixed(chs[i] < 100 ? 1 : 0), { anchor: 'middle' }));
        });
    }
    out.push(text(left + (width - right - left) / 2, plotBottom + 14 + fs * 2, `Distance along the line (${units})${spread ? '; borings closer than the column width are spread apart, so the horizontal scale is not uniform' : ''}`, { anchor: 'middle', bold: !spread }));

    // Connections between neighbouring borings. All pairs first, so a boundary
    // that continues across several borings can be drawn as one smooth curve.
    const levelPair = (b, u) => [levelOf(b, u.top), levelOf(b, u.bottom)];
    const gaps = [];
    for (let i = 0; i < borings.length - 1; i++) {
        const A = borings[i];
        const B = borings[i + 1];
        const xa = xs[i] + cw / 2;
        const xb = xs[i + 1] - cw / 2;
        const level = u => (A.units.includes(u) ? levelPair(A, u) : levelPair(B, u));
        gaps.push({ i, A, B, xa, xb, xm: (xa + xb) / 2, pairs: xb - xa < 4 ? [] : matchUnits(A.units, B.units, level), level });
    }
    const yAt = (b, d) => yOf(levelOf(b, d));

    // Smooth boundaries: each connection is a cubic curve (Hermite) between the
    // two borings. Where a boundary continues on both sides of a boring, its
    // slope there is the harmonic mean of the slopes on each side (level where
    // they differ in sign, so curves don't overshoot); at its ends it meets the
    // boring level.
    const slopeAt = new Map(); // `${boring}:${unit}:${top|bottom}` -> [left slope, right slope]
    const noteSlope = (key, side, s) => {
        const v = slopeAt.get(key) ?? [null, null];
        v[side] = s;
        slopeAt.set(key, v);
    };
    for (const g of gaps) {
        for (const [ia, ib] of g.pairs) {
            for (const edge of ['top', 'bottom']) {
                const s = (yAt(g.B, g.B.units[ib][edge]) - yAt(g.A, g.A.units[ia][edge])) / (g.xb - g.xa);
                noteSlope(`${g.i}:${ia}:${edge}`, 1, s);
                noteSlope(`${g.i + 1}:${ib}:${edge}`, 0, s);
            }
        }
    }
    const blend = ([l, rt]) => {
        if (l === null || rt === null || l * rt <= 0) return 0;
        return 2 / (1 / l + 1 / rt);
    };
    const tangent = key => blend(slopeAt.get(key) ?? [null, null]);
    // A curve from (x0, y0) to (x1, y1) with slopes m0, m1: its value at x, and
    // its SVG path segment (as a cubic Bezier).
    const curveY = (x0, y0, m0, x1, y1, m1, x) => {
        const h = x1 - x0;
        const t = (x - x0) / h;
        return (2 * t ** 3 - 3 * t ** 2 + 1) * y0 + (t ** 3 - 2 * t ** 2 + t) * h * m0 + (-2 * t ** 3 + 3 * t ** 2) * y1 + (t ** 3 - t ** 2) * h * m1;
    };
    const curveTo = (x0, y0, m0, x1, y1, m1) => {
        const h = (x1 - x0) / 3;
        return `C${r(x0 + h)} ${r(y0 + m0 * h)} ${r(x1 - h)} ${r(y1 - m1 * h)} ${r(x1)} ${r(y1)}`;
    };
    const question = (x, y) => out.push(`<text x="${r(x)}" y="${r(y + fs * 0.45)}" text-anchor="middle" font-weight="bold" font-size="${r(fs * 1.3)}" fill="#b42318" stroke="#fff" stroke-width="2.5" paint-order="stroke">?</text>`);
    const questions = [];
    const sample = (x0, x1, n = 16) => Array.from({ length: n + 1 }, (_, k) => x0 + ((x1 - x0) * k) / n);
    const pathOf = pts => `M${pts.map(([x, y]) => `${r(x)} ${r(y)}`).join('L')}`;
    // Fills a unit's band (edges(x) -> [top y, bottom y]) with its layers, each in
    // its own hatch and at its share of the unit's thickness (a unit groups
    // layers of one main soil, e.g. SC over SM), with dotted lines between them.
    const colourMode = opt.style !== 'hatch';
    const usedColours = new Set();
    const colourFill = key => {
        if (!key) return '#fff';
        usedColours.add(key);
        return SECTION_COLOURS[key].fill;
    };
    // The one colour of a unit whose layers all have it, else null.
    const unitColour = u => {
        const set = new Set(u.layers.map(l => colourClass(layerKey(l))));
        return set.size === 1 ? [...set][0] : null;
    };
    const fillUnit = (u, xsAlong, edges) => {
        const span = Math.max(1e-9, u.bottom - u.top);
        const parts = [];
        for (const l of u.layers) {
            const code = colourMode ? colourClass(layerKey(l)) : l.codes[0] ?? null;
            const prev = parts[parts.length - 1];
            if (prev && prev.code === code) prev.bottom = l.bottom;
            else parts.push({ code, top: l.top, bottom: l.bottom });
        }
        if (colourMode) {
            parts.forEach((p, n) => {
                const f0 = (p.top - u.top) / span;
                const f1 = (p.bottom - u.top) / span;
                const at = (x, f) => {
                    const [y0, y1] = edges(x);
                    return y0 + (y1 - y0) * f;
                };
                const top = xsAlong.map(x => [x, at(x, f0)]);
                const bot = xsAlong.map(x => [x, at(x, f1)]).reverse();
                out.push(`<path d="${pathOf([...top, ...bot])}Z" fill="${colourFill(p.code)}" stroke="${colourFill(p.code)}" stroke-width="0.3"/>`);
                // Silt next to clay in one unit: a fine line between them.
                if (n > 0) out.push(`<path d="${pathOf(top)}" fill="none" stroke="#555" stroke-width="0.4"/>`);
            });
            return;
        }
        parts.forEach((p, n) => {
            const f0 = (p.top - u.top) / span;
            const f1 = (p.bottom - u.top) / span;
            const at = (x, f) => {
                const [y0, y1] = edges(x);
                return y0 + (y1 - y0) * f;
            };
            const top = xsAlong.map(x => [x, at(x, f0)]);
            const bot = xsAlong.map(x => [x, at(x, f1)]).reverse();
            const d = `${pathOf([...top, ...bot])}Z`;
            const bg = bgFor(p.code);
            if (bg) out.push(`<path d="${d}" fill="${bg}"/>`);
            out.push(`<path d="${d}" fill="${fillFor(p.code)}"/>`);
            if (n > 0) out.push(`<path d="${pathOf(top)}" fill="none" stroke="#000" stroke-width="0.4" stroke-dasharray="1 2"/>`);
        });
    };

    // Units joined by connections form one layer across the section; it is
    // labelled once, where it has the most room.
    const parent = new Map();
    const find = u => {
        while (parent.has(u) && parent.get(u) !== u) u = parent.get(u);
        return u;
    };
    const union = (a, b) => {
        const ra = find(a);
        const rb = find(b);
        if (ra !== rb) parent.set(rb, ra);
    };
    const candidates = []; // { units, xs: [...], edges }
    const candidate = (units, xsAlong, edges) => candidates.push({ units, xs: xsAlong, edges });

    gaps.forEach((g, gi) => {
        const { A, B, xa, xb, xm, pairs } = g;
        if (xb - xa < 4) return;
        // The boundary curves of a matched pair.
        // Boundaries that start and end at the same points (one layer's bottom
        // and the next one's top) get the same slopes, so no sliver opens
        // between them.
        const rawEdge = (ia, ib, edge) => ({
            y0: yAt(A, A.units[ia][edge]),
            y1: yAt(B, B.units[ib][edge]),
            m0: tangent(`${g.i}:${ia}:${edge}`),
            m1: tangent(`${g.i + 1}:${ib}:${edge}`),
        });
        const shared = new Map();
        for (const [ia, ib] of pairs) {
            for (const edge of ['top', 'bottom']) {
                const e = rawEdge(ia, ib, edge);
                const k = `${r(e.y0)}|${r(e.y1)}`;
                if (!shared.has(k)) shared.set(k, []);
                shared.get(k).push(e);
            }
        }
        const mean = list => list.reduce((a, b) => a + b, 0) / list.length;
        const edgeOf = (ia, ib, edge) => {
            const { y0, y1 } = rawEdge(ia, ib, edge);
            const same = shared.get(`${r(y0)}|${r(y1)}`);
            const m0 = same ? mean(same.map(e => e.m0)) : rawEdge(ia, ib, edge).m0;
            const m1 = same ? mean(same.map(e => e.m1)) : rawEdge(ia, ib, edge).m1;
            return { y0, y1, m0, m1, at: x => curveY(xa, y0, m0, xb, y1, m1, x) };
        };
        for (const [ia, ib] of pairs) {
            const ua = A.units[ia];
            const ub = B.units[ib];
            const t = edgeOf(ia, ib, 'top');
            const bo = edgeOf(ia, ib, 'bottom');
            // Each half shows its own boring's layers. Two units of one colour
            // each but different colours (silt joined to silty clay) blend from
            // one to the other across the middle instead.
            const band = x => [t.at(x), bo.at(x)];
            const ca = colourMode ? unitColour(ua) : null;
            const cb = colourMode ? unitColour(ub) : null;
            if (ca && cb && ca !== cb) {
                const gid = `${opt.id_prefix}-blend${gi}-${ia}`;
                defs.push(`<linearGradient id="${gid}" gradientUnits="userSpaceOnUse" x1="${r(xa)}" y1="0" x2="${r(xb)}" y2="0"><stop offset="0.3" stop-color="${colourFill(ca)}"/><stop offset="0.7" stop-color="${colourFill(cb)}"/></linearGradient>`);
                const xs = sample(xa, xb, 40);
                out.push(`<path d="${pathOf([...xs.map(x => [x, t.at(x)]), ...xs.map(x => [x, bo.at(x)]).reverse()])}Z" fill="url(#${gid})"/>`);
            } else {
                fillUnit(ua, sample(xa, xm), band);
                fillUnit(ub, sample(xm, xb), band);
            }
            union(ua, ub);
            candidate([ua, ub], sample(xa, xb, 40), band);
            out.push(`<path d="M${r(xa)} ${r(t.y0)}${curveTo(xa, t.y0, t.m0, xb, t.y1, t.m1)}" fill="none" stroke="#000" stroke-width="0.6"/>`);
            out.push(`<path d="M${r(xa)} ${r(bo.y0)}${curveTo(xa, bo.y0, bo.m0, xb, bo.y1, bo.m1)}" fill="none" stroke="#000" stroke-width="0.6"/>`);
            // A connection between units that share no level is uncertain.
            // A connection between units that share no level is uncertain: "?" on its upper boundary.
            if (pairScore(ua, ub, g.level).overlap === 0) questions.push([xm, t.at(xm)]);
        }
        // Units with no match pinch out. Between two matched pairs (or the ground
        // surface or the boring bottoms) lies a zone, which the unmatched units of
        // both borings fill completely with no gaps: one boring's units thin out
        // towards the other boring while the other's thicken (intertonguing), the
        // shallower group on top. Marked "?".
        const lineAt = (ya, yb, x) => ya + ((yb - ya) * (x - xa)) / (xb - xa);
        for (let z = 0; z <= pairs.length; z++) {
            const above = pairs[z - 1];
            const below = pairs[z];
            const aUnits = A.units.slice(above ? above[0] + 1 : 0, below ? below[0] : A.units.length);
            const bUnits = B.units.slice(above ? above[1] + 1 : 0, below ? below[1] : B.units.length);
            if (!aUnits.length && !bUnits.length) continue;
            const upAt = above ? edgeOf(above[0], above[1], 'bottom').at : x => lineAt(yAt(A, 0), yAt(B, 0), x);
            const loAt = below ? edgeOf(below[0], below[1], 'top').at : x => lineAt(yAt(A, A.depth), yAt(B, B.depth), x);
            // Below the last connection, where the other boring has already ended,
            // nothing is known: the deeper boring's units continue level all the way
            // to the other boring (squeezed below the connection above), marked "?".
            if (!below && (!aUnits.length || !bUnits.length)) {
                const own = aUnits.length ? aUnits : bUnits;
                const b0 = aUnits.length ? A : B;
                let [x0, x1] = aUnits.length ? [xa, xb] : [xb, xa];
                // When the shallower boring is the outermost one, carry on past it to
                // the end of the section.
                const pastEnd = aUnits.length ? gi === gaps.length - 1 : gi === 0;
                const x1Edge = pastEnd ? (aUnits.length ? width - right : left) : x1;
                const steps = 24;
                const xsAlong = Array.from({ length: steps + 1 }, (_, n) => x0 + ((x1 - x0) * n) / steps);
                if (x1Edge !== x1) xsAlong.push(x1Edge);
                own.forEach((u, n) => {
                    const yt = yAt(b0, u.top);
                    const yb = yAt(b0, u.bottom);
                    // Past the outer boring the boundary above is that boring's bottom.
                    const above = x => ((x1 - x0) * (x - x1) > 0 ? yAt(aUnits.length ? B : A, (aUnits.length ? B : A).depth) : upAt(x));
                    // The top unit reaches up to the connection above, so no gap is left.
                    const topAt = x => (n === 0 ? above(x) : Math.max(yt, above(x)));
                    const botAt = x => Math.max(yb, above(x));
                    fillUnit(u, xsAlong, x => [topAt(x), botAt(x)]);
                    candidate([u], xsAlong, x => [topAt(x), botAt(x)]);
                    out.push(`<path d="${pathOf(xsAlong.map(x => [x, topAt(x)]))}" fill="none" stroke="#000" stroke-width="0.5" stroke-dasharray="2 2"/>`);
                });
                const yTop = Math.max(yAt(b0, own[0].top), upAt(x1));
                const yBot = Math.max(yAt(b0, own[own.length - 1].bottom), upAt(x1));
                // "?" where the carried-on layers end.
                const xEnd = x1Edge + (x0 > x1Edge ? 7 : -7);
                const endTop = Math.max(yAt(b0, own[0].top), x1Edge !== x1 ? yAt(aUnits.length ? B : A, (aUnits.length ? B : A).depth) : upAt(x1));
                questions.push([xEnd, (endTop + Math.max(yAt(b0, own[own.length - 1].bottom), endTop)) / 2]);
                if (x1Edge !== x1) out.push(line(x1Edge, yTop, x1Edge, yBot, 0.6, ' stroke-dasharray="3 3"'));
                continue;
            }
            const steps = 32;
            const xsAlong = Array.from({ length: steps + 1 }, (_, n) => xa + ((xb - xa) * n) / steps);
            const smooth = t => t * t * (3 - 2 * t);
            const mean = (units, b0) => units.reduce((sum, u) => sum + yAt(b0, (u.top + u.bottom) / 2), 0) / units.length;
            const aOnTop = !bUnits.length || (aUnits.length && mean(aUnits, A) <= mean(bUnits, B));
            // Share of the zone's thickness each group has at x: A's from 1 to 0, B's from 0 to 1.
            const share = (x, isA) => {
                if (!aUnits.length || !bUnits.length) return 1;
                const t = smooth((x - xa) / (xb - xa));
                return isA ? 1 - t : t;
            };
            const stack = (units, b0, isA) => {
                const yTop0 = yAt(b0, units[0].top);
                const yBot0 = yAt(b0, units[units.length - 1].bottom);
                const total = Math.max(1e-6, yBot0 - yTop0);
                const onTop = isA ? aOnTop : !aOnTop;
                // The group's band at x, and each unit's part of it.
                const band = x => {
                    const up = upAt(x);
                    const h = Math.max(0, loAt(x) - up);
                    const mine = h * share(x, isA);
                    return onTop ? [up, up + mine] : [up + h - mine, up + h];
                };
                for (const u of units) {
                    const f0 = (yAt(b0, u.top) - yTop0) / total;
                    const f1 = (yAt(b0, u.bottom) - yTop0) / total;
                    const at = (x, f) => {
                        const [y0, y1] = band(x);
                        return y0 + (y1 - y0) * f;
                    };
                    fillUnit(u, xsAlong, x => [at(x, f0), at(x, f1)]);
                    candidate([u], xsAlong, x => [at(x, f0), at(x, f1)]);
                    const top = xsAlong.map(x => [x, at(x, f0)]);
                    const bot = xsAlong.map(x => [x, at(x, f1)]).reverse();
                    out.push(`<path d="${pathOf([...top, ...bot])}Z" fill="none" stroke="#000" stroke-width="0.5" stroke-dasharray="2 2"/>`);
                }
            };
            if (aUnits.length) stack(aUnits, A, true);
            if (bUnits.length) stack(bUnits, B, false);
            // "?" where each group runs out: at the other boring, where its band
            // closes to nothing (on the zone's upper or lower boundary).
            if (aUnits.length) questions.push([xb - 7, bUnits.length && !aOnTop ? loAt(xb) : upAt(xb)]);
            if (bUnits.length) questions.push([xa + 7, aUnits.length && aOnTop ? loAt(xa) : upAt(xa)]);
        }
    });

    // Beyond the outer borings, to the ends of the section: their layers are
    // carried on level, unknown, with a dashed end and a "?".
    const extend = (b, xFrom, xTo) => {
        if (Math.abs(xTo - xFrom) < 6) return;
        const [x0, x1] = [Math.min(xFrom, xTo), Math.max(xFrom, xTo)];
        for (const u of b.units) {
            const yt = yAt(b, u.top);
            const yb = yAt(b, u.bottom);
            fillUnit(u, [x0, x1], () => [yt, yb]);
            candidate([u], sample(x0, x1, 12), () => [yt, yb]);
            out.push(line(x0, yt, x1, yt, 0.5));
            // "?" at the end of the section, where the layer is carried to.
            if (yb - yt > fs * 1.4 && x1 - x0 > 20) questions.push([xTo + (xFrom > xTo ? 7 : -7), (yt + yb) / 2]);
        }
        const yb = yAt(b, b.depth);
        out.push(line(x0, yb, x1, yb, 0.5, ' stroke-dasharray="2 2"'));
        out.push(line(xTo, yAt(b, 0), xTo, yb, 0.6, ' stroke-dasharray="3 3"'));
    };
    extend(borings[0], xs[0] - cw / 2, left);
    extend(borings[borings.length - 1], xs[xs.length - 1] + cw / 2, width - right);

    // Water table: the first groundwater reading of each boring, joined by a
    // smooth dashed curve between neighbouring borings that both have one.
    const gwY = borings.map(b => (b.groundwater.length ? yAt(b, b.groundwater[0]) : null));
    const gwX = xs;
    const gwSlope = i => {
        const l = i > 0 && gwY[i - 1] !== null && gwY[i] !== null ? (gwY[i] - gwY[i - 1]) / (gwX[i] - gwX[i - 1]) : null;
        const rt = i < gwY.length - 1 && gwY[i + 1] !== null && gwY[i] !== null ? (gwY[i + 1] - gwY[i]) / (gwX[i + 1] - gwX[i]) : null;
        return blend([l, rt]);
    };
    let waterPath = '';
    if (gwY[0] !== null) waterPath += `M${r(left)} ${r(gwY[0])}L${r(gwX[0])} ${r(gwY[0])}`;
    const lastGw = gwY[gwY.length - 1];
    if (lastGw !== null) waterPath += `M${r(gwX[gwX.length - 1])} ${r(lastGw)}L${r(width - right)} ${r(lastGw)}`;
    for (let i = 0; i < borings.length - 1; i++) {
        if (gwY[i] === null || gwY[i + 1] === null) continue;
        waterPath += `M${r(gwX[i])} ${r(gwY[i])}${curveTo(gwX[i], gwY[i], gwSlope(i), gwX[i + 1], gwY[i + 1], gwSlope(i + 1))}`;
    }
    const hasWater = gwY.some(y => y !== null);

    // Boring columns.
    const nameWidth = Math.max(...borings.map(b => measureText(b.name, fs, true)));
    const tight = xs.some((x, i) => i > 0 && x - xs[i - 1] < nameWidth + 6);
    borings.forEach((b, i) => {
        const x = xs[i] - cw / 2;
        for (const l of b.layers) {
            const t = yOf(levelOf(b, l.top));
            const h = yOf(levelOf(b, l.bottom)) - t;
            const parts = l.codes.length ? l.codes : [null];
            parts.forEach((code, p) => {
                const pw = cw / parts.length;
                const bg = bgFor(code);
                if (bg) out.push(`<rect x="${r(x + p * pw)}" y="${r(t)}" width="${r(pw)}" height="${r(h)}" fill="${bg}"/>`);
                out.push(`<rect x="${r(x + p * pw)}" y="${r(t)}" width="${r(pw)}" height="${r(h)}" fill="${fillFor(code)}"/>`);
            });
            out.push(line(x, t, x + cw, t, 0.5));
        }
        const gt = yOf(levelOf(b, 0));
        const gb = yOf(levelOf(b, b.depth));
        out.push(`<rect x="${r(x)}" y="${r(gt)}" width="${cw}" height="${r(gb - gt)}" fill="none" stroke="#000" stroke-width="1"/>`);
        // Name above the column (slanted when names would collide), distance from the line below the name.
        const ny = gt - 6;
        if (tight) out.push(text(xs[i], ny, b.name, { bold: true, rotate: -40 }));
        else out.push(text(xs[i], ny - fs * 1.1, b.name, { anchor: 'middle', bold: true }));
        if (!tight && b.offset !== undefined) out.push(text(xs[i], ny, `${(b.offset * k).toFixed(0)} ${units} ${b.side ?? ''}`.trim(), { anchor: 'middle', size: fs * 0.8, fill: '#555' }));
        // Bottom of the boring.
        out.push(`<text x="${r(xs[i])}" y="${r(gb + fs * 1.15)}" text-anchor="middle" font-size="${r(fs * 0.9)}" font-weight="bold" stroke="#fff" stroke-width="3" stroke-linejoin="round" paint-order="stroke">${(b.depth * k).toFixed(1)} ${units}</text>`);
        // Groundwater.
        for (const g of b.groundwater) {
            const y = yOf(levelOf(b, g));
            const gx = xs[i] + cw / 2 + 6;
            out.push(`<path d="M${r(gx - 4)} ${r(y - 7)}L${r(gx + 4)} ${r(y - 7)}L${r(gx)} ${r(y)}Z" fill="#fff" stroke="#1f5fa8" stroke-width="1"/>`);
        }
    });

    if (waterPath) out.push(`<path d="${waterPath}" fill="none" stroke="#1f5fa8" stroke-width="1.4" stroke-dasharray="6 3"/>`);
    // Labels: one per layer across the section, in the widest, thickest place
    // that holds its name (or just its symbols), with a white halo.
    const labelSize = fs * 0.95;
    const need = labelSize * 1.35;
    const best = new Map(); // chain -> { score, x, y, text }
    for (const c of candidates) {
        const chain = find(c.units[0]);
        if (!best.has(chain)) best.set(chain, null);
        const th = c.xs.map(x => {
            const [y0, y1] = c.edges(x);
            return y1 - y0;
        });
        const k = th.indexOf(Math.max(...th));
        if (!(th[k] >= need)) continue;
        let lo = k;
        let hi = k;
        while (lo > 0 && th[lo - 1] >= need) lo--;
        while (hi < th.length - 1 && th[hi + 1] >= need) hi++;
        const span = c.xs[hi] - c.xs[lo];
        const x = (c.xs[lo] + c.xs[hi]) / 2;
        const [y0, y1] = c.edges(x);
        if (y1 - y0 < need) continue;
        const prev = best.get(chain);
        const score = span * Math.min(y1 - y0, need * 3);
        if (!prev || score > prev.score) best.set(chain, { score, x, y: (y0 + y1) / 2, span });
    }
    // The codes of every layer in each chain, thickest first.
    const chainCodes = new Map();
    const chainGuessed = new Map();
    const seen = new Set();
    for (const c of candidates) {
        for (const u of c.units) {
            if (seen.has(u)) continue;
            seen.add(u);
            const chain = find(u);
            if (!chainCodes.has(chain)) chainCodes.set(chain, new Map());
            const m = chainCodes.get(chain);
            for (const l of u.layers) {
                const code = layerKey(l);
                if (code) m.set(code, (m.get(code) ?? 0) + l.bottom - l.top);
                if (code && l.guess) {
                    if (!chainGuessed.has(chain)) chainGuessed.set(chain, new Set());
                    chainGuessed.get(chain).add(code);
                }
            }
        }
    }
    const labelBoxes = [];
    for (const [chain, place] of best) {
        if (!place) continue;
        const codes = [...(chainCodes.get(chain) ?? new Map())].sort((a, b) => b[1] - a[1]).map(([c]) => c);
        if (!codes.length) continue;
        const guessed = chainGuessed.get(chain) ?? new Set();
        const full = unitLabel(codes, guessed);
        const short = codes.filter(c => USCS_SYMBOLS.includes(c.split('-')[0])).map(c => (guessed.has(c) ? `${c}*` : c)).join(', ') || full;
        const room = place.span - 8;
        const label = measureText(full, labelSize) <= room ? full : measureText(short, labelSize) <= room ? short : null;
        if (!label) continue;
        out.push(`<text x="${r(place.x)}" y="${r(place.y + labelSize * 0.35)}" text-anchor="middle" font-size="${r(labelSize)}" stroke="#fff" stroke-width="3" stroke-linejoin="round" paint-order="stroke">${escapeXml(label)}</text>`);
        const w = measureText(label, labelSize);
        labelBoxes.push([place.x - w / 2 - 4, place.y - labelSize, place.x + w / 2 + 4, place.y + labelSize]);
    }

    // A "?" that would sit on a label moves just past its end.
    for (let [qx, qy] of questions) {
        const box = labelBoxes.find(([x0, y0, x1, y1]) => qx >= x0 - 6 && qx <= x1 + 6 && qy >= y0 && qy <= y1);
        if (box) qx = box[2] + 8;
        question(qx, qy);
    }

    // Patterns: one tile size everywhere (as in a 40 px log column).
    for (const code of [...usedCodes].sort()) {
        const tile = builtInTile(code);
        defs.push(`<pattern id="${id}-${code}" patternUnits="userSpaceOnUse" width="${tile.width}" height="${tile.height}" patternTransform="scale(${r((40 / 104) * 1000) / 1000})">${tile.body}</pattern>`);
    }

    // Legend and notes.
    let y = plotBottom + 14 + fs * 4;
    const items = [...usedCodes].sort();
    const itemW = 230;
    const perRow = Math.max(1, Math.floor((width - 2 * 10) / itemW));
    const colours = Object.keys(SECTION_COLOURS).filter(k => usedColours.has(k));
    if (colours.length) {
        out.push(text(10, y, 'Between borings', { bold: true }));
        y += 8;
        const cw2 = 150;
        const per = Math.max(1, Math.floor((width - 20) / cw2));
        colours.forEach((key, n) => {
            const cx = 10 + (n % per) * cw2;
            const cy = y + Math.floor(n / per) * 22;
            out.push(`<rect x="${cx}" y="${r(cy)}" width="36" height="16" fill="${SECTION_COLOURS[key].fill}" stroke="#000" stroke-width="0.75"/>`);
            out.push(text(cx + 42, cy + 12, SECTION_COLOURS[key].name));
        });
        y += Math.ceil(colours.length / per) * 22 + 10;
    }
    if (items.length) {
        out.push(text(10, y, colourMode ? 'Borings (USCS and material hatches)' : 'Legend', { bold: true }));
        y += 8;
        items.forEach((code, n) => {
            const cx = 10 + (n % perRow) * itemW;
            const cy = y + Math.floor(n / perRow) * 22;
            const bg = bgFor(code);
            if (bg) out.push(`<rect x="${cx}" y="${r(cy)}" width="36" height="16" fill="${bg}"/>`);
            out.push(`<rect x="${cx}" y="${r(cy)}" width="36" height="16" fill="url(#${id}-${code})" stroke="#000" stroke-width="0.75"/>`);
            out.push(text(cx + 42, cy + 12, `${code} – ${hatchName(code)}`));
        });
        y += Math.ceil(items.length / perRow) * 22 + 6;
    }
    let lx = 10;
    if (hasWater) {
        out.push(`<path d="M${14} ${r(y + 1)}L${22} ${r(y + 1)}L${18} ${r(y + 8)}Z" fill="#fff" stroke="#1f5fa8" stroke-width="1"/>`);
        out.push(`<path d="M30 ${r(y + 5)}L58 ${r(y + 5)}" stroke="#1f5fa8" stroke-width="1.4" stroke-dasharray="6 3"/>`);
        out.push(text(64, y + 8, 'Groundwater (first reading in each boring), joined between borings'));
        lx = 64 + measureText('Groundwater (first reading in each boring), joined between borings', fs) + 24;
    }
    if (questions.length) {
        out.push(`<text x="${r(lx + 4)}" y="${r(y + 9)}" text-anchor="middle" font-weight="bold" font-size="${r(fs * 1.3)}" fill="#b42318">?</text>`);
        out.push(text(lx + 14, y + 8, 'Uncertain: a layer that pinches out, continues past a boring, or connects layers at different levels'));
    }
    y += 18;
    const notes = [
        'Layers are connected automatically between neighbouring borings where they are the same main soil (gravel, sand, silt, clay, organic; CL-ML is a silty clay, which connects to clay and to silt, but silt never connects directly to clay without it) or material (fill, pavement, rock), with smooth boundaries; others thin out towards the neighbouring boring (dashed outlines). This is an interpretation, not a verified geologic model.',
        `Borings are projected onto the line; the text under each name is its distance from the line (L/R: left or right looking from ${opt.id ?? 'A'} to ${opt.id ?? 'A'}′).${hasBearing ? ` The line runs from ${opt.id ?? 'A'} towards ${compassPoint(opt.bearing)} (bearing ${Math.round(opt.bearing)}°) to ${opt.id ?? 'A'}′.` : ''}`,
        `Vertical exaggeration ×${(sy / sx).toFixed(sy / sx < 10 ? 1 : 0)}.`,
    ];
    const guesses = borings.flatMap(b => b.layers.filter(l => l.guess).map(l => `${b.name} ${(l.top * k).toFixed(1)}–${(l.bottom * k).toFixed(1)} ${units}: ${l.guess.from} → ${l.guess.to} (${l.guess.how})`));
    if (guesses.length) notes.unshift(`* Guessed symbols: the log gives a value that is not a USCS symbol, so the section uses our guess: ${guesses.join('; ')}.`);
    if (!useElev) {
        notes.unshift('No ground elevations are given for these borings, so they are aligned at the ground surface and drawn by depth. The layer boundaries between borings are therefore not known with certainty: where the ground is not level, they lie higher or lower than drawn. Only the layers in each boring are as logged.');
    }
    for (const n of notes) {
        // Wrap long notes by width.
        const words = n.split(' ');
        let row = '';
        for (const w of words) {
            const next = row ? `${row} ${w}` : w;
            if (measureText(next, fs * 0.9) > width - 20 && row) {
                out.push(text(10, y + fs, row, { size: fs * 0.9, fill: '#333' }));
                y += fs * 1.3;
                row = w;
            } else row = next;
        }
        if (row) {
            out.push(text(10, y + fs, row, { size: fs * 0.9, fill: '#333' }));
            y += fs * 1.3;
        }
    }
    const height = Math.ceil(y + 10);

    // Title and A / A′ marks.
    out.unshift(text(10, 10 + fs * 1.5, opt.title, { size: fs * 1.5, bold: true }));
    const endY = top0 - nameH + dirH + fs;
    const end = String(opt.id ?? 'A');
    out.push(text(left, endY, end, { bold: true, size: fs * 1.3 }));
    out.push(text(width - right, endY, `${end}′`, { bold: true, size: fs * 1.3, anchor: 'end' }));
    if (hasBearing) {
        // Which way each end of the line points: A looks back along the line, A′ along it.
        const dirY = endY - fs * 1.45;
        out.push(text(left, dirY, `← ${compassPoint(opt.bearing + 180)}`, { bold: true, size: fs * 1.05, fill: '#555' }));
        out.push(text(width - right, dirY, `${compassPoint(opt.bearing)} →`, { bold: true, size: fs * 1.05, anchor: 'end', fill: '#555' }));
    }

    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" font-family="${escapeXml(FONT_FAMILY)}" font-size="${fs}" role="img">`
        + `<title>${escapeXml(opt.title)}</title><defs>${defs.join('')}</defs><rect width="100%" height="100%" fill="#fff"/>${out.join('')}</svg>`;
    return { svg, warnings };
}

// A boring prepared for correlation, in metres: its layers with their hatch
// codes (and guesses), grouped into units. Used by the 3D model.
export function prepareBoring(input, options = {}) {
    const opt = { ...DEFAULTS, ...options };
    const doc = normalizeBoringLog(input);
    const toM = TO_M[doc.units.length] ?? 1;
    const layers = doc.layers.map(l => ({ ...l, top: l.top * toM, bottom: l.bottom * toM, ...layerCodes(l, opt) }));
    return {
        name: doc.metadata.boring_name ?? 'Boring',
        elev: typeof doc.metadata.elevation === 'number' ? doc.metadata.elevation * toM : null,
        depth: Math.max(0, ...layers.map(l => l.bottom)),
        layers,
        units: boringUnits(layers),
        groundwater: doc.groundwater.map(g => g.depth * toM),
    };
}
