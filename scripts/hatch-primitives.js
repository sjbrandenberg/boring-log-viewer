// Drawing helpers shared by the procedural hatch artwork (uscs-art.js and
// lithology-art.js). Tiles are 104 x 93 units, drawn at 40/104 scale in a 40 px
// graphic column (so 1 px on the log is about 2.6 units). Everything tiles
// seamlessly: scattered elements that cross an edge are repeated on the opposite
// side, and line families are periodic in both directions.
export const W = 104;
export const H = 93;
export const SW = 1.8; // default stroke width (about 0.7 px on the log)

export function rng(seed) {
    let s = 0;
    for (const ch of seed) s = (s * 31 + ch.charCodeAt(0)) >>> 0;
    return () => {
        s = (s * 1664525 + 1013904223) >>> 0;
        return s / 4294967296;
    };
}

export const f = n => Math.round(n * 10) / 10;

// Draws an element at (x, y), and again shifted by the tile size wherever it could
// cross an edge; `r` is the element's reach from (x, y).
export function wrapped(x, y, r, draw) {
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

// Scatters up to n elements at least minGap apart (best effort), wrapping at edges.
export function scatter(rand, n, minGap, reach, draw) {
    const pts = [];
    for (let tries = 0; pts.length < n && tries < n * 80; tries++) {
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

// Places elements on a staggered grid (every other row shifted by half a cell).
// `reach` is the element's size from its centre; only elements that cross an
// edge are drawn again on the other side.
export function grid(cols, rows, draw, stagger = true, reach = 7) {
    const out = [];
    const cw = W / cols;
    const ch = H / rows;
    for (let r = 0; r < rows; r++) {
        for (let c = 0; c < cols; c++) {
            const x = (c + 0.5) * cw + (stagger && r % 2 ? cw / 2 : 0);
            const y = (r + 0.5) * ch;
            out.push(wrapped(x % W, y, reach, (cx, cy) => draw(cx, cy, r, c)));
        }
    }
    return out.join('');
}

export const line = (x1, y1, x2, y2, w = SW, color = 'black') => `<line x1="${f(x1)}" y1="${f(y1)}" x2="${f(x2)}" y2="${f(y2)}" stroke="${color}" stroke-width="${w}" stroke-linecap="round"/>`;
export const path = (d, w = SW, fill = 'none', color = 'black') => `<path d="${d}" fill="${fill}" stroke="${color}" stroke-width="${w}" stroke-linejoin="round" stroke-linecap="round"/>`;
export const dot = (x, y, r = 1.1) => `<circle cx="${f(x)}" cy="${f(y)}" r="${r}"/>`;
export const ring = (x, y, r, w = SW) => `<circle cx="${f(x)}" cy="${f(y)}" r="${f(r)}" fill="none" stroke="black" stroke-width="${w}"/>`;
export const ellipse = (x, y, rx, ry, w = SW, fill = 'none', rot = 0) => `<ellipse cx="${f(x)}" cy="${f(y)}" rx="${f(rx)}" ry="${f(ry)}" fill="${fill}" stroke="black" stroke-width="${w}"${rot ? ` transform="rotate(${f(rot)} ${f(x)} ${f(y)})"` : ''}/>`;

// Irregular shapes take their random outline when they're created, not when
// they're drawn, so the copies `wrapped` draws at opposite edges match exactly.

// An irregular rounded blob (pebble), filled or open.
export const blob = (rand, r, fill = 'none', w = SW) => {
    const n = 7;
    const offs = Array.from({ length: n }, (_, k) => {
        const a = (k / n) * 2 * Math.PI;
        const rr = r * (0.75 + rand() * 0.45);
        return [rr * Math.cos(a), rr * 0.8 * Math.sin(a)];
    });
    return (x, y) => {
        const pts = offs.map(([dx, dy]) => [x + dx, y + dy]);
        let d = `M${f((pts[0][0] + pts[1][0]) / 2)} ${f((pts[0][1] + pts[1][1]) / 2)}`;
        for (let k = 1; k <= n; k++) {
            const p = pts[k % n];
            const q = pts[(k + 1) % n];
            d += ` Q${f(p[0])} ${f(p[1])} ${f((p[0] + q[0]) / 2)} ${f((p[1] + q[1]) / 2)}`;
        }
        return path(`${d} Z`, w, fill);
    };
};

// Angular fragment (breccia, debris).
export const shard = (rand, s, w = SW, fill = 'none') => {
    const n = 4 + Math.floor(rand() * 3);
    const offs = Array.from({ length: n }, (_, k) => {
        const a = (k / n) * 2 * Math.PI + rand() * 0.7;
        const r = s * (0.55 + rand() * 0.55);
        return [r * Math.cos(a), r * Math.sin(a)];
    });
    return (x, y) => path(`M${offs.map(([dx, dy]) => `${f(x + dx)} ${f(y + dy)}`).join(' L')} Z`, w, fill);
};

// For scatter: builds each element's shape once (by index), however many times
// it is drawn.
export const perElement = factory => {
    const cache = [];
    return (x, y, i) => (cache[i] ??= factory(i))(x, y);
};

export const cross = (s, w = SW) => (x, y) => line(x - s, y, x + s, y, w) + line(x, y - s, x, y + s, w);
export const vee = (s, w = SW) => (x, y) => path(`M${f(x - s)} ${f(y - s * 0.8)} L${f(x)} ${f(y + s * 0.8)} L${f(x + s)} ${f(y - s * 0.8)}`, w);
export const triangle = (s, w = SW, fill = 'none') => (x, y, i = 0) => {
    const a = -Math.PI / 2 + ((i * 1.3) % 0.8) - 0.4;
    const pts = [0, 2.094, 4.189].map(k => [x + s * Math.cos(a + k), y + s * Math.sin(a + k)]);
    return path(`M${pts.map(p => `${f(p[0])} ${f(p[1])}`).join(' L')} Z`, w, fill);
};
export const dash = (len, w = SW, angle = 0) => (x, y) => {
    const dx = (len / 2) * Math.cos(angle);
    const dy = (len / 2) * Math.sin(angle);
    return line(x - dx, y - dy, x + dx, y + dy, w);
};

// Horizontal rows of dashes; alternate rows shift by half a period.
export function dashRows(rows, len, period, w = SW, yOffset = 0) {
    const out = [];
    for (let r = 0; r < rows; r++) {
        const y = yOffset + (r + 0.5) * (H / rows);
        const shift = r % 2 ? period / 2 : 0;
        for (let x = shift - period; x < W + period; x += period) out.push(line(x, y, x + len, y, w));
    }
    return out.join('');
}

// Rows of dots.
export function dotRows(rows, period, r = 0.9, yOffset = 0) {
    const out = [];
    for (let k = 0; k < rows; k++) {
        const y = yOffset + (k + 0.5) * (H / rows);
        const shift = k % 2 ? period / 2 : 0;
        for (let x = shift; x < W + period; x += period) out.push(dot(x % W, y, r));
    }
    return out.join('');
}

// Vertical lines, `n` per tile; `pair` > 0 draws each as two lines that far apart.
export function verticals(n, w = SW, pair = 0, offset = 0) {
    const out = [];
    for (let k = 0; k < n; k++) {
        const x = offset + (k + 0.5) * (W / n);
        for (const dx of pair ? [-pair / 2, pair / 2] : [0]) out.push(line(x + dx, -1, x + dx, H + 1, w));
    }
    return out.join('');
}

// A family of parallel straight lines that tiles, running across `across` tile
// widths for each tile height (larger = gentler slope), `n` lines per tile width.
// dir = 1 rises to the right, -1 falls to the right. `pair` > 0 doubles each line.
export function slantFamily(n, across = 1, w = SW, dir = 1, pair = 0) {
    const out = [];
    const span = across * W;
    const len = Math.hypot(span, H);
    const nx = (H / len) * (pair / 2);  // perpendicular offset for paired lines
    const ny = (span / len) * (pair / 2);
    for (let k = -Math.ceil(n * across) - n; k < 2 * n; k++) {
        const x0 = (k * W) / n;
        for (const s of pair ? [-1, 1] : [0]) {
            const ox = s * nx;
            const oy = s * ny * dir;
            // Run a tenth past each end: paired lines are offset from the tile's
            // edges and would otherwise stop short of them, leaving a seam.
            const ex = span * 0.1;
            const ey = H * 0.1;
            if (dir > 0) out.push(line(x0 + ox - ex, H + oy + ey, x0 + span + ox + ex, oy - ey, w));
            else out.push(line(x0 + ox - ex, oy - ey, x0 + span + ox + ex, H + oy + ey, w));
        }
    }
    return out.join('');
}

// Like slantFamily, but each line is wavy (`waves` full waves per tile height).
export function wavySlantFamily(n, across = 1, w = SW, dir = 1, pair = 0, amp = 3, waves = 2) {
    const out = [];
    const span = across * W;
    const len = Math.hypot(span, H);
    const ux = span / len;
    const uy = (-H * dir) / len;
    const px = -uy;          // unit normal
    const py = ux;
    const steps = waves * 8;
    for (let k = -Math.ceil(n * across) - n; k < 2 * n; k++) {
        const x0 = (k * W) / n;
        const y0 = dir > 0 ? H : 0;
        for (const s of pair ? [-pair / 2, pair / 2] : [0]) {
            let d = '';
            // From a tenth before the tile to a tenth past it (see slantFamily).
            for (let i = -Math.ceil(steps / 10); i <= steps + Math.ceil(steps / 10); i++) {
                const t = i / steps;
                const off = s + amp * Math.sin(t * waves * 2 * Math.PI);
                const x = x0 + ux * len * t + px * off;
                const y = y0 + uy * len * t + py * off;
                d += `${d ? ' L' : 'M'}${f(x)} ${f(y)}`;
            }
            out.push(path(d, w));
        }
    }
    return out.join('');
}

// Horizontal wavy lines: `count` per tile, `nWaves` full waves across the tile.
export function waves(count, amp, nWaves = 2, w = SW, color = 'black', yOffset = 0) {
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
export function bricks(courses, perRow, w = SW, slant = 0) {
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

export const hlines = (n, w = SW, color = 'black', offset = 0) => Array.from({ length: n }, (_, k) => line(-2, offset + (k + 0.5) * (H / n), W + 2, offset + (k + 0.5) * (H / n), w, color)).join('');

// Grass tuft (topsoil, peat): three blades on a short ground line.
export const tuft = (s, w = SW) => (x, y) => line(x - s, y, x + s, y, w) + line(x - s * 0.5, y, x - s * 0.8, y - s, w) + line(x, y, x, y - s * 1.2, w) + line(x + s * 0.5, y, x + s * 0.8, y - s, w);
