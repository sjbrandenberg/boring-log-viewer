// Site geometry shared by the 3D model, the site API and the page: borings'
// positions in metres, and which borings are neighbours. Pure functions.
import Delaunator from 'delaunator';

// Positions in metres east (x) and north (y) of the borings' mean position.
export function localPositions(sites) {
    const lat0 = sites.reduce((s, p) => s + p.lat, 0) / sites.length;
    const lon0 = sites.reduce((s, p) => s + p.lon, 0) / sites.length;
    const k = Math.cos((lat0 * Math.PI) / 180);
    return sites.map(p => ({ x: (p.lon - lon0) * 111320 * k, y: (p.lat - lat0) * 110540 }));
}

// Neighbouring borings, which are correlated with each other: the edges of a
// Delaunay triangulation, leaving out edges much longer than the others (across the
// outside of a curved site). Borings in a line are joined in order.
export function neighbourEdges(pos) {
    const n = pos.length;
    if (n < 2) return [];
    if (n === 2) return [[0, 1]];
    let edges = [];
    try {
        const d = Delaunator.from(pos, p => p.x, p => p.y);
        const seen = new Set();
        for (let t = 0; t < d.triangles.length; t += 3) {
            for (let e = 0; e < 3; e++) {
                const a = d.triangles[t + e];
                const b = d.triangles[t + ((e + 1) % 3)];
                const key = a < b ? `${a},${b}` : `${b},${a}`;
                if (!seen.has(key)) {
                    seen.add(key);
                    edges.push(a < b ? [a, b] : [b, a]);
                }
            }
        }
    } catch {
        edges = [];
    }
    if (!edges.length) {
        // Collinear: join in order along the line.
        const mx = pos.reduce((s, p) => s + p.x, 0) / n;
        const my = pos.reduce((s, p) => s + p.y, 0) / n;
        const far = pos.reduce((best, p) => (Math.hypot(p.x - mx, p.y - my) > Math.hypot(best.x - mx, best.y - my) ? p : best), pos[0]);
        const dir = { x: far.x - mx, y: far.y - my };
        const order = pos.map((p, i) => [i, (p.x - mx) * dir.x + (p.y - my) * dir.y]).sort((a, b) => a[1] - b[1]).map(([i]) => i);
        return order.slice(1).map((j, k) => [order[k], j]);
    }
    // Each boring keeps its edge to its nearest neighbour; other edges are left
    // out when they are more than 2.5 times the longer nearest-neighbour distance
    // of their two ends.
    const len = ([a, b]) => Math.hypot(pos[a].x - pos[b].x, pos[a].y - pos[b].y);
    const nearest = pos.map((_, i) => Math.min(...edges.filter(e => e.includes(i)).map(len)));
    return edges.filter(e => len(e) <= 2.5 * Math.max(nearest[e[0]], nearest[e[1]]) + 1e-6);
}
