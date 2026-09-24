// Renders a boring log document to a standalone SVG string. Pure function:
// no DOM, no network, no external images, so the same code runs in the
// browser, in Node for the API, and in tests.
import { normalizeBoringLog } from './normalize.js';
import { layerHatch, USCS_NAMES } from './classify.js';
import { HATCH_TILES } from './hatches.js';
import { FONT_FAMILY, measureText, wrapText, escapeXml } from './text.js';

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
    title: null,
    units: null,         // display length units, 'm' or 'ft'; defaults to the data's units
    unit_weight: null,   // display unit weight units, 'kN/m3' or 'pcf'
    diameter_units: null,
    depth_range: null,   // [top, bottom] in display units
    id_prefix: null,     // prefix for pattern ids; needed if several logs share a page
};

export const SAMPLER_NAMES = {
    SPT: 'Standard penetration test (SPT)',
    ModCal: 'Modified California',
    Shelby: 'Shelby tube',
    Piston: 'Piston sampler',
    Bulk: 'Bulk sample',
    Core: 'Rock core',
    Other: 'Other sampler',
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
        uscs: { kind: 'uscs', width: 30, label: 'USCS', hasData: doc => doc.layers.some(l => l.uscs) },
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

// Stacks description blocks top-down: each starts at its layer top, or below
// the previous block if that ran long. Returns block positions in px from the
// top of the depth scale.
function layoutDescriptions(layers, col, scale, dTop, fs) {
    const lh = fs * 1.2;
    let cursor = -Infinity;
    return layers.map(layer => {
        const lines = wrapText(layer.description ?? '', col.w - 2 * DESC_PAD_X, fs);
        const textH = lines.length * lh + 2 * TEXT_PAD_Y;
        const layerTop = (layer.top - dTop) * scale;
        const layerBottom = (layer.bottom - dTop) * scale;
        const top = Math.max(layerTop, cursor);
        const height = Math.max(textH, layerBottom - top);
        cursor = top + height;
        return { layer, lines, layerTop, layerBottom, top, bottom: cursor };
    });
}

// Places one text row per sample, centered on the sample interval when there
// is room and pushed down past the previous row when there is not.
function layoutSampleRows(samples, textCols, scale, dTop, fs) {
    const lh = fs * 1.2;
    let cursor = -Infinity;
    return samples.map(sample => {
        const wrapped = {};
        let lines = 1;
        for (const c of textCols) {
            wrapped[c.id] = wrapText(c.value(sample) ?? '', c.w - 2 * TEXT_PAD_X, fs);
            lines = Math.max(lines, wrapped[c.id].length);
        }
        const height = lines * lh + 2 * TEXT_PAD_Y;
        const sTop = (sample.top - dTop) * scale;
        const sBottom = (sample.bottom - dTop) * scale;
        const top = Math.max((sTop + sBottom) / 2 - height / 2, cursor);
        cursor = top + height;
        return { sample, wrapped, sTop, sBottom, top, bottom: cursor };
    });
}

// ---------------------------------------------------------------- drawing helpers

function text(x, y, str, { size, anchor = 'start', bold = false, rotate = false, fill } = {}) {
    const attrs = [`x="${r(x)}"`, `y="${r(y)}"`];
    if (size) attrs.push(`font-size="${r(size)}"`);
    if (anchor !== 'start') attrs.push(`text-anchor="${anchor}"`);
    if (bold) attrs.push('font-weight="bold"');
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

function samplerSymbol(type, x, y, w, h, patternId) {
    const box = `<rect x="${r(x)}" y="${r(y)}" width="${r(w)}" height="${r(h)}" fill="#fff" stroke="#000" stroke-width="1.2"/>`;
    const cx = x + w / 2;
    const my = y + h / 2;
    switch (type) {
        case 'SPT':
            return box + line(x, y, x + w, y + h) + line(x, y + h, x + w, y);
        case 'ModCal':
            return box + `<path d="M${r(x)} ${r(y)}L${r(cx)} ${r(my)}L${r(x)} ${r(y + h)}ZM${r(x + w)} ${r(y)}L${r(cx)} ${r(my)}L${r(x + w)} ${r(y + h)}Z" fill="#000"/>`;
        case 'Shelby':
            return box + line(cx, y, cx, y + h, 2.5);
        case 'Piston':
            return box + line(x + w * 0.35, y, x + w * 0.35, y + h) + line(x + w * 0.65, y, x + w * 0.65, y + h);
        case 'Bulk':
            return `<rect x="${r(x)}" y="${r(y)}" width="${r(w)}" height="${r(h)}" fill="url(#${patternId})" stroke="#000" stroke-width="1.2"/>`;
        case 'Core':
            return `<rect x="${r(x)}" y="${r(y)}" width="${r(w)}" height="${r(h)}" fill="#bbb" stroke="#000" stroke-width="1.2"/>`;
        default:
            return box + `<path d="M${r(x + w)} ${r(y)}L${r(x + w)} ${r(y + h)}L${r(x)} ${r(y + h)}Z" fill="#000"/>`;
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
    const layers = doc.layers.map(l => ({ ...l, top: u.length(l.top), bottom: u.length(l.bottom) }));
    const samples = doc.samples.map(s => ({ ...s, top: u.length(s.top), bottom: u.length(s.bottom) }));
    const groundwater = doc.groundwater.map(g => ({ ...g, depth: u.length(g.depth) }));
    const drawDoc = { ...doc, layers, samples, groundwater };

    const deepest = Math.max(...layers.map(l => l.bottom), ...samples.map(s => s.bottom), ...groundwater.map(g => g.depth));
    const [dTop, dBottom] = opt.depth_range ?? [Math.min(0, ...layers.map(l => l.top)), deepest];
    const range = Math.max(dBottom - dTop, 1e-6);

    const { cols, width } = resolveColumns(drawDoc, opt, u, opt.width);
    const col = id => cols.find(c => c.id === id);
    const descCol = col('description');
    const sampleTextCols = cols.filter(c => c.kind === 'sample_text');

    // Depth scale: start from the requested size, then stretch until the
    // stacked text ends no lower than the bottom of the scale.
    let scale = opt.scale ?? opt.height / range;
    let blocks;
    let rows;
    for (let i = 0; i < 12; i++) {
        blocks = layoutDescriptions(layers, descCol, scale, dTop, fs);
        rows = layoutSampleRows(samples, sampleTextCols, scale, dTop, fs);
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
    const usedHatches = new Set();
    for (const l of layers) layerHatch(l).forEach(h => usedHatches.add(h));
    const hatchScale = graphic.w / 104;
    for (const code of [...usedHatches].sort()) {
        const tile = HATCH_TILES[code];
        if (!tile) continue;
        defs.push(`<pattern id="${prefix}-${code}" patternUnits="userSpaceOnUse" width="${tile.width}" height="${tile.height}" patternTransform="translate(${r(graphic.x)} ${r(y0)}) scale(${r(hatchScale * 1000) / 1000})">${tile.body}</pattern>`);
    }
    const usedSamplers = new Set(samples.map(s => s.type ?? 'Other'));
    if (usedSamplers.has('Bulk')) {
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
                const codes = layerHatch(l).filter(h => HATCH_TILES[h]);
                const top = yOf(l.top);
                const h = (l.bottom - l.top) * scale;
                const parts = codes.length ? codes : [null];
                parts.forEach((code, k) => {
                    const pw = c.w / parts.length;
                    const fill = code ? `url(#${prefix}-${code})` : '#fff';
                    out.push(`<rect x="${r(c.x + k * pw)}" y="${r(top)}" width="${r(pw)}" height="${r(h)}" fill="${fill}"/>`);
                });
            }
        } else if (c.kind === 'uscs') {
            for (const b of blocks) {
                if (b.layer.uscs) out.push(fittedText(c.x + c.w / 2, y0 + b.top + TEXT_PAD_Y + fs * 0.85, b.layer.uscs, c.w - 4, fs));
            }
        } else if (c.kind === 'description') {
            for (const b of blocks) {
                b.lines.forEach((ln, i) => out.push(text(c.x + DESC_PAD_X, y0 + b.top + TEXT_PAD_Y + fs * 0.85 + i * lh, ln)));
            }
        } else if (c.kind === 'sample_symbol') {
            for (const s of samples) {
                const top = yOf(s.top);
                const h = Math.max((s.bottom - s.top) * scale, 3);
                out.push(samplerSymbol(s.type ?? 'Other', c.x + 5, top, c.w - 10, h, `${prefix}-bulk`));
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
            if (HATCH_TILES[code]) items.push({ kind: 'hatch', code, label: `${code} – ${USCS_NAMES[code]}` });
        }
        for (const type of Object.keys(SAMPLER_NAMES)) {
            if (usedSamplers.has(type)) items.push({ kind: 'sampler', type, label: SAMPLER_NAMES[type] });
        }
        for (const g of doc.groundwater) {
            const details = [g.date, g.note].filter(Boolean).join(', ');
            items.push({ kind: 'gw', label: `Groundwater at ${u.length(g.depth).toFixed(2)} ${u.len}${details ? ` (${details})` : ''}` });
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
                    defs.push(`<pattern id="${prefix}-legend-${it.code}" patternUnits="userSpaceOnUse" width="104" height="93" patternTransform="translate(${r(ix)} ${r(iy)}) scale(${r(hatchScale * 1000) / 1000})">${HATCH_TILES[it.code].body}</pattern>`);
                    out.push(`<rect x="${r(ix)}" y="${r(iy)}" width="30" height="16" fill="url(#${prefix}-legend-${it.code})" stroke="#000" stroke-width="0.75"/>`);
                } else if (it.kind === 'sampler') {
                    out.push(samplerSymbol(it.type, ix + 9, iy, 12, 16, `${prefix}-bulk`));
                } else {
                    out.push(groundwaterSymbol(ix + 15, iy + 11));
                }
                out.push(fittedTextLeft(ix + 38, iy + 12, it.label, it.span * itemW - 44, fs));
            });
            bottom = ly + fs + 8 + Math.ceil(cell / perRow) * rowH;
        }
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
