// A layered 3D soil model from borings, for a block view like Settle3's: the
// borings' units are correlated across the site (between neighbours, by the
// same rules as the cross-sections), each correlated layer becomes one model
// layer, and its thickness is interpolated across a grid by inverse distance
// (thickness 0 where a boring doesn't have it, so layers pinch out). Pure
// functions: no DOM or WebGL.
import { matchUnits, colourClass, unitLabel, layerKey, SECTION_COLOURS } from './section.js';

// Correlates the units of all borings along the given edges (pairs of boring
// indices). Returns { layers, unitLayer } where layers are the model layers in
// order from the top, each { id, colour, label, codes, guessed, mean }, and
// unitLayer.get(unit) is the index of a unit's layer.
export function correlate(borings, edges) {
    const parent = new Map();
    const find = u => {
        while (parent.get(u) && parent.get(u) !== u) u = parent.get(u);
        return u;
    };
    const union = (a, b) => {
        const ra = find(a);
        const rb = find(b);
        if (ra !== rb) parent.set(rb, ra);
    };
    for (const b of borings) for (const u of b.units) parent.set(u, u);
    for (const [i, j] of edges) {
        const A = borings[i];
        const B = borings[j];
        // Compare by level (elevation when both have one, else depth).
        const level = (b, u) => (A.elev !== null && B.elev !== null ? [-(b.elev - u.top), -(b.elev - u.bottom)] : [u.top, u.bottom]);
        for (const [ia, ib] of matchUnits(A.units, B.units, u => (A.units.includes(u) ? level(A, u) : level(B, u)))) union(A.units[ia], B.units[ib]);
    }
    // Groups.
    const groups = new Map();
    for (const b of borings) {
        for (const u of b.units) {
            const root = find(u);
            if (!groups.has(root)) groups.set(root, []);
            groups.get(root).push(u);
        }
    }
    const list = [...groups.values()].map(units => {
        const thick = new Map();
        const guessed = new Set();
        const colourThick = new Map();
        let midSum = 0;
        let wSum = 0;
        for (const u of units) {
            for (const l of u.layers) {
                const code = layerKey(l);
                const t = l.bottom - l.top;
                if (code) thick.set(code, (thick.get(code) ?? 0) + t);
                if (code && l.guess) guessed.add(code);
                const c = colourClass(code) ?? 'other';
                colourThick.set(c, (colourThick.get(c) ?? 0) + t);
            }
            const t = u.bottom - u.top;
            midSum += ((u.top + u.bottom) / 2) * t;
            wSum += t;
        }
        const codes = [...thick].sort((a, b) => b[1] - a[1]).map(([c]) => c);
        const colour = [...colourThick].sort((a, b) => b[1] - a[1])[0]?.[0] ?? 'other';
        return { units, codes, guessed, colour, label: codes.length ? unitLabel(codes, guessed) : 'Unclassified', mean: wSum ? midSum / wSum : 0 };
    });
    // Order from the top: each boring's order where they agree (a topological
    // sort of "above" links), ties and conflicts settled by mean depth.
    const index = new Map();
    list.forEach((g, k) => g.units.forEach(u => index.set(u, k)));
    const below = list.map(() => new Set());
    const indeg = list.map(() => 0);
    for (const b of borings) {
        for (let n = 1; n < b.units.length; n++) {
            const a = index.get(b.units[n - 1]);
            const c = index.get(b.units[n]);
            if (a !== c && !below[a].has(c)) {
                below[a].add(c);
                indeg[c]++;
            }
        }
    }
    const order = [];
    const done = new Set();
    while (order.length < list.length) {
        let ready = list.map((_, k) => k).filter(k => !done.has(k) && indeg[k] === 0);
        // A conflict (a cycle): take the shallowest remaining layer.
        if (!ready.length) ready = list.map((_, k) => k).filter(k => !done.has(k));
        ready.sort((a, b) => list[a].mean - list[b].mean);
        const k = ready[0];
        done.add(k);
        order.push(k);
        for (const c of below[k]) indeg[c]--;
    }
    const layers = order.map((k, n) => ({ id: n, ...list[k] }));
    const unitLayer = new Map();
    layers.forEach((l, n) => l.units.forEach(u => unitLayer.set(u, n)));
    return { layers, unitLayer };
}

// Inverse-distance weighting (power 2), exact at the data points.
export function idw(points, values, x, y, power = 2) {
    let num = 0;
    let den = 0;
    for (let i = 0; i < points.length; i++) {
        const d2 = (points[i].x - x) ** 2 + (points[i].y - y) ** 2;
        if (d2 < 1e-6) return values[i];
        const w = 1 / d2 ** (power / 2);
        num += w * values[i];
        den += w;
    }
    return den ? num / den : 0;
}

// The model: for each grid node, the ground level, the top of each layer and
// the base of the lowest (levels in metres, up positive: elevation, or minus
// the depth when the borings have no elevations). Below the base, down to the
// box's bottom (the deepest boring), nothing was explored.
// borings: prepared borings; pos: their { x, y } in metres; edges: pairs.
export function buildModel(borings, pos, edges, { nx = 40, ny = 40, margin = 0.12 } = {}) {
    const { layers, unitLayer } = correlate(borings, edges);
    const byDepth = borings.some(b => b.elev === null);
    const ground = borings.map(b => (byDepth ? 0 : b.elev));
    // Thickness of each layer in each boring (0 where it is missing).
    const thick = layers.map(() => borings.map(() => 0));
    borings.forEach((b, i) => b.units.forEach(u => {
        thick[unitLayer.get(u)][i] += u.bottom - u.top;
    }));
    const xs = pos.map(p => p.x);
    const ys = pos.map(p => p.y);
    const spanX = Math.max(...xs) - Math.min(...xs);
    const spanY = Math.max(...ys) - Math.min(...ys);
    const pad = Math.max(10, margin * Math.max(spanX, spanY, 50));
    const box = { x0: Math.min(...xs) - pad, x1: Math.max(...xs) + pad, y0: Math.min(...ys) - pad, y1: Math.max(...ys) + pad };
    const lowest = Math.min(...borings.map((b, i) => ground[i] - b.depth));
    const nodes = [];
    for (let j = 0; j <= ny; j++) {
        for (let i = 0; i <= nx; i++) {
            const x = box.x0 + ((box.x1 - box.x0) * i) / nx;
            const y = box.y0 + ((box.y1 - box.y0) * j) / ny;
            const g = idw(pos, ground, x, y);
            const tops = [];
            let level = g;
            for (const t of thick) {
                tops.push(level);
                level -= Math.max(0, idw(pos, t, x, y));
            }
            nodes.push({ x, y, ground: g, tops, base: level });
        }
    }
    const groundwater = borings.map(b => (b.groundwater.length ? b.groundwater[0] : null));
    const withWater = groundwater.map((d, i) => (d === null ? null : i)).filter(i => i !== null);
    const water = withWater.length
        ? nodes.map(n => n.ground - idw(withWater.map(i => pos[i]), withWater.map(i => groundwater[i]), n.x, n.y))
        : null;
    return {
        nx, ny, box, nodes, layers: layerFills(layers).map((fill, k) => ({ ...layers[k], fill, units: undefined })),
        byDepth, ground, lowest, water,
        unitLayer, // unit -> layer index, for colouring the boring columns
    };
}

// Lighter or darker versions of a colour (HSL lightness shifted by delta).
export function shade(hex, delta) {
    const n = parseInt(hex.slice(1), 16);
    let [r, g, b] = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map(v => v / 255);
    const max = Math.max(r, g, b);
    const min = Math.min(r, g, b);
    let h = 0;
    let s = 0;
    let l = (max + min) / 2;
    if (max !== min) {
        const d = max - min;
        s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
        h = max === r ? (g - b) / d + (g < b ? 6 : 0) : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
        h /= 6;
    }
    l = Math.min(0.95, Math.max(0.12, l + delta));
    const hue = t => {
        t = (t + 1) % 1;
        const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
        const p = 2 * l - q;
        if (t < 1 / 6) return p + (q - p) * 6 * t;
        if (t < 1 / 2) return q;
        if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
        return p;
    };
    [r, g, b] = s === 0 ? [l, l, l] : [hue(h + 1 / 3), hue(h), hue(h - 1 / 3)];
    return `#${[r, g, b].map(v => Math.round(v * 255).toString(16).padStart(2, '0')).join('')}`;
}

// A colour for each model layer: layers with the same name share a colour;
// different layers of one main soil (several sands) get different shades of
// that soil's colour, so they can be told apart.
const SHADES = [0, -0.14, 0.09, -0.26, 0.16, -0.36, 0.05, -0.2];
export function layerFills(layers) {
    const byLabel = new Map();
    const perColour = new Map();
    return layers.map(l => {
        const key = `${l.colour}|${l.label}`;
        if (!byLabel.has(key)) {
            const n = perColour.get(l.colour) ?? 0;
            perColour.set(l.colour, n + 1);
            byLabel.set(key, shade(SECTION_COLOURS[l.colour].fill, SHADES[n % SHADES.length]));
        }
        return byLabel.get(key);
    });
}
