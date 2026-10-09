// Several borings of one site: suggested cross-sections and the data for the
// site page and the site API. Pure functions.
import { localPositions, neighbourEdges } from './geometry.js';
import { placeAlongLine, lineLength, prepareBoring } from './section.js';
import { buildModel } from './model3d.js';
import { normalizeBoringLog } from './normalize.js';

const round = (n, d = 6) => Math.round(n * 10 ** d) / 10 ** d;

// Each boring's name and location from its document; location null when it
// has no usable latitude and longitude.
export function siteBorings(docs) {
    return docs.map((doc, index) => {
        const m = doc?.metadata ?? {};
        const ok = typeof m.latitude === 'number' && typeof m.longitude === 'number' && Math.abs(m.latitude) <= 90 && Math.abs(m.longitude) <= 180 && !(m.latitude === 0 && m.longitude === 0);
        return { index, name: m.boring_name ?? `Boring ${index + 1}`, lat: ok ? m.latitude : null, lon: ok ? m.longitude : null, doc };
    });
}

// Suggested sections for a site, from the borings' layout (at least two with
// locations). Each: { id, name, kind, description, line: [{ lat, lon }, ...],
// corridor (m), length (m), borings: [{ name, index, chainage, offset, side }] }.
//
//   A   along the site's long axis (the direction the borings spread most,
//       by principal components), through their centre, with a corridor wide
//       enough for the borings near that axis (15 % of its length, 25 m at least)
//   B   across it, at right angles near the centre (through the boring nearest
//       the centre along the long axis), when the site is wide enough (at least
//       20 % of its length across) and two or more borings lie within its
//       corridor
//   C   a line through every boring in turn, ordered along the long axis, when
//       A or B leave some out or project some from more than 10 m away; it
//       shows every boring with nothing projected
//   D…  for a long site with more than six borings, cross-lines at the
//       quarter points of the long axis, where they catch two or more borings
// A section that would show the same borings as an earlier one is left out.
export function autoSections(borings) {
    const located = borings.filter(b => b.lat !== null && b.lon !== null);
    if (located.length < 2) return [];
    const pos = localPositions(located);
    const n = pos.length;
    const cx = pos.reduce((s, p) => s + p.x, 0) / n;
    const cy = pos.reduce((s, p) => s + p.y, 0) / n;
    // Principal axis of the positions.
    let sxx = 0;
    let syy = 0;
    let sxy = 0;
    for (const p of pos) {
        sxx += (p.x - cx) ** 2;
        syy += (p.y - cy) ** 2;
        sxy += (p.x - cx) * (p.y - cy);
    }
    const angle = 0.5 * Math.atan2(2 * sxy, sxx - syy);
    const u = { x: Math.cos(angle), y: Math.sin(angle) };   // long axis
    const v = { x: -u.y, y: u.x };                           // across
    const along = pos.map(p => (p.x - cx) * u.x + (p.y - cy) * u.y);
    const across = pos.map(p => (p.x - cx) * v.x + (p.y - cy) * v.y);
    const lengthA = Math.max(...along) - Math.min(...along);
    const widthB = Math.max(...across) - Math.min(...across);

    // Back from local metres to latitude and longitude.
    const lat0 = located.reduce((s, b) => s + b.lat, 0) / n;
    const lon0 = located.reduce((s, b) => s + b.lon, 0) / n;
    const k = Math.cos((lat0 * Math.PI) / 180);
    const toLatLon = (x, y) => ({ lat: round(lat0 + y / 110540), lon: round(lon0 + x / (111320 * k)) });
    const lineAlong = (dir, center, from, to) => [toLatLon(center.x + dir.x * from, center.y + dir.y * from), toLatLon(center.x + dir.x * to, center.y + dir.y * to)];

    const sections = [];
    const seen = new Set();
    const ids = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
    const add = (kind, name, description, line, corridor, always = false) => {
        const placed = placeAlongLine(located, line, corridor);
        if (placed.length < 2) return;
        const key = placed.map(p => p.index).sort((a, b) => a - b).join(',');
        if (seen.has(key) && !always) return;
        seen.add(key);
        const id = ids[sections.length] ?? String(sections.length + 1);
        sections.push({
            id,
            name: `${name} (${id}–${id}′)`,
            kind,
            description,
            line,
            corridor: round(corridor, 1),
            length: round(lineLength(line), 1),
            borings: placed.map(p => ({ name: p.name, index: p.index, chainage: round(p.chainage, 1), offset: round(p.offset, 1), side: p.side })),
        });
    };

    const ext = Math.max(10, lengthA * 0.05);
    const corridorA = Math.max(25, 0.15 * lengthA);
    add('long', 'Along the site', `Along the direction the borings spread most, through their centre; borings within ${Math.round(corridorA)} m.`,
        lineAlong(u, { x: cx, y: cy }, Math.min(...along) - ext, Math.max(...along) + ext), corridorA);

    // Cross-lines pass through the boring nearest the point wanted along the
    // long axis, so they catch the row of borings there.
    const snap = target => along.reduce((best, a) => (Math.abs(a - target) < Math.abs(best - target) ? a : best), along[0]);
    if (widthB >= 0.2 * lengthA) {
        const extB = Math.max(10, widthB * 0.05);
        const corridorB = Math.max(25, 0.15 * widthB, 0.1 * lengthA);
        const a0 = snap(0);
        add('across', 'Across the site', `At right angles to A–A′ near the centre; borings within ${Math.round(corridorB)} m.`,
            lineAlong(v, { x: cx + u.x * a0, y: cy + u.y * a0 }, Math.min(...across) - extB, Math.max(...across) + extB), corridorB);
    }

    // Through every boring, when the straight sections leave some out or project
    // some from more than 10 m away.
    const leftOut = sections.reduce((m, s) => Math.max(m, s.borings.length), 0) < n;
    const projected = sections.some(s => s.borings.some(b => b.offset > 10));
    if (n >= 3 && (leftOut || projected)) {
        // Through every boring in order along the long axis, each one a bend.
        const order = along.map((a, i) => [i, a]).sort((p, q) => p[1] - q[1]).map(([i]) => i);
        add('all', 'Through every boring', 'A line from boring to boring in order along the site, so every boring is on it.',
            order.map(i => ({ lat: located[i].lat, lon: located[i].lon })), 5, true);
    }

    if (n > 6 && lengthA >= 2 * widthB) {
        const corridorX = Math.max(25, 0.08 * lengthA);
        for (const f of [0.25, 0.75]) {
            const a0 = snap(Math.min(...along) + f * lengthA);
            const center = { x: cx + u.x * a0, y: cy + u.y * a0 };
            const half = Math.max(widthB, 0.2 * lengthA) / 2 + 10;
            add('cross', `Across at ${Math.round(f * 100)} % along`, `At right angles to A–A′, ${Math.round(f * 100)} % of the way along it; borings within ${Math.round(corridorX)} m.`,
                lineAlong(v, center, -half, half), corridorX);
        }
    }
    return sections;
}

// A short summary of a site for the API: each boring's name, location and
// depth, and the suggested sections.
export function siteSummary(docs) {
    const borings = siteBorings(docs);
    return {
        borings: borings.map(b => {
            let depth = null;
            let units = null;
            try {
                const d = normalizeBoringLog(b.doc);
                depth = Math.max(0, ...d.layers.map(l => l.bottom));
                units = d.units.length;
            } catch {
                // reported by validation
            }
            return { index: b.index, name: b.name, latitude: b.lat, longitude: b.lon, depth, units };
        }),
        sections: autoSections(borings),
    };
}

// The 3D model of a site as data, for the API: the correlated layers (from the
// top, each with its label, USCS symbols, colour and the borings it is found
// in), each boring with its local position (m east and north of the site's
// centre) and its units' layers, and the model box. With grid, also the
// surfaces on a grid: ground and the top of each layer and the base, as
// levels (elevations, or minus depths when not every boring has an
// elevation), in metres. Null with fewer than two located borings.
export function siteModel(borings, { grid = 0 } = {}) {
    const located = borings.filter(b => b.lat !== null && b.lon !== null);
    if (located.length < 2) return null;
    const prepared = located.map(b => ({ ...prepareBoring(b.doc), name: b.name }));
    const pos = localPositions(located);
    const n = grid || 2;
    const model = buildModel(prepared, pos, neighbourEdges(pos), { nx: n, ny: n });
    const r = v => (v === null ? null : round(v, 2));
    const found = model.layers.map(() => new Set());
    const out = {
        levels: model.byDepth ? 'depth' : 'elevation',
        box: { west: r(model.box.x0), east: r(model.box.x1), south: r(model.box.y0), north: r(model.box.y1) },
        borings: located.map((b, i) => ({
            index: b.index,
            name: b.name,
            x: r(pos[i].x),
            y: r(pos[i].y),
            ground: r(model.ground[i]),
            depth: r(prepared[i].depth),
            groundwater: prepared[i].groundwater.length ? r(prepared[i].groundwater[0]) : null,
            units: prepared[i].units.map(u => {
                const layer = model.unitLayer.get(u);
                found[layer].add(b.name);
                return { top: r(u.top), bottom: r(u.bottom), layer };
            }),
        })),
    };
    out.layers = model.layers.map((l, k) => ({
        id: k, label: l.label, uscs: l.codes, guessed: [...(l.guessed ?? [])], colour: l.fill, soil: l.colour, borings: [...found[k]],
    }));
    if (grid) {
        out.grid = {
            nx: model.nx,
            ny: model.ny,
            x: Array.from({ length: model.nx + 1 }, (_, i) => r(model.nodes[i].x)),
            y: Array.from({ length: model.ny + 1 }, (_, j) => r(model.nodes[j * (model.nx + 1)].y)),
            // Row by row from the south, west to east.
            ground: model.nodes.map(nd => r(nd.ground)),
            tops: model.layers.map((_, k) => model.nodes.map(nd => r(nd.tops[k]))),
            base: model.nodes.map(nd => r(nd.base)),
            water: model.water ? model.water.map(r) : null,
        };
    }
    return out;
}
