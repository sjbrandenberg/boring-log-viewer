// Renders a boring log document to a standalone SVG string. Pure function:
// no DOM, no network, no external images, so the same code runs in the
// browser, in Node for the API, and in tests.
import { normalizeBoringLog } from './normalize.js';
import { DUAL_NAMES, inferUscs, layerHatch, USCS_NAMES, USCS_SYMBOLS } from './classify.js';
import { inferMaterial } from './materials.js';
import { HATCH_TILES } from './hatches.js';
import { LITHOLOGY } from './lithology.js';

// The built-in tile for a code, following the lithology fallback chain (e.g.
// SANDSTONE -> ROCK_SED -> ROCK) when a code has no tile of its own.
function builtInTile(code) {
    for (let c = code, seen = 0; c && seen < 8; c = LITHOLOGY[c]?.fallback, seen++) {
        if (HATCH_TILES[c]) return HATCH_TILES[c];
    }
    return null;
}
export const hatchName = code => USCS_NAMES[code] ?? DUAL_NAMES[code] ?? LITHOLOGY[code]?.name ?? code;
import { FONT_FAMILY, measureText, wrapText, escapeXml } from './text.js';
import { SAMPLER_NAMES } from './samplers.js';
export { SAMPLER_NAMES };

export const DEFAULT_COLUMNS = [
    'depth', 'elevation', 'groundwater', 'graphic', 'uscs', 'description',
    'sample_type', 'sample_name', 'sampler_diameter', 'recovery', 'blow_count', 'sample_description',
    'water_content', 'dry_unit_weight', 'specific_gravity', 'fines_content', 'liquid_limit', 'plastic_limit',
    'remarks',
];

const DEFAULTS = {
    width: 800,          // total SVG width, px
    height: 500,         // initial height of the log body, px (grows to fit text)
    scale: null,         // px per display length unit; overrides height
    fit_text: true,      // stretch the depth scale until descriptions fit
    font_size: 10,
    columns: DEFAULT_COLUMNS,
    hide_empty_columns: true,
    header: true,
    legend: true,
    references: true,    // list the document's references in the header (below the legend without one)
    title: null,
    units: null,         // display length units, 'm' or 'ft'; defaults to the data's units
    unit_weight: null,   // display unit weight units, 'kN/m3' or 'pcf'
    diameter_units: null,
    depth_range: null,   // [top, bottom] in display units
    id_prefix: null,     // prefix for pattern ids; needed if several logs share a page
    infer_uscs: true,    // show a USCS symbol inferred from the description, in parentheses, when none is given
    infer_materials: true, // draw a material or rock hatch (fill, asphalt, shale...) named in the description
};


const TO_M = { m: 1, ft: 0.3048 };
const TO_KNM3 = { 'kN/m3': 1, pcf: 1 / 6.36588 };
const TO_MM = { mm: 1, cm: 10, m: 1000, in: 25.4, ft: 304.8 };
const UNIT_LABEL = { 'kN/m3': 'kN/m³', pcf: 'pcf' };

const MARGIN = 10;
const TEXT_PAD_X = 4;
const TEXT_PAD_Y = 2;
const BEND = 8;           // horizontal run of a description leader line
const DESC_PAD_X = BEND + 3; // keeps description text clear of the leader bends
// fit_text stretches the depth scale so sample rows line up with their samplers,
// but never makes the log body taller than this (px); beyond it, rows are pushed down.
const MAX_ALIGNED_HEIGHT = 8000;
// A recorded USCS symbol, or a dual one such as SP-SM. Other "uscs" values (e.g. a
// custom pattern code put there by mistake) aren't shown as a classification.
const USCS_VALUE = new RegExp(`^(${USCS_SYMBOLS.join('|')})([-/](${USCS_SYMBOLS.join('|')}))?$`);
const shownUscs = l => (typeof l.uscs === 'string' && USCS_VALUE.test(l.uscs) ? l.uscs : null);

const r = n => Math.round(n * 100) / 100;

// ---------------------------------------------------------------- units

function displayUnits(doc, opt) {
    const len = opt.units ?? doc.units.length;
    const sameSystem = len === doc.units.length;
    const uw = opt.unit_weight ?? (sameSystem ? doc.units.unit_weight : len === 'ft' ? 'pcf' : 'kN/m3');
    const dia = opt.diameter_units ?? (sameSystem ? doc.units.diameter : len === 'ft' ? 'in' : 'mm');
    return {
        len, uw, dia,
        length: v => (v * TO_M[doc.units.length]) / TO_M[len],
        unitWeight: v => (v * TO_KNM3[doc.units.unit_weight]) / TO_KNM3[uw],
        diameter: v => (v * TO_MM[doc.units.diameter]) / TO_MM[dia],
    };
}

// ---------------------------------------------------------------- columns

const fmt = decimals => v => (typeof v === 'number' ? v.toFixed(decimals) : String(v));
const has = field => doc => doc.samples.some(s => s[field] !== undefined);

function columnRegistry(u) {
    const diaDecimals = { mm: 0, cm: 1, m: 3, in: 2, ft: 3 }[u.dia];
    return {
        depth: { kind: 'depth', width: 38, label: `Depth (${u.len})`, always: true },
        elevation: { kind: 'elevation', width: 38, label: `Elevation (${u.len})`, hasData: doc => doc.metadata.elevation !== undefined },
        groundwater: { kind: 'groundwater', width: 22, label: 'Water level', hasData: doc => doc.groundwater.length > 0 },
        graphic: { kind: 'graphic', width: 40, label: 'Graphic log', always: true },
        uscs: { kind: 'uscs', width: 30, label: 'USCS', hasData: doc => doc.layers.some(l => shownUscs(l) || l.uscs_inferred) },
        description: { kind: 'description', flex: 3, label: 'Material description', always: true },
        sample_type: { kind: 'sample_symbol', width: 24, label: 'Sample type', hasData: doc => doc.samples.length > 0 },
        sample_name: { kind: 'sample_value', width: 36, label: 'Sample no.', value: s => s.name, hasData: has('name') },
        sampler_diameter: {
            kind: 'sample_value', width: 30, label: `Sampler dia. (${u.dia})`,
            value: s => s.sampler_diameter === undefined ? undefined : fmt(diaDecimals)(u.diameter(s.sampler_diameter)),
            hasData: has('sampler_diameter'),
        },
        recovery: {
            kind: 'sample_value', width: 30, label: `Recovery (${u.len})`,
            value: s => s.recovery === undefined ? undefined : fmt(2)(u.length(s.recovery)),
            hasData: has('recovery'),
        },
        blow_count: {
            kind: 'sample_value', width: 34, label: 'Blow count',
            value: s => s.blow_count ?? (s.blows ? s.blows.join('-') : undefined),
            hasData: doc => doc.samples.some(s => s.blow_count !== undefined || s.blows),
        },
        energy_ratio: {
            kind: 'sample_value', width: 30, label: 'Energy ratio (%)',
            value: s => (s.energy_ratio === undefined ? undefined : fmt(0)(s.energy_ratio)),
            hasData: has('energy_ratio'),
        },
        sample_description: { kind: 'sample_text', flex: 1.5, label: 'Sample description', value: s => s.description, hasData: has('description') },
        water_content: { kind: 'sample_value', width: 30, label: 'Water content (%)', value: s => s.water_content === undefined ? undefined : fmt(1)(s.water_content), hasData: has('water_content') },
        dry_unit_weight: {
            kind: 'sample_value', width: 30, label: `Dry unit wt. (${UNIT_LABEL[u.uw]})`,
            value: s => s.dry_unit_weight === undefined ? undefined : fmt(1)(u.unitWeight(s.dry_unit_weight)),
            hasData: has('dry_unit_weight'),
        },
        specific_gravity: { kind: 'sample_value', width: 30, label: 'Specific gravity', value: s => s.specific_gravity === undefined ? undefined : fmt(2)(s.specific_gravity), hasData: has('specific_gravity') },
        fines_content: { kind: 'sample_value', width: 30, label: 'Fines (%)', value: s => s.fines_content === undefined ? undefined : fmt(0)(s.fines_content), hasData: has('fines_content') },
        liquid_limit: {
            kind: 'sample_value', width: 28, label: 'Liquid limit',
            value: s => (s.nonplastic ? 'NP' : s.liquid_limit === undefined ? undefined : fmt(0)(s.liquid_limit)),
            hasData: doc => doc.samples.some(s => s.liquid_limit !== undefined || s.nonplastic),
        },
        plastic_limit: {
            kind: 'sample_value', width: 28, label: 'Plastic limit',
            value: s => (s.nonplastic ? 'NP' : s.plastic_limit === undefined ? undefined : fmt(0)(s.plastic_limit)),
            hasData: doc => doc.samples.some(s => s.plastic_limit !== undefined || s.nonplastic),
        },
        remarks: { kind: 'sample_text', flex: 1, label: 'Remarks', value: s => s.remarks, hasData: has('remarks') },
    };
}

function resolveColumns(doc, opt, u, totalWidth) {
    const registry = columnRegistry(u);
    const cols = [];
    for (const id of opt.columns) {
        const def = registry[id];
        if (!def) throw new Error(`Unknown column "${id}". Known columns: ${Object.keys(registry).join(', ')}`);
        if (opt.hide_empty_columns && !def.always && !def.hasData(doc)) continue;
        cols.push({ id, ...def });
    }
    const fixed = cols.reduce((n, c) => n + (c.width ?? 0), 0);
    const flexTotal = cols.reduce((n, c) => n + (c.flex ?? 0), 0);
    // Keep flexible text columns readable; widen the drawing rather than squeeze them.
    const flexSpace = Math.max(totalWidth - 2 * MARGIN - fixed, flexTotal * 60);
    let x = MARGIN;
    for (const c of cols) {
        c.w = c.width ?? (flexSpace * c.flex) / flexTotal;
        c.x = x;
        x += c.w;
    }
    return { cols, width: x + MARGIN };
}

// ---------------------------------------------------------------- layout

function niceStep(raw) {
    const pow = 10 ** Math.floor(Math.log10(raw));
    for (const m of [1, 2, 2.5, 5, 10]) {
        if (m * pow >= raw) return m * pow;
    }
    return 10 * pow;
}

function decimalsFor(step) {
    const s = String(step);
    return s.includes('.') ? s.split('.')[1].length : 0;
}

// The layer a depth note belongs to: the one containing its depth, else the
// last layer starting above it, else the first layer.
function noteLayerIndex(layers, depth) {
    const inside = layers.findIndex(l => depth >= l.top && depth < l.bottom);
    if (inside >= 0) return inside;
    let k = 0;
    layers.forEach((l, i) => { if (l.top <= depth) k = i; });
    return k;
}

// Stacks description blocks top-down: each starts at its layer top, or below
// the previous block if that ran long. A layer's depth notes follow its
// description, each with its first line level with its depth when there is
// room. Returns positions in px from the top of the depth scale.
function layoutDescriptions(layers, notes, col, scale, dTop, fs) {
    const lh = fs * 1.2;
    const maxW = col.w - 2 * DESC_PAD_X;
    const notesByLayer = layers.map(() => []);
    for (const n of notes) notesByLayer[noteLayerIndex(layers, n.depth)].push(n);
    let cursor = -Infinity;
    return layers.map((layer, k) => {
        const lines = wrapText(layer.description ?? '', maxW, fs);
        const textH = lines.length * lh + 2 * TEXT_PAD_Y;
        const layerTop = (layer.top - dTop) * scale;
        const layerBottom = (layer.bottom - dTop) * scale;
        const top = Math.max(layerTop, cursor);
        let end = top + textH;
        const noteBlocks = notesByLayer[k].map(note => {
            const noteLines = wrapText(note.description, maxW, fs);
            const y = (note.depth - dTop) * scale;
            const noteTop = Math.max(y - lh / 2 - TEXT_PAD_Y, end);
            end = noteTop + noteLines.length * lh + 2 * TEXT_PAD_Y;
            return { note, lines: noteLines, y, top: noteTop };
        });
        cursor = Math.max(end, layerBottom);
        return { layer, lines, layerTop, layerBottom, top, bottom: cursor, notes: noteBlocks };
    });
}

// Wraps each sample's text columns; the row heights don't depend on the scale.
function wrapSampleRows(samples, textCols, fs) {
    const lh = fs * 1.2;
    return samples.map(sample => {
        const wrapped = {};
        let lines = 1;
        for (const c of textCols) {
            wrapped[c.id] = wrapText(c.value(sample) ?? '', c.w - 2 * TEXT_PAD_X, fs);
            lines = Math.max(lines, wrapped[c.id].length);
        }
        return { sample, wrapped, height: lines * lh + 2 * TEXT_PAD_Y };
    });
}

// A row's first line is centered on the middle of its sample interval (in
// display units); the rest of a long row extends below the sample.
const rowAnchor = s => (s.top + s.bottom) / 2;
// Distance from the top of a row to the middle of its first line, px.
const rowLead = fs => fs * 0.6 + TEXT_PAD_Y;

// The smallest scale (px per display unit) at which every sample row starts
// level with its sampler without running into the next row or above the log.
function rowAlignScale(wrappedRows, dTop, fs) {
    let need = 0;
    wrappedRows.forEach((row, i) => {
        const a = rowAnchor(row.sample) - dTop;
        if (i === 0) {
            if (a > 0) need = Math.max(need, rowLead(fs) / a);
            return;
        }
        const gap = a - (rowAnchor(wrappedRows[i - 1].sample) - dTop);
        if (gap > 0) need = Math.max(need, wrappedRows[i - 1].height / gap);
    });
    return need;
}

// Places the rows: each row's first line level with the middle of its sample,
// pushed down past the previous row only if there is no room.
function layoutSampleRows(wrappedRows, scale, dTop, fs) {
    let cursor = 0;
    return wrappedRows.map(row => {
        const sTop = (row.sample.top - dTop) * scale;
        const sBottom = (row.sample.bottom - dTop) * scale;
        const top = Math.max((rowAnchor(row.sample) - dTop) * scale - rowLead(fs), cursor);
        cursor = top + row.height;
        return { ...row, sTop, sBottom, top, bottom: cursor };
    });
}

// ---------------------------------------------------------------- drawing helpers

function text(x, y, str, { size, anchor = 'start', bold = false, italic = false, rotate = false, fill } = {}) {
    const attrs = [`x="${r(x)}"`, `y="${r(y)}"`];
    if (size) attrs.push(`font-size="${r(size)}"`);
    if (anchor !== 'start') attrs.push(`text-anchor="${anchor}"`);
    if (bold) attrs.push('font-weight="bold"');
    if (italic) attrs.push('font-style="italic"');
    if (fill) attrs.push(`fill="${fill}"`);
    if (rotate) attrs.push(`transform="rotate(-90 ${r(x)} ${r(y)})"`);
    return `<text ${attrs.join(' ')}>${escapeXml(str)}</text>`;
}

function line(x1, y1, x2, y2, width = 0.75) {
    return `<line x1="${r(x1)}" y1="${r(y1)}" x2="${r(x2)}" y2="${r(y2)}" stroke="#000" stroke-width="${width}"/>`;
}

// Draws a value in a narrow column, shrinking the font if it would not fit.
function fittedText(cx, y, str, maxWidth, fs) {
    let size = fs;
    const w = measureText(str, size);
    if (w > maxWidth) size = Math.max(6, (fs * maxWidth) / w);
    return text(cx, y, str, { anchor: 'middle', size: size === fs ? undefined : size });
}

function samplerSymbol(type, x, y, w, h, patternId, custom) {
    const box = `<rect x="${r(x)}" y="${r(y)}" width="${r(w)}" height="${r(h)}" fill="#fff" stroke="#000" stroke-width="1.2"/>`;
    if (custom) {
        // A user-supplied sampler symbol: the image stretched to the sample interval, framed.
        return `<rect x="${r(x)}" y="${r(y)}" width="${r(w)}" height="${r(h)}" fill="#fff"/>`
            + `<image href="${escapeXml(custom.image)}" x="${r(x)}" y="${r(y)}" width="${r(w)}" height="${r(h)}" preserveAspectRatio="none"/>`
            + `<rect x="${r(x)}" y="${r(y)}" width="${r(w)}" height="${r(h)}" fill="none" stroke="#000" stroke-width="1.2"/>`;
    }
    const cx = x + w / 2;
    const my = y + h / 2;
    const X = x + w;
    const Y = y + h;
    const bulk = `<rect x="${r(x)}" y="${r(y)}" width="${r(w)}" height="${r(h)}" fill="url(#${patternId})" stroke="#000" stroke-width="1.2"/>`;
    const inner = `<rect x="${r(x + w * 0.22)}" y="${r(y + Math.min(2, h / 4))}" width="${r(w * 0.56)}" height="${r(Math.max(h - 2 * Math.min(2, h / 4), 0.5))}" fill="none" stroke="#000" stroke-width="0.8"/>`;
    // Marks repeated down the interval, about every `step` px (at least once).
    const down = (step, draw) => {
        const n = Math.max(1, Math.round(h / step));
        return Array.from({ length: n }, (_, k) => draw(y + (k * h) / n, h / n)).join('');
    };
    switch (type) {
        case 'SPT':
            return box + line(x, y, X, Y) + line(x, Y, X, y);
        case 'ModCal':
            return box + `<path d="M${r(x)} ${r(y)}L${r(cx)} ${r(my)}L${r(x)} ${r(Y)}ZM${r(X)} ${r(y)}L${r(cx)} ${r(my)}L${r(X)} ${r(Y)}Z" fill="#000"/>`;
        case 'DamesMoore':
            // Modified California with only the left half filled: a similar ring-lined drive sampler.
            return box + `<path d="M${r(x)} ${r(y)}L${r(cx)} ${r(my)}L${r(x)} ${r(Y)}Z" fill="#000"/>`
                + `<path d="M${r(X)} ${r(y)}L${r(cx)} ${r(my)}L${r(X)} ${r(Y)}" fill="none" stroke="#000" stroke-width="0.8"/>`;
        case 'Shelby':
            return box + line(cx, y, cx, Y, 2.5);
        case 'Piston':
            return box + line(x + w * 0.35, y, x + w * 0.35, Y) + line(x + w * 0.65, y, x + w * 0.65, Y);
        case 'Osterberg':
            // Piston with a bar across the top (the fixed piston head).
            return box + line(x + w * 0.35, y, x + w * 0.35, Y) + line(x + w * 0.65, y, x + w * 0.65, Y)
                + `<rect x="${r(x)}" y="${r(y)}" width="${r(w)}" height="${r(Math.min(3, h / 3))}" fill="#000"/>`;
        case 'Pitcher':
            return box + inner;
        case 'Denison':
            return box + inner + line(cx, y, cx, Y, 0.8);
        case 'LargeDiameter':
            // Wider than the other symbols.
            return `<rect x="${r(x - 3)}" y="${r(y)}" width="${r(w + 6)}" height="${r(h)}" fill="#fff" stroke="#000" stroke-width="1.2"/>` + line(cx, y, cx, Y, 1);
        case 'Block':
            return `<rect x="${r(x)}" y="${r(y)}" width="${r(w)}" height="${r(h)}" fill="#fff" stroke="#000" stroke-width="2.4"/>` + line(x, y, X, Y);
        case 'DirectPush': {
            const ah = Math.min(5, h / 2);
            return box + line(cx, y, cx, Y - ah) + `<path d="M${r(cx - w * 0.3)} ${r(Y - ah)}L${r(cx + w * 0.3)} ${r(Y - ah)}L${r(cx)} ${r(Y)}Z" fill="#000"/>`;
        }
        case 'GelPush':
            return `<rect x="${r(x)}" y="${r(y)}" width="${r(w)}" height="${r(h)}" fill="#ddd" stroke="#000" stroke-width="1.2"/>`
                + line(x + w / 3, y, x + w / 3, Y, 0.8) + line(x + (2 * w) / 3, y, x + (2 * w) / 3, Y, 0.8);
        case 'Sonic':
            return box + down(5, (yy, sh) => {
                const wy = yy + sh / 2;
                const a = Math.min(1.5, sh / 3);
                return `<path d="M${r(x)} ${r(wy)}Q${r(x + w / 4)} ${r(wy - a)} ${r(cx)} ${r(wy)}T${r(X)} ${r(wy)}" fill="none" stroke="#000" stroke-width="0.8"/>`;
            });
        case 'Bulk':
            return bulk;
        case 'Grab':
            return bulk + `<circle cx="${r(cx)}" cy="${r(my)}" r="${r(Math.min(w, h) * 0.22)}" fill="#000" stroke="#fff" stroke-width="1"/>`;
        case 'Composite':
            // Bulk with white bands across it.
            return bulk + down(6, (yy, sh) => `<rect x="${r(x + 0.6)}" y="${r(yy + sh * 0.35)}" width="${r(w - 1.2)}" height="${r(sh * 0.3)}" fill="#fff"/>`)
                + `<rect x="${r(x)}" y="${r(y)}" width="${r(w)}" height="${r(h)}" fill="none" stroke="#000" stroke-width="1.2"/>`;
        case 'Trench': {
            // A U-shaped trench filled with the bulk hatch.
            const tt = y + h * 0.3;
            const pad = Math.min(2, h / 6);
            return box + `<path d="M${r(x + 2)} ${r(tt)}L${r(x + 2)} ${r(Y - pad)}L${r(X - 2)} ${r(Y - pad)}L${r(X - 2)} ${r(tt)}Z" fill="url(#${patternId})"/>`
                + `<path d="M${r(x + 2)} ${r(tt)}L${r(x + 2)} ${r(Y - pad)}L${r(X - 2)} ${r(Y - pad)}L${r(X - 2)} ${r(tt)}" fill="none" stroke="#000" stroke-width="1"/>`;
        }
        case 'Auger':
            // Slanted flights, as on an auger.
            return box + down(4, (yy, sh) => line(x, yy + sh, X, yy, 0.8));
        case 'Disturbed':
            return box + `<polyline points="${down(4, (yy, sh) => `${r(x + w * 0.25)},${r(yy)} ${r(x + w * 0.75)},${r(yy + sh / 2)} `)}${r(x + w * 0.25)},${r(Y)}" fill="none" stroke="#000" stroke-width="0.8"/>`;
        case 'Core':
            return `<rect x="${r(x)}" y="${r(y)}" width="${r(w)}" height="${r(h)}" fill="#bbb" stroke="#000" stroke-width="1.2"/>`;
        case 'TripleTube':
            return `<rect x="${r(x)}" y="${r(y)}" width="${r(w)}" height="${r(h)}" fill="#bbb" stroke="#000" stroke-width="1.2"/>`
                + line(x + w / 3, y, x + w / 3, Y, 0.8) + line(x + (2 * w) / 3, y, x + (2 * w) / 3, Y, 0.8);
        case 'NoRecovery':
            return `<rect x="${r(x)}" y="${r(y)}" width="${r(w)}" height="${r(h)}" fill="#fff" stroke="#000" stroke-width="1" stroke-dasharray="2 1.5"/>` + line(x, Y, X, y, 0.8);
        default:
            return box + `<path d="M${r(X)} ${r(y)}L${r(X)} ${r(Y)}L${r(x)} ${r(Y)}Z" fill="#000"/>`;
    }
}

function groundwaterSymbol(x, y) {
    return `<path d="M${r(x - 5)} ${r(y - 8)}L${r(x + 5)} ${r(y - 8)}L${r(x)} ${r(y)}Z" fill="#fff" stroke="#000" stroke-width="1"/>`
        + line(x - 5, y + 2, x + 5, y + 2, 1) + line(x - 3, y + 4.5, x + 3, y + 4.5, 1);
}

function hashString(s) {
    let h = 0x811c9dc5;
    for (let i = 0; i < s.length; i++) {
        h ^= s.charCodeAt(i);
        h = Math.imul(h, 0x01000193);
    }
    return (h >>> 0).toString(36);
}

// ---------------------------------------------------------------- header

function metadataFields(doc, u) {
    const m = doc.metadata;
    const fields = [];
    const add = (label, value) => {
        if (value !== undefined && value !== '') fields.push([label, String(value)]);
    };
    add('Project', m.project);
    add('Site', m.site_name);
    add('Latitude', m.latitude === undefined ? undefined : `${m.latitude.toFixed(5)}°`);
    add('Longitude', m.longitude === undefined ? undefined : `${m.longitude.toFixed(5)}°`);
    add('Ground elevation', m.elevation === undefined ? undefined : `${u.length(m.elevation).toFixed(2)} ${u.len}${m.datum ? ` (${m.datum})` : ''}`);
    add('Date', m.start_date && m.end_date && m.end_date !== m.start_date ? `${m.start_date} – ${m.end_date}` : m.start_date ?? m.end_date);
    add('Drilling method', m.boring_type);
    add('Rig', m.rig);
    add('Borehole diameter', m.diameter === undefined ? undefined : `${fmt({ mm: 0, cm: 1, m: 3, in: 1, ft: 2 }[u.dia])(u.diameter(m.diameter))} ${u.dia}`);
    add('Hammer', [m.hammer, m.energy_ratio !== undefined ? `ER = ${m.energy_ratio}%` : undefined].filter(Boolean).join(', ') || undefined);
    add('Logged by', m.logged_by);
    add('Driller', m.driller);
    return fields;
}

// A reference's text with its http(s) url after it (unless the text has it), and the url to link.
function referenceText(ref) {
    const url = /^https?:\/\/[^\s"<>]+$/i.test(String(ref.url ?? '').trim()) ? ref.url.trim() : null;
    return { url, full: url && !ref.text.includes(url) ? `${ref.text.trim()} ${url}` : ref.text.trim() };
}
const linked = (url, body) => (url ? `<a href="${escapeXml(url)}" target="_blank">${body}</a>` : body);

function drawHeader(doc, opt, u, x0, width, y0, fs) {
    const out = [];
    const lh = fs * 1.2;
    const titleSize = fs * 1.5;
    const title = opt.title ?? doc.metadata.boring_name ?? 'Boring log';
    let y = y0 + titleSize;
    out.push(text(x0, y, title, { size: titleSize, bold: true }));
    y += lh * 0.8;

    const fields = metadataFields(doc, u);
    const perRow = 3;
    const cellW = width / perRow;
    for (let i = 0; i < fields.length; i += perRow) {
        let rowLines = 1;
        const row = fields.slice(i, i + perRow).map(([label, value], k) => {
            const labelText = `${label}: `;
            const labelW = measureText(labelText, fs, true);
            const lines = wrapText(value, Math.max(cellW - labelW - 8, 40), fs);
            rowLines = Math.max(rowLines, lines.length);
            return { x: x0 + k * cellW, labelText, labelW, lines };
        });
        for (const cell of row) {
            out.push(text(cell.x, y + fs, cell.labelText, { bold: true }));
            cell.lines.forEach((ln, j) => out.push(text(cell.x + cell.labelW, y + fs + j * lh, ln)));
        }
        y += rowLines * lh + 2;
    }
    if (doc.metadata.notes) {
        const labelW = measureText('Notes: ', fs, true);
        const lines = wrapText(doc.metadata.notes, width - labelW, fs);
        out.push(text(x0, y + fs, 'Notes: ', { bold: true }));
        lines.forEach((ln, j) => out.push(text(x0 + labelW, y + fs + j * lh, ln)));
        y += lines.length * lh + 2;
    }
    // The sources of the data, full width, so they're seen before a tall log.
    const refs = opt.references ? doc.references ?? [] : [];
    if (refs.length) {
        const label = refs.length > 1 ? 'References: ' : 'Reference: ';
        const labelW = measureText(label, fs, true);
        out.push(text(x0, y + fs, label, { bold: true }));
        for (const ref of refs) {
            const { url, full } = referenceText(ref);
            const lines = wrapText(full, width - labelW, fs);
            out.push(linked(url, lines.map((ln, j) => text(x0 + labelW, y + fs + j * lh, ln)).join('')));
            y += lines.length * lh + 2;
        }
    }
    return { svg: out.join(''), bottom: y + 6 };
}

// Column header height: the smallest height at which every rotated label
// fits in the lines its column has room for.
function columnHeaderHeight(cols, fs) {
    const lh = fs * 1.2;
    for (let h = 60; h <= 200; h += 10) {
        const ok = cols.every(c => {
            if (c.flex) return wrapText(c.label, c.w - 8, fs, true).length * lh <= h - 8;
            const maxLines = Math.max(1, Math.floor((c.w - 4) / lh));
            return wrapText(c.label, h - 8, fs, true).length <= maxLines;
        });
        if (ok) return h;
    }
    return 200;
}

function drawColumnHeaders(cols, y0, h, fs) {
    const lh = fs * 1.2;
    const out = [];
    for (const c of cols) {
        if (c.flex) {
            const lines = wrapText(c.label, c.w - 8, fs, true);
            const startY = y0 + h - 6 - (lines.length - 1) * lh;
            lines.forEach((ln, i) => out.push(text(c.x + c.w / 2, startY + i * lh, ln, { anchor: 'middle', bold: true })));
        } else {
            const lines = wrapText(c.label, h - 8, fs, true);
            // Rotated text: lines stack left to right, reading bottom to top.
            const firstX = c.x + c.w / 2 - ((lines.length - 1) * lh) / 2 + fs * 0.35;
            lines.forEach((ln, i) => out.push(text(firstX + i * lh, y0 + h - 4, ln, { bold: true, rotate: true })));
        }
    }
    return out.join('');
}

// ---------------------------------------------------------------- main

export function renderBoringLog(input, options = {}) {
    const doc = normalizeBoringLog(input);
    const opt = { ...DEFAULTS, ...options };
    const fs = opt.font_size;
    const lh = fs * 1.2;
    const u = displayUnits(doc, opt);
    const prefix = opt.id_prefix ?? `blv${hashString(JSON.stringify(doc))}`;

    // Convert everything drawn on the depth axis to display units up front.
    const layers = doc.layers.map(l => {
        const inferred = opt.infer_uscs && !l.uscs && !l.hatch ? inferUscs(l.description) : null;
        const material = opt.infer_materials && !l.hatch ? inferMaterial(l.description) : null;
        return {
            ...l, top: u.length(l.top), bottom: u.length(l.bottom),
            ...(inferred ? { uscs_inferred: inferred.uscs } : {}), ...(material ? { material_inferred: material } : {}),
        };
    });
    const samples = doc.samples.map(s => ({ ...s, top: u.length(s.top), bottom: u.length(s.bottom) }));
    const groundwater = doc.groundwater.map(g => ({ ...g, depth: u.length(g.depth) }));
    const depthNotes = doc.depth_notes.map(n => ({ ...n, depth: u.length(n.depth) }));
    const drawDoc = { ...doc, layers, samples, groundwater, depth_notes: depthNotes };

    const deepest = Math.max(...layers.map(l => l.bottom), ...samples.map(s => s.bottom), ...groundwater.map(g => g.depth), ...depthNotes.map(n => n.depth));
    const [dTop, dBottom] = opt.depth_range ?? [Math.min(0, ...layers.map(l => l.top)), deepest];
    const range = Math.max(dBottom - dTop, 1e-6);

    const { cols, width } = resolveColumns(drawDoc, opt, u, opt.width);
    const col = id => cols.find(c => c.id === id);
    const descCol = col('description');
    const sampleTextCols = cols.filter(c => c.kind === 'sample_text');

    // Depth scale: start from the requested size, stretch until each sample row
    // lines up with its sampler (up to MAX_ALIGNED_HEIGHT), then until the
    // stacked text ends no lower than the bottom of the scale.
    let scale = opt.scale ?? opt.height / range;
    const wrappedRows = wrapSampleRows(samples, sampleTextCols, fs);
    if (opt.fit_text) scale = Math.max(scale, Math.min(rowAlignScale(wrappedRows, dTop, fs), MAX_ALIGNED_HEIGHT / range));
    let blocks;
    let rows;
    for (let i = 0; i < 12; i++) {
        blocks = layoutDescriptions(layers, depthNotes, descCol, scale, dTop, fs);
        rows = layoutSampleRows(wrappedRows, scale, dTop, fs);
        const needed = Math.max(0, ...blocks.map(b => b.bottom), ...rows.map(rw => rw.bottom));
        if (!opt.fit_text || needed <= range * scale + 0.5) break;
        scale *= needed / (range * scale) + 0.002;
    }
    const contentBottom = Math.max(range * scale, ...blocks.map(b => b.bottom), ...rows.map(rw => rw.bottom));

    const out = [];
    const defs = [];
    let y = MARGIN;

    // Header block.
    if (opt.header) {
        const header = drawHeader(doc, opt, u, MARGIN + 4, width - 2 * MARGIN - 8, y + 4, fs);
        out.push(`<rect x="${MARGIN}" y="${r(y)}" width="${r(width - 2 * MARGIN)}" height="${r(header.bottom - y)}" fill="none" stroke="#000" stroke-width="1"/>`);
        out.push(header.svg);
        y = header.bottom + 6;
    }

    // Column headers.
    const headH = columnHeaderHeight(cols, fs);
    const headTop = y;
    out.push(drawColumnHeaders(cols, headTop, headH, fs));
    const bodyTop = headTop + headH;
    const y0 = bodyTop;                          // y of depth dTop
    const yOf = d => y0 + (d - dTop) * scale;
    const bodyBottom = y0 + contentBottom;
    const scaleBottom = y0 + range * scale;

    // Hatch patterns, aligned to the graphic column so tiles line up across layers.
    const graphic = col('graphic');
    const hatchScale = graphic.w / 104;
    // The tile for a graphic-log code: the document's own pattern (an image, tiled
    // at tile_width px, one tile across the column by default) or the built-in one.
    const customPatterns = doc.patterns ?? {};
    const soilPattern = code => (customPatterns[code] && customPatterns[code].kind !== 'sampler' ? customPatterns[code] : null);
    const tileFor = code => {
        const custom = soilPattern(code);
        if (custom) {
            const tw = custom.tile_width ?? graphic.w;
            const th = tw * custom.height / custom.width;
            return { width: r(tw), height: r(th), scale: 1, body: `<image href="${escapeXml(custom.image)}" width="${r(tw)}" height="${r(th)}" preserveAspectRatio="none"/>` };
        }
        const tile = builtInTile(code);
        return tile ? { ...tile, scale: hatchScale } : null;
    };
    const nameOf = code => soilPattern(code)?.name ?? hatchName(code);
    // A dual symbol with a built-in combined tile (SP-SM: sand dots with a light
    // silt overlay) is drawn as that one tile, unless either half has the
    // document's own pattern; others (CL-ML) are split into halves.
    function hatchCodes(l) {
        const codes = layerHatch(l);
        const combined = codes.join('-');
        if (codes.length === 2 && HATCH_TILES[combined] && !soilPattern(codes[0]) && !soilPattern(codes[1])) return [combined];
        return codes;
    }
    const usedHatches = new Set();
    const dualRight = new Set();
    for (const l of layers) {
        const codes = hatchCodes(l);
        codes.forEach(h => usedHatches.add(h));
        if (codes.length === 2) dualRight.add(codes[1]);
    }
    const samplerPattern = type => (customPatterns[type]?.kind === 'sampler' ? customPatterns[type] : null);
    for (const code of [...usedHatches].sort()) {
        const tile = tileFor(code);
        if (!tile) continue;
        defs.push(`<pattern id="${prefix}-${code}" patternUnits="userSpaceOnUse" width="${tile.width}" height="${tile.height}" patternTransform="translate(${r(graphic.x)} ${r(y0)}) scale(${r(tile.scale * 1000) / 1000})">${tile.body}</pattern>`);
        // The right half of a dual symbol starts its pattern at the divider, so the
        // pattern's own lines don't sit beside the divider.
        if (dualRight.has(code)) {
            defs.push(`<pattern id="${prefix}-${code}-right" patternUnits="userSpaceOnUse" width="${tile.width}" height="${tile.height}" patternTransform="translate(${r(graphic.x + graphic.w / 2)} ${r(y0)}) scale(${r(tile.scale * 1000) / 1000})">${tile.body}</pattern>`);
        }
    }
    const usedSamplers = new Set(samples.map(s => s.type ?? 'Other'));
    if (['Bulk', 'Grab', 'Composite', 'Trench'].some(t => usedSamplers.has(t))) {
        defs.push(`<pattern id="${prefix}-bulk" patternUnits="userSpaceOnUse" width="4" height="4" patternTransform="rotate(45)"><line x1="0" y1="0" x2="0" y2="4" stroke="#000" stroke-width="1"/></pattern>`);
    }

    // Column contents.
    for (const c of cols) {
        const x1 = c.x + c.w;
        if (c.kind === 'depth' || c.kind === 'elevation') {
            const step = niceStep(40 / scale);
            const dec = decimalsFor(step);
            const elev = c.kind === 'elevation' ? u.length(doc.metadata.elevation) : null;
            // Ticks at round depths, or at round elevations for the elevation column.
            const valueAt = d => (elev === null ? d : elev - d);
            const lo = Math.min(valueAt(dTop), valueAt(dBottom));
            const hi = Math.max(valueAt(dTop), valueAt(dBottom));
            for (let v = Math.ceil(lo / step - 1e-9) * step; v <= hi + 1e-9; v += step) {
                const d = elev === null ? v : elev - v;
                const ty = yOf(d);
                out.push(line(x1 - 5, ty, x1, ty, 0.75));
                // Keep labels at the ends of the scale inside the frame.
                let labelY = ty + fs * 0.35;
                if (ty - y0 < fs * 0.6) labelY = ty + fs * 0.9;
                else if (scaleBottom - ty < fs * 0.6 && Math.abs(scaleBottom - bodyBottom) < fs) labelY = ty - 2;
                out.push(text(x1 - 7, labelY, (Math.abs(v) < 1e-9 ? 0 : v).toFixed(dec), { anchor: 'end' }));
                for (let k = 1; k < 5; k++) {
                    const md = d + ((elev === null ? 1 : -1) * k * step) / 5;
                    if (md > dBottom + 1e-9 || md < dTop - 1e-9) continue;
                    out.push(line(x1 - 2.5, yOf(md), x1, yOf(md), 0.5));
                }
            }
        } else if (c.kind === 'groundwater') {
            // Alternate sides when two observations would overlap.
            let prevY = -Infinity;
            let side = 0;
            for (const g of groundwater) {
                const gy = yOf(g.depth);
                side = gy - prevY < 12 ? 1 - side : 0;
                prevY = gy;
                const shift = groundwater.length > 1 && side ? 4 : groundwater.length > 1 ? -4 : 0;
                out.push(groundwaterSymbol(c.x + c.w / 2 + shift, gy));
            }
        } else if (c.kind === 'graphic') {
            for (const l of layers) {
                const codes = hatchCodes(l).filter(h => tileFor(h));
                const top = yOf(l.top);
                const h = (l.bottom - l.top) * scale;
                const parts = codes.length ? codes : [null];
                parts.forEach((code, k) => {
                    const pw = c.w / parts.length;
                    const fill = code ? `url(#${prefix}-${code}${parts.length === 2 && k === 1 ? '-right' : ''})` : '#fff';
                    // Solid colours (asphalt, coal...) are drawn as a plain fill: a filled
                    // tile shows faint seams where tiles meet.
                    const bg = code && tileFor(code)?.background;
                    if (bg) out.push(`<rect x="${r(c.x + k * pw)}" y="${r(top)}" width="${r(pw)}" height="${r(h)}" fill="${bg}"/>`);
                    out.push(`<rect x="${r(c.x + k * pw)}" y="${r(top)}" width="${r(pw)}" height="${r(h)}" fill="${fill}"/>`);
                });
                // A dual symbol (SP-SM) is drawn as the first pattern on the left and
                // the second on the right, with a line between the halves.
                if (parts.length === 2) out.push(line(c.x + c.w / 2, top, c.x + c.w / 2, top + h, 0.75));
            }
        } else if (c.kind === 'uscs') {
            for (const b of blocks) {
                const label = shownUscs(b.layer) ?? (b.layer.uscs_inferred ? `(${b.layer.uscs_inferred})` : null);
                if (label) out.push(fittedText(c.x + c.w / 2, y0 + b.top + TEXT_PAD_Y + fs * 0.85, label, c.w - 4, fs));
            }
        } else if (c.kind === 'description') {
            for (const b of blocks) {
                b.lines.forEach((ln, i) => out.push(text(c.x + DESC_PAD_X, y0 + b.top + TEXT_PAD_Y + fs * 0.85 + i * lh, ln)));
                // Depth notes: a tick at the note's depth, bending down to the
                // note's first line if it had to be pushed below that depth.
                for (const nb of b.notes) {
                    const yd = y0 + nb.y;
                    const yt = y0 + nb.top + TEXT_PAD_Y + lh / 2;
                    if (Math.abs(yt - yd) < 0.5) out.push(line(c.x, yd, c.x + BEND, yd, 0.5));
                    else out.push(`<polyline points="${r(c.x)},${r(yd)} ${r(c.x + BEND)},${r(yt)}" fill="none" stroke="#000" stroke-width="0.5"/>`);
                    nb.lines.forEach((ln, i) => out.push(text(c.x + DESC_PAD_X, y0 + nb.top + TEXT_PAD_Y + fs * 0.85 + i * lh, ln, { italic: true })));
                }
            }
        } else if (c.kind === 'sample_symbol') {
            for (const s of samples) {
                const top = yOf(s.top);
                const h = Math.max((s.bottom - s.top) * scale, 3);
                out.push(samplerSymbol(s.type ?? 'Other', c.x + 5, top, c.w - 10, h, `${prefix}-bulk`, samplerPattern(s.type)));
            }
        } else if (c.kind === 'sample_value') {
            for (const row of rows) {
                const v = c.value(row.sample);
                if (v === undefined || v === '') continue;
                out.push(fittedText(c.x + c.w / 2, y0 + row.top + TEXT_PAD_Y + fs * 0.85, String(v), c.w - 4, fs));
            }
        } else if (c.kind === 'sample_text') {
            for (const row of rows) {
                row.wrapped[c.id].forEach((ln, i) => out.push(text(c.x + TEXT_PAD_X, y0 + row.top + TEXT_PAD_Y + fs * 0.85 + i * lh, ln)));
            }
        }
    }

    // Layer boundaries: straight across the columns left of the description,
    // then a leader bending to where the description text actually starts.
    const boundaryCols = cols.filter(c => c.kind === 'graphic' || c.kind === 'uscs');
    const boundaries = [];
    blocks.forEach((b, i) => {
        const prev = blocks[i - 1];
        if (!prev || Math.abs(prev.layerBottom - b.layerTop) > 0.01) {
            if (prev) boundaries.push({ yLayer: prev.layerBottom, yText: prev.bottom });
            boundaries.push({ yLayer: b.layerTop, yText: b.top });
        } else {
            boundaries.push({ yLayer: b.layerTop, yText: b.top });
        }
    });
    const last = blocks[blocks.length - 1];
    boundaries.push({ yLayer: last.layerBottom, yText: last.bottom });
    for (const { yLayer, yText } of boundaries) {
        const yl = y0 + yLayer;
        const yt = y0 + yText;
        for (const c of boundaryCols) out.push(line(c.x, yl, c.x + c.w, yl));
        if (Math.abs(yt - yl) < 0.5) {
            out.push(line(descCol.x, yl, descCol.x + descCol.w, yl));
        } else {
            const xa = descCol.x;
            const xb = descCol.x + descCol.w;
            out.push(`<polyline points="${r(xa)},${r(yl)} ${r(xa + BEND)},${r(yt)} ${r(xb - BEND)},${r(yt)} ${r(xb)},${r(yl)}" fill="none" stroke="#000" stroke-width="0.75"/>`);
        }
    }

    // Frame and column rules.
    out.push(`<rect x="${MARGIN}" y="${r(headTop)}" width="${r(width - 2 * MARGIN)}" height="${r(bodyBottom - headTop)}" fill="none" stroke="#000" stroke-width="1"/>`);
    out.push(line(MARGIN, bodyTop, width - MARGIN, bodyTop, 1));
    for (const c of cols.slice(1)) out.push(line(c.x, headTop, c.x, bodyBottom, 0.75));

    // Legend.
    let bottom = bodyBottom;
    if (opt.legend) {
        const items = [];
        for (const code of [...usedHatches].sort()) {
            if (tileFor(code)) items.push({ kind: 'hatch', code, label: `${code} – ${nameOf(code)}` });
        }
        const duals = new Set();
        for (const l of layers) {
            const codes = hatchCodes(l).filter(h => tileFor(h));
            if (codes.length === 2) duals.add(codes.join('-'));
        }
        for (const dual of [...duals].sort()) {
            const [a, b] = dual.split('-');
            const name = (!soilPattern(a) && !soilPattern(b) && DUAL_NAMES[dual]) || `${nameOf(a)} / ${nameOf(b).toLowerCase()}`;
            items.push({ kind: 'dual', codes: [a, b], label: `${dual} – ${name} (left: ${a}, right: ${b})` });
        }
        for (const type of Object.keys(SAMPLER_NAMES)) {
            if (usedSamplers.has(type)) items.push({ kind: 'sampler', type, label: samplerPattern(type)?.name ?? SAMPLER_NAMES[type] });
        }
        // Sampler types defined only in the document's patterns
        for (const type of [...usedSamplers].filter(t => !SAMPLER_NAMES[t]).sort()) {
            items.push({ kind: 'sampler', type, label: samplerPattern(type)?.name ?? type });
        }
        for (const g of doc.groundwater) {
            const details = [g.date, g.note].filter(Boolean).join(', ');
            items.push({ kind: 'gw', label: `Groundwater at ${u.length(g.depth).toFixed(2)} ${u.len}${details ? ` (${details})` : ''}` });
        }
        if (cols.some(c => c.kind === 'uscs') && layers.some(l => l.uscs_inferred)) {
            items.push({ kind: 'text', symbol: '( )', label: 'USCS symbol inferred from the material description' });
        }
        if (items.length) {
            const ly = bodyBottom + 10;
            out.push(text(MARGIN, ly + fs, 'Legend', { bold: true }));
            const itemW = 250;
            const perRow = Math.max(1, Math.floor((width - 2 * MARGIN) / itemW));
            const rowH = 22;
            // Flow items into cells; a long label takes as many cells as it needs.
            let cell = 0;
            for (const it of items) {
                it.span = Math.min(perRow, Math.ceil((measureText(it.label, fs) + 44) / itemW));
                if ((cell % perRow) + it.span > perRow) cell += perRow - (cell % perRow);
                it.cell = cell;
                cell += it.span;
            }
            items.forEach(it => {
                const ix = MARGIN + (it.cell % perRow) * itemW;
                const iy = ly + fs + 8 + Math.floor(it.cell / perRow) * rowH;
                if (it.kind === 'hatch') {
                    const tile = tileFor(it.code);
                    defs.push(`<pattern id="${prefix}-legend-${it.code}" patternUnits="userSpaceOnUse" width="${tile.width}" height="${tile.height}" patternTransform="translate(${r(ix)} ${r(iy)}) scale(${r(tile.scale * 1000) / 1000})">${tile.body}</pattern>`);
                    if (tile.background) out.push(`<rect x="${r(ix)}" y="${r(iy)}" width="30" height="16" fill="${tile.background}"/>`);
                    out.push(`<rect x="${r(ix)}" y="${r(iy)}" width="30" height="16" fill="url(#${prefix}-legend-${it.code})" stroke="#000" stroke-width="0.75"/>`);
                } else if (it.kind === 'dual') {
                    it.codes.forEach((code, k) => {
                        const id = `${prefix}-legend-${it.codes.join('-')}-${k}`;
                        const tile = tileFor(code);
                        defs.push(`<pattern id="${id}" patternUnits="userSpaceOnUse" width="${tile.width}" height="${tile.height}" patternTransform="translate(${r(ix + k * 15)} ${r(iy)}) scale(${r(tile.scale * 1000) / 1000})">${tile.body}</pattern>`);
                        if (tile.background) out.push(`<rect x="${r(ix + k * 15)}" y="${r(iy)}" width="15" height="16" fill="${tile.background}"/>`);
                        out.push(`<rect x="${r(ix + k * 15)}" y="${r(iy)}" width="15" height="16" fill="url(#${id})"/>`);
                    });
                    out.push(line(ix + 15, iy, ix + 15, iy + 16, 0.75));
                    out.push(`<rect x="${r(ix)}" y="${r(iy)}" width="30" height="16" fill="none" stroke="#000" stroke-width="0.75"/>`);
                } else if (it.kind === 'sampler') {
                    out.push(samplerSymbol(it.type, ix + 9, iy, 12, 16, `${prefix}-bulk`, samplerPattern(it.type)));
                } else if (it.kind === 'text') {
                    out.push(text(ix + 15, iy + 12, it.symbol, { anchor: 'middle' }));
                } else {
                    out.push(groundwaterSymbol(ix + 15, iy + 11));
                }
                out.push(fittedTextLeft(ix + 38, iy + 12, it.label, it.span * itemW - 44, fs));
            });
            bottom = ly + fs + 8 + Math.ceil(cell / perRow) * rowH;
        }
    }

    // References are in the header; without one, they go below the legend.
    if (opt.references && !opt.header && doc.references?.length) {
        let ry = bottom + 10;
        out.push(text(MARGIN, ry + fs, doc.references.length > 1 ? 'References' : 'Reference', { bold: true }));
        ry += fs + 8;
        for (const ref of doc.references) {
            const { url, full } = referenceText(ref);
            const lines = wrapText(full, width - 2 * MARGIN - 12, fs);
            out.push(linked(url, lines.map((ln, i) => text(MARGIN + (i ? 12 : 0), ry + fs * 0.85 + i * lh, ln)).join('')));
            ry += lines.length * lh + 4;
        }
        bottom = ry;
    }

    const height = Math.ceil(bottom + MARGIN);
    const w = Math.ceil(width);
    const titleText = opt.title ?? doc.metadata.boring_name ?? 'Boring log';
    return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${height}" viewBox="0 0 ${w} ${height}" font-family="${escapeXml(FONT_FAMILY)}" font-size="${fs}" role="img">`
        + `<title>${escapeXml(titleText)}</title>`
        + (defs.length ? `<defs>${defs.join('')}</defs>` : '')
        + `<rect width="100%" height="100%" fill="#fff"/>`
        + out.join('')
        + '</svg>';
}

function fittedTextLeft(x, y, str, maxWidth, fs) {
    let size = fs;
    const w = measureText(str, size);
    if (w > maxWidth) size = Math.max(6, (fs * maxWidth) / w);
    return text(x, y, str, { size: size === fs ? undefined : size });
}

// ---------------------------------------------------------------- swatches
//
// Small standalone SVGs of the built-in hatches and sampler symbols, for pickers
// and help pages. They draw exactly what the log draws.

// A built-in USCS hatch filling a width x height box, or '' for an unknown code.
export function hatchSwatch(code, { width = 40, height = 24 } = {}) {
    const tile = builtInTile(code);
    if (!tile) return '';
    const id = `swatch-${code}`;
    return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">`
        + `<defs><pattern id="${id}" patternUnits="userSpaceOnUse" width="${tile.width}" height="${tile.height}" patternTransform="scale(${r((40 / 104) * 1000) / 1000})">${tile.body}</pattern></defs>`
        + (tile.background ? `<rect x="0.5" y="0.5" width="${width - 1}" height="${height - 1}" fill="${tile.background}"/>` : '')
        + `<rect x="0.5" y="0.5" width="${width - 1}" height="${height - 1}" fill="url(#${id})" stroke="#000" stroke-width="1"/></svg>`;
}

// A built-in sampler symbol, as in the log's sample type column.
export function samplerSwatch(type, { width = 16, height = 24 } = {}) {
    if (!SAMPLER_NAMES[type]) return '';
    const bulk = `swatch-bulk-${type}`;
    return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">`
        + (['Bulk', 'Grab', 'Composite', 'Trench'].includes(type) ? `<defs><pattern id="${bulk}" patternUnits="userSpaceOnUse" width="4" height="4" patternTransform="rotate(45)"><line x1="0" y1="0" x2="0" y2="4" stroke="#000" stroke-width="1"/></pattern></defs>` : '')
        // LargeDiameter is drawn 3 px wider on each side than the box it's given.
        + (type === 'LargeDiameter' ? samplerSymbol(type, 4, 1, width - 8, height - 2, bulk) : samplerSymbol(type, 1, 1, width - 2, height - 2, bulk))
        + '</svg>';
}
