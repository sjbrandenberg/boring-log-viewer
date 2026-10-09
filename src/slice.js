// A vertical slice through the 3D model (src/model3d.js) along a line, as a 2D
// cross-section: the interpolated layers between the line's ends, the ground,
// the water table, and the borings near the line projected onto it. Pure
// functions: no DOM or WebGL.
import { compassPoint, MAX_SECTION_LENGTH } from './section.js';
import { FONT_FAMILY, measureText, wrapText, escapeXml } from './text.js';

export { MAX_SECTION_LENGTH };

const UNEXPLORED = '#eceff3';
const r = v => Math.round(v * 100) / 100;

// The model at a point (x, y in metres, inside its box): ground, the top of
// each layer, the base of the lowest, and the water table (or null), by
// bilinear interpolation between grid nodes.
export function modelAt(model, x, y) {
    const { nx, ny, box, nodes } = model;
    const fx = Math.min(nx, Math.max(0, ((x - box.x0) / (box.x1 - box.x0)) * nx));
    const fy = Math.min(ny, Math.max(0, ((y - box.y0) / (box.y1 - box.y0)) * ny));
    const i = Math.min(nx - 1, Math.floor(fx));
    const j = Math.min(ny - 1, Math.floor(fy));
    const u = fx - i;
    const v = fy - j;
    const id = (a, b) => b * (nx + 1) + a;
    const n = [id(i, j), id(i + 1, j), id(i, j + 1), id(i + 1, j + 1)];
    const w = [(1 - u) * (1 - v), u * (1 - v), (1 - u) * v, u * v];
    const mix = get => n.reduce((s, k, q) => s + w[q] * get(k), 0);
    return {
        ground: mix(k => nodes[k].ground),
        tops: nodes[0].tops.map((_, L) => mix(k => nodes[k].tops[L])),
        base: mix(k => nodes[k].base),
        water: model.water ? mix(k => model.water[k]) : null,
    };
}

// Clips the segment a-b (points { x, y }) to the model's box; null if it
// misses the box or has no length.
export function clipToBox(box, a, b) {
    let t0 = 0;
    let t1 = 1;
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    for (const [p, q] of [[-dx, a.x - box.x0], [dx, box.x1 - a.x], [-dy, a.y - box.y0], [dy, box.y1 - a.y]]) {
        if (Math.abs(p) < 1e-12) {
            if (q < 0) return null;
        } else {
            const t = q / p;
            if (p < 0) t0 = Math.max(t0, t);
            else t1 = Math.min(t1, t);
        }
    }
    if (t1 - t0 < 1e-9) return null;
    const at = t => ({ x: a.x + dx * t, y: a.y + dy * t });
    return [at(t0), at(t1)];
}

// The model sampled along a-b: { length, points: [{ s (distance from a), x, y, ground, tops, base, water }] }.
export function sliceProfile(model, a, b, samples = 200) {
    const length = Math.hypot(b.x - a.x, b.y - a.y);
    const points = [];
    for (let k = 0; k <= samples; k++) {
        const t = k / samples;
        const x = a.x + (b.x - a.x) * t;
        const y = a.y + (b.y - a.y) * t;
        points.push({ s: length * t, x, y, ...modelAt(model, x, y) });
    }
    return { length, points };
}

// Direction from a to b, degrees clockwise from north (y is north).
export const sliceBearing = (a, b) => (Math.atan2(b.x - a.x, b.y - a.y) * 180 / Math.PI + 360) % 360;

// Borings within `corridor` metres of the line a-b, projected onto it:
// [{ ...boring, s, offset }] in order along the line.
export function boringsNearSlice(borings, a, b, corridor) {
    const len = Math.hypot(b.x - a.x, b.y - a.y) || 1;
    const ux = (b.x - a.x) / len;
    const uy = (b.y - a.y) / len;
    return borings.map(bo => {
        const s = (bo.x - a.x) * ux + (bo.y - a.y) * uy;
        const offset = Math.abs((bo.x - a.x) * uy - (bo.y - a.y) * ux);
        return { ...bo, s, offset };
    }).filter(bo => bo.s >= -1e-6 && bo.s <= len + 1e-6 && bo.offset <= corridor).sort((p, q) => p.s - q.s);
}

function niceStep(raw) {
    const p = 10 ** Math.floor(Math.log10(raw));
    const f = raw / p;
    return (f <= 1 ? 1 : f <= 2 ? 2 : f <= 5 ? 5 : 10) * p;
}

// The slice as an SVG figure.
// model: from buildModel; a, b: { x, y } ends (inside the box);
// borings: [{ name, x, y, ground (level), segments: [{ top, bottom (levels), fill }] }].
// Returns { svg, length, borings (names shown) }.
export function renderSlice(model, a, b, { borings = [], corridor = 25, width = 900, height = 360, title = 'Slice A–A′', font_size: fs = 11 } = {}) {
    const profile = sliceProfile(model, a, b);
    const { length, points } = profile;
    const L = model.layers.length;
    const near = boringsNearSlice(borings, a, b, corridor);
    const top = Math.max(...points.map(p => p.ground), ...near.map(bo => bo.ground));
    const bottom = model.lowest;
    const range = Math.max(1e-6, top - bottom);

    const left = 64;
    const right = 24;
    const plotW = width - left - right;
    const y0 = 70;                 // top of the plot (room for the title, A/A′ and boring names)
    const plotH = height;
    const X = s => left + (s / length) * plotW;
    const Y = level => y0 + ((top - level) / range) * plotH;
    const ve = Math.max(1, Math.round((plotH / range) / (plotW / length)));
    const out = [];
    const line = (x1, y1, x2, y2, stroke = '#000', w = 0.75, extra = '') => `<line x1="${r(x1)}" y1="${r(y1)}" x2="${r(x2)}" y2="${r(y2)}" stroke="${stroke}" stroke-width="${w}"${extra}/>`;
    const text = (x, y, s, { anchor = 'start', bold = false, size, fill } = {}) => `<text x="${r(x)}" y="${r(y)}"${anchor !== 'start' ? ` text-anchor="${anchor}"` : ''}${bold ? ' font-weight="bold"' : ''}${size ? ` font-size="${size}"` : ''}${fill ? ` fill="${fill}"` : ''}>${escapeXml(s)}</text>`;
    const poly = (upper, lower) => `${upper.map(([s, l]) => `${r(X(s))},${r(Y(l))}`).join(' ')} ${lower.slice().reverse().map(([s, l]) => `${r(X(s))},${r(Y(l))}`).join(' ')}`;

    // Layers, top down, then the part no boring reached.
    const levelOf = (p, k) => (k < L ? p.tops[k] : p.base);
    const present = new Set();
    for (let k = 0; k < L; k++) {
        if (!points.some(p => levelOf(p, k) - levelOf(p, k + 1) > 1e-3)) continue;
        present.add(k);
        const upper = points.map(p => [p.s, levelOf(p, k)]);
        const lower = points.map(p => [p.s, levelOf(p, k + 1)]);
        out.push(`<polygon points="${poly(upper, lower)}" fill="${model.layers[k].fill}" stroke="none"/>`);
    }
    out.push(`<polygon points="${poly(points.map(p => [p.s, p.base]), points.map(p => [p.s, bottom]))}" fill="${UNEXPLORED}" stroke="none"/>`);
    // Boundaries, the ground, the base of the model.
    for (let k = 1; k <= L; k++) out.push(`<polyline points="${points.map(p => `${r(X(p.s))},${r(Y(levelOf(p, k)))}`).join(' ')}" fill="none" stroke="#444" stroke-width="0.6"/>`);
    out.push(`<polyline points="${points.map(p => `${r(X(p.s))},${r(Y(p.ground))}`).join(' ')}" fill="none" stroke="#000" stroke-width="1.4"/>`);
    if (points[0].water !== null) {
        out.push(`<polyline points="${points.map(p => `${r(X(p.s))},${r(Y(p.water))}`).join(' ')}" fill="none" stroke="#1f5fa8" stroke-width="1.3" stroke-dasharray="6 4"/>`);
    }

    // Borings near the line, as columns in their layers' colours.
    const colW = Math.min(10, Math.max(5, plotW / 120));
    for (const bo of near) {
        const cx = X(bo.s);
        for (const seg of bo.segments) {
            out.push(`<rect x="${r(cx - colW / 2)}" y="${r(Y(seg.top))}" width="${r(colW)}" height="${r(Math.max(0.5, Y(seg.bottom) - Y(seg.top)))}" fill="${seg.fill}" stroke="#111" stroke-width="0.6"/>`);
        }
        out.push(line(cx, Y(bo.ground), cx, Y(bo.ground) - 8, '#111', 1));
        out.push(text(cx, Y(bo.ground) - 11, bo.name, { anchor: 'middle', bold: true }));
    }

    // Frame and axes.
    out.push(`<rect x="${left}" y="${y0}" width="${r(plotW)}" height="${r(plotH)}" fill="none" stroke="#000" stroke-width="1"/>`);
    const vStep = niceStep(range / 6);
    for (let v = Math.ceil(bottom / vStep) * vStep; v <= top + 1e-9; v += vStep) {
        const y = Y(v);
        out.push(line(left - 5, y, left, y));
        const shown = model.byDepth ? -v : v;
        out.push(text(left - 8, y + fs * 0.35, `${Math.abs(shown) < 1e-9 ? 0 : +shown.toFixed(vStep < 1 ? 1 : 0)}`, { anchor: 'end' }));
    }
    out.push(`<text x="16" y="${r(y0 + plotH / 2)}" text-anchor="middle" font-weight="bold" transform="rotate(-90 16 ${r(y0 + plotH / 2)})">${model.byDepth ? 'Depth (m)' : 'Elevation (m)'}</text>`);
    const hStep = niceStep(length / 8);
    for (let s = 0; s <= length + 1e-9; s += hStep) {
        out.push(line(X(s), y0 + plotH, X(s), y0 + plotH + 5));
        out.push(text(X(s), y0 + plotH + 8 + fs, `${+s.toFixed(hStep < 1 ? 1 : 0)}`, { anchor: 'middle' }));
    }
    out.push(text(left + plotW / 2, y0 + plotH + 14 + 2 * fs, 'Distance along the slice (m)', { anchor: 'middle', bold: true }));

    // Title, and the ends with the directions they point to.
    const bearing = sliceBearing(a, b);
    out.push(text(left, 22, title, { bold: true, size: fs + 4 }));
    out.push(text(left, y0 - 26, `A  ← ${compassPoint(bearing + 180)}`, { bold: true }));
    out.push(text(left + plotW, y0 - 26, `${compassPoint(bearing)} →  A′`, { anchor: 'end', bold: true }));

    // Legend: the layers the slice cuts, then the rest of the key.
    let y = y0 + plotH + 34 + 2 * fs;
    out.push(text(left, y + fs, 'Legend', { bold: true }));
    y += fs + 8;
    const items = [...present].map(k => ({ fill: model.layers[k].fill, label: model.layers[k].label }));
    const seen = new Set();
    const unique = items.filter(it => !seen.has(it.label) && seen.add(it.label));
    unique.push({ fill: UNEXPLORED, label: 'Not explored (below the borings)' });
    if (points[0].water !== null) unique.push({ water: true, label: 'Groundwater (interpolated)' });
    const cellW = 280;
    const perRow = Math.max(1, Math.floor(plotW / cellW));
    unique.forEach((it, n) => {
        const ix = left + (n % perRow) * cellW;
        const iy = y + Math.floor(n / perRow) * 20;
        if (it.water) out.push(line(ix, iy + 7, ix + 26, iy + 7, '#1f5fa8', 1.3, ' stroke-dasharray="6 4"'));
        else out.push(`<rect x="${ix}" y="${r(iy)}" width="26" height="14" fill="${it.fill}" stroke="#333" stroke-width="0.75"/>`);
        let label = it.label;
        while (label.length > 3 && measureText(label, fs) > cellW - 40) label = `${label.slice(0, -2)}…`;
        out.push(text(ix + 34, iy + 11, label));
    });
    y += Math.ceil(unique.length / perRow) * 20 + 6;

    // Notes.
    const notes = [
        `Slice through the 3D model, ${length >= 1000 ? `${(length / 1000).toFixed(2)} km` : `${Math.round(length)} m`} long, bearing ${Math.round(bearing)}° (${compassPoint(bearing)}); vertical exaggeration ×${ve}.`
        + (near.length ? ` Borings within ${Math.round(corridor)} m of the line are shown at their distance along it: ${near.map(bo => bo.name).join(', ')}.` : ' No boring is within ' + Math.round(corridor) + ' m of the line.'),
        'The layers between borings are interpolated, as in the 3D model: an interpretation, not a geologic model.',
    ];
    if (model.byDepth) notes.push('No ground elevations are given for these borings, so they are aligned at the ground surface.');
    for (const n of notes) {
        for (const ln of wrapText(n, plotW, fs - 1)) {
            out.push(text(left, y + fs, ln, { size: fs - 1, fill: '#444' }));
            y += (fs - 1) * 1.3;
        }
        y += 2;
    }
    const totalH = Math.ceil(y + 12);
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${totalH}" viewBox="0 0 ${width} ${totalH}" font-family="${escapeXml(FONT_FAMILY)}" font-size="${fs}" role="img">`
        + `<title>${escapeXml(title)}</title><rect width="100%" height="100%" fill="#fff"/>${out.join('')}</svg>`;
    return { svg, length, borings: near.map(bo => bo.name), ve };
}
