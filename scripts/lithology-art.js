// Procedural artwork for the non-USCS hatches in src/lithology.js. Each tile is
// 104 x 93 units like the USCS tiles (drawn at 40/104 scale in a 40 px graphic
// column), black on white, and tiles seamlessly: anything that crosses an edge is
// repeated on the opposite side. Random elements use a fixed seed per code, so
// the output is the same on every build.
const W = 104;
const H = 93;
const SW = 2.5; // default stroke width, as in the USCS tiles

function rng(seed) {
    let s = 0;
    for (const ch of seed) s = (s * 31 + ch.charCodeAt(0)) >>> 0;
    return () => {
        s = (s * 1664525 + 1013904223) >>> 0;
        return s / 4294967296;
    };
}

const f = n => Math.round(n * 10) / 10;

// Draws an element at (x, y) and again shifted by the tile size wherever it could
// cross an edge; `r` is the element's reach from (x, y).
function wrapped(x, y, r, draw) {
    const out = [];
    for (const dx of [-W, 0, W]) {
        for (const dy of [-H, 0, H]) {
            const cx = x + dx;
            const cy = y + dy;
            if (cx + r < 0 || cx - r > W || cy + r < 0 || cy - r > H) continue;
            out.push(draw(cx, cy));
        }
    }
    return out.join('');
}

// Scatters n elements with a minimum spacing (best effort), wrapping at edges.
function scatter(rand, n, minGap, reach, draw) {
    const pts = [];
    for (let tries = 0; pts.length < n && tries < n * 60; tries++) {
        const p = [rand() * W, rand() * H];
        const ok = pts.every(q => {
            const dx = Math.min(Math.abs(p[0] - q[0]), W - Math.abs(p[0] - q[0]));
            const dy = Math.min(Math.abs(p[1] - q[1]), H - Math.abs(p[1] - q[1]));
            return dx * dx + dy * dy >= minGap * minGap;
        });
        if (ok) pts.push(p);
    }
    return pts.map(([x, y], i) => wrapped(x, y, reach, (cx, cy) => draw(cx, cy, i))).join('');
}

const line = (x1, y1, x2, y2, w = SW, color = 'black') => `<line x1="${f(x1)}" y1="${f(y1)}" x2="${f(x2)}" y2="${f(y2)}" stroke="${color}" stroke-width="${w}" stroke-linecap="round"/>`;
const path = (d, w = SW, fill = 'none', color = 'black') => `<path d="${d}" fill="${fill}" stroke="${color}" stroke-width="${w}" stroke-linejoin="round" stroke-linecap="round"/>`;
const dot = (x, y, r = 1.3) => `<circle cx="${f(x)}" cy="${f(y)}" r="${r}"/>`;
const ring = (x, y, r, w = SW) => `<circle cx="${f(x)}" cy="${f(y)}" r="${f(r)}" fill="none" stroke="black" stroke-width="${w}"/>`;

// ---- building blocks
const dots = (rand, n, r = 1.3, gap = 6) => scatter(rand, n, gap, r, (x, y) => dot(x, y, r));
const cross = s => (x, y) => line(x - s, y, x + s, y) + line(x, y - s, x, y + s);
const vee = s => (x, y) => path(`M${f(x - s)} ${f(y - s * 0.8)} L${f(x)} ${f(y + s * 0.8)} L${f(x + s)} ${f(y - s * 0.8)}`);
const triangle = (s, fill = 'none') => (x, y, i) => {
    const a = (i * 1.7) % (2 * Math.PI);
    const pts = [0, 2.1, 4.2].map(k => [x + s * Math.cos(a + k), y + s * Math.sin(a + k)]);
    return path(`M${pts.map(p => `${f(p[0])} ${f(p[1])}`).join(' L')} Z`, SW * 0.8, fill);
};
const dash = (len, w = SW) => (x, y) => line(x - len / 2, y, x + len / 2, y, w);
const crosses = (rand, n, s = 5, gap = 16) => scatter(rand, n, gap, s, cross(s));
const vees = (rand, n, s = 5, gap = 16) => scatter(rand, n, gap, s, vee(s));
const triangles = (rand, n, s = 5, gap = 16, fill = 'none') => scatter(rand, n, gap, s, triangle(s, fill));
const rings = (rand, n, rmin, rmax, gap) => scatter(rand, n, gap, rmax, (x, y) => ring(x, y, rmin + rand() * (rmax - rmin)));

// Rows of dashes; rows alternate their offset by half a period.
function dashRows(rows, len, period, w = SW, jitter = 0, rand = null) {
    const out = [];
    for (let r = 0; r < rows; r++) {
        const y = (r + 0.5) * (H / rows);
        const shift = r % 2 ? period / 2 : 0;
        for (let x = shift - period; x < W + period; x += period) {
            const j = jitter && rand ? (rand() - 0.5) * jitter : 0;
            out.push(line(x + j, y, x + j + len, y, w));
        }
    }
    return out.join('');
}

// Horizontal wavy lines: `count` per tile, `waves` full waves across the tile.
function waves(count, amp, nWaves = 2, w = SW, color = 'black', yOffset = 0) {
    const out = [];
    const wl = W / nWaves;
    for (let k = 0; k < count; k++) {
        const y = yOffset + (k + 0.5) * (H / count);
        let d = `M${-wl} ${f(y)}`;
        for (let x = -wl; x < W + wl; x += wl) d += ` q${f(wl / 4)} ${-amp} ${f(wl / 2)} 0 t${f(wl / 2)} 0`;
        out.push(path(d, w, 'none', color));
    }
    return out.join('');
}

// Brick courses: `courses` rows per tile, `perRow` bricks per row, running bond.
function bricks(courses, perRow, w = SW, slant = 0) {
    const out = [];
    const ch = H / courses;
    const bw = W / perRow;
    for (let c = 0; c <= courses; c++) out.push(line(-2, c * ch, W + 2, c * ch, w));
    for (let c = 0; c < courses; c++) {
        const shift = c % 2 ? bw / 2 : 0;
        for (let k = -1; k <= perRow; k++) {
            const x = k * bw + shift;
            out.push(line(x + slant, c * ch, x, (c + 1) * ch, w));
        }
    }
    return out.join('');
}

// Parallel slanted lines that tile: `n` lines per tile width.
function slants(n, w = SW, wavy = 0) {
    const out = [];
    for (let k = -n; k < 2 * n; k++) {
        const x0 = (k * W) / n;
        if (!wavy) out.push(line(x0, H, x0 + W, 0, w));
        else out.push(path(`M${f(x0)} ${H} Q${f(x0 + W / 4 + wavy)} ${f(H * 0.75)} ${f(x0 + W / 2)} ${f(H / 2)} T${f(x0 + W)} 0`, w));
    }
    return out.join('');
}

const hlines = (n, w = SW, color = 'black', offset = 0) => Array.from({ length: n }, (_, k) => line(-2, offset + (k + 0.5) * (H / n), W + 2, offset + (k + 0.5) * (H / n), w, color)).join('');

// "?" drawn as a path, for undocumented fill.
const question = s => (x, y) => path(`M${f(x - s * 0.5)} ${f(y - s * 0.5)} Q${f(x - s * 0.5)} ${f(y - s * 1.1)} ${f(x)} ${f(y - s * 1.1)} Q${f(x + s * 0.6)} ${f(y - s * 1.1)} ${f(x + s * 0.5)} ${f(y - s * 0.5)} Q${f(x + s * 0.4)} ${f(y - s * 0.1)} ${f(x)} ${f(y + s * 0.2)} L${f(x)} ${f(y + s * 0.5)}`, SW * 0.9) + dot(x, y + s * 0.95, 1.6);

// Grass tuft for topsoil.
const tuft = s => (x, y) => line(x - s, y, x + s, y) + line(x - s * 0.5, y, x - s * 0.8, y - s) + line(x, y, x, y - s * 1.3) + line(x + s * 0.5, y, x + s * 0.8, y - s);

// Shell: a small cup (half circle) with a flat top.
const shell = s => (x, y, i) => {
    const flip = i % 2 ? -1 : 1;
    return path(`M${f(x - s)} ${f(y)} A${s} ${s} 0 0 ${flip > 0 ? 0 : 1} ${f(x + s)} ${f(y)} Z`, SW * 0.8);
};

// Irregular angular fragment (debris, fault breccia).
const fragment = (rand, s) => (x, y) => {
    const n = 4 + Math.floor(rand() * 2);
    const pts = Array.from({ length: n }, (_, k) => {
        const a = (k / n) * 2 * Math.PI + rand() * 0.6;
        const r = s * (0.6 + rand() * 0.5);
        return `${f(x + r * Math.cos(a))} ${f(y + r * Math.sin(a))}`;
    });
    return path(`M${pts.join(' L')} Z`, SW * 0.8);
};

// Wood grain: gently wavy lines with a knot.
const woodgrain = () => waves(4, 3, 1, SW * 0.9) + `<ellipse cx="60" cy="46.5" rx="9" ry="4" fill="none" stroke="black" stroke-width="${SW * 0.9}"/>`;

// ---- the tiles (keys must match src/lithology.js)
export function lithologyArt() {
    const R = code => rng(code);
    const t = {
        // Fill and man-made
        FILL: r => dots(r, 10, 1.4, 12) + triangles(r, 5, 4, 22) + scatter(r, 5, 20, 5, dash(9)),
        FILL_HYD: r => dots(r, 6, 1.4, 14) + triangles(r, 3, 4, 26) + waves(2, 5, 2),
        FILL_ENG: r => dots(r, 6, 1.4, 14) + triangles(r, 3, 4, 26) + hlines(3, SW * 0.8),
        FILL_UNDOC: r => dots(r, 6, 1.4, 14) + triangles(r, 3, 4, 26) + scatter(r, 2, 40, 9, question(9)),
        DEBRIS: r => scatter(r, 9, 22, 10, fragment(r, 8)),
        ASPHALT: () => ({ background: '#3c3c3c', body: '' }),
        CONCRETE: r => ({ background: '#d9d9d9', body: triangles(r, 7, 4.5, 20) + dots(r, 10, 1.3, 9) }),
        BASE_COURSE: () => {
            const out = [];
            for (let row = 0; row < 6; row++) for (let k = -1; k <= 6; k++) out.push(ring((k + 0.5) * (W / 6) + (row % 2 ? W / 12 : 0), (row + 0.5) * (H / 6), 4.5, SW * 0.8));
            return out.join('');
        },
        // Natural materials
        TOPSOIL: r => scatter(r, 6, 28, 11, tuft(9)) + dots(r, 8, 1.2, 10),
        SHELL: r => scatter(r, 9, 22, 8, shell(6)),
        COBBLES: r => scatter(r, 4, 40, 17, (x, y, i) => `<ellipse cx="${f(x)}" cy="${f(y)}" rx="${14 + (i % 2) * 3}" ry="${10 + (i % 3)}" fill="none" stroke="black" stroke-width="${SW}"/>`),
        WOOD: () => woodgrain(),
        ASH: r => vees(r, 9, 4, 20) + dots(r, 10, 1.3, 10),
        CEMENTED: r => dots(r, 12, 1.3, 9) + dashRows(3, 16, 52, SW * 1.8),
        LOESS: () => {
            const out = [];
            for (let row = 0; row < 6; row++) for (let k = 0; k < 8; k++) {
                const x = k * 13 + (row % 2 ? 6.5 : 0);
                const y = row * (H / 6) + 3;
                out.push(line(x, y, x, y + 8, SW * 0.8));
            }
            return out.join('');
        },
        MARL: () => bricks(3, 2) + dashRows(3, 10, 26, SW * 0.8),
        DIATOMITE: r => dots(r, 18, 1, 7) + rings(r, 5, 3, 3.5, 20),
        BENTONITE: r => dashRows(6, 14, 26) + dots(r, 10, 1.2, 9),
        QUICK_CLAY: () => slants(5, SW * 0.9) + waves(2, 6, 2, SW * 1.3),
        // Non-material intervals
        WATER: () => waves(4, 4, 2, SW, '#2f6fbf'),
        NO_RECOVERY: () => line(4, 4, W - 4, H - 4, SW * 0.8) + line(W - 4, 4, 4, H - 4, SW * 0.8),
        VOID: () => ({ background: '#eeeeee', body: '' }),
        // Rock categories and transitional
        ROCK: () => {
            // Large blocks, each with one slanted line: generic rock, distinct from limestone's bricks.
            const out = [bricks(2, 2, SW * 1.2)];
            for (let c = 0; c < 2; c++) {
                const shift = c % 2 ? 26 : 0;
                for (let k = -1; k < 2; k++) out.push(line(shift + k * 52 + 14, c * 46.5 + 38, shift + k * 52 + 38, c * 46.5 + 9, SW * 0.9));
            }
            return out.join('');
        },
        ROCK_SED: () => bricks(4, 1, SW),
        ROCK_IGN: r => crosses(r, 5, 5, 26) + vees(r, 5, 5, 26),
        ROCK_MET: () => waves(4, 5, 2),
        WEATHERED: r => {
            const out = [];
            // Bricks with gaps (broken joints), plus dots.
            for (let c = 0; c < 3; c++) {
                const y = c * 31;
                out.push(line(-2, y, 30, y), line(44, y, 84, y));
                const shift = c % 2 ? 26 : 0;
                for (const x of [shift, shift + 52]) out.push(line(x, y + 4, x, y + 20));
            }
            return out.join('') + dots(r, 12, 1.3, 9);
        },
        IGM: () => bricks(3, 2, SW * 0.7).replace(/stroke="black"/g, 'stroke="#777"'),
        // Sedimentary, clastic
        SANDSTONE: r => dots(r, 30, 1.3, 6) + hlines(2, SW * 0.8),
        SHALE: () => dashRows(6, 11, 22),
        SILTSTONE: r => dashRows(4, 10, 26) + dots(r, 14, 1.2, 8),
        MUDSTONE: r => scatter(r, 12, 14, 7, dash(10)),
        CLAYSTONE: () => dashRows(5, 30, 52),
        CONGLOMERATE: r => rings(r, 5, 6, 9, 28) + dots(r, 14, 1.2, 8),
        BRECCIA: r => triangles(r, 6, 8, 26) + dots(r, 14, 1.2, 8),
        // Sedimentary, chemical and organic
        LIMESTONE: () => bricks(3, 2),
        DOLOMITE: () => bricks(3, 2, SW, 8),
        CHALK: () => bricks(2, 2, SW * 0.7),
        CHERT: r => triangles(r, 10, 4, 18),
        COAL: () => ({ background: '#000000', body: '' }),
        EVAPORITE: () => bricks(3, 2) + (() => {
            // Diagonal hatching in alternate bricks
            const out = [];
            for (let c = 0; c < 3; c++) {
                const x0 = c % 2 ? 26 : 0;
                for (let k = 0; k < 4; k++) out.push(line(x0 + 6 + k * 10, c * 31 + 27, x0 + 16 + k * 10, c * 31 + 4, SW * 0.6));
            }
            return out.join('');
        })(),
        // Igneous
        GRANITE: r => crosses(r, 9, 5, 20),
        GRANODIORITE: r => crosses(r, 7, 5, 22) + dots(r, 10, 1.3, 9),
        DIORITE: r => crosses(r, 7, 5, 22) + scatter(r, 6, 18, 5, dash(8)),
        GABBRO: r => crosses(r, 16, 4.5, 14),
        PERIDOTITE: r => crosses(r, 7, 5, 22) + rings(r, 6, 3, 3.5, 16),
        BASALT: r => vees(r, 10, 5, 18),
        ANDESITE: r => vees(r, 8, 5, 20) + dots(r, 10, 1.3, 9),
        DACITE: r => vees(r, 8, 5, 20) + scatter(r, 6, 18, 5, dash(8)),
        RHYOLITE: r => vees(r, 7, 5, 22) + waves(3, 3, 2, SW * 0.7),
        TUFF: r => vees(r, 8, 4, 20) + dots(r, 10, 1.2, 9) + hlines(2, SW * 0.7),
        VOLC_BRECCIA: r => triangles(r, 5, 8, 28) + vees(r, 5, 4, 22),
        SCORIA: r => rings(r, 6, 4, 6, 22) + vees(r, 5, 4, 22),
        // Metamorphic
        SLATE: () => slants(8, SW * 0.8),
        PHYLLITE: () => slants(6, SW * 0.9, 6),
        SCHIST: () => waves(6, 6, 3),
        GNEISS: r => waves(3, 6, 2, SW * 1.4) + dots(r, 12, 1.4, 9),
        QUARTZITE: r => bricks(3, 2, SW * 0.9) + dots(r, 16, 1.3, 7),
        MARBLE: () => bricks(3, 2, SW * 0.9) + waves(3, 4, 2, SW * 0.7, 'black', 15.5),
        HORNFELS: () => {
            const out = [];
            const courses = [0, 24, 55, 93];
            for (const y of courses) out.push(line(-2, y, W + 2, y));
            const joints = [[10, 58, 90], [30, 75], [18, 46, 84]];
            joints.forEach((xs, c) => xs.forEach(x => out.push(line(x, courses[c], x + 4, courses[c + 1]))));
            return out.join('');
        },
        SERPENTINITE: r => waves(3, 6, 2) + crosses(r, 5, 4, 24),
        GREENSTONE: r => bricks(3, 2, SW * 0.9) + vees(r, 6, 4, 22),
        // Fault rocks
        FAULT_GOUGE: r => scatter(r, 22, 10, 6, (x, y) => line(x - 4, y + 3, x + 4, y - 3, SW * 0.9)),
        FAULT_BRECCIA: r => scatter(r, 7, 24, 9, fragment(r, 7)) + slants(3, SW * 0.6),
        MYLONITE: () => hlines(9, SW * 0.6),
    };
    const out = {};
    for (const [code, draw] of Object.entries(t)) {
        const drawn = draw(R(code));
        out[code] = typeof drawn === 'string' ? { width: W, height: H, body: drawn } : { width: W, height: H, ...drawn };
    }
    return out;
}
