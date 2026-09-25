// Procedural artwork for the non-USCS hatches in src/lithology.js. Where the
// USGS/FGDC Digital Cartographic Standard for Geologic Map Symbolization
// (FGDC-STD-013-2006, section 37) has an equivalent lithologic pattern, the tile
// follows it (the FGDC pattern number is noted); the rest keep simple
// boring-log conventions at the same fine density. See hatch-primitives.js for
// the tile size and the seamless-tiling helpers.
import {
    W, H, SW, rng, f, scatter, grid, line, path, dot, ring, ellipse, blob, shard, perElement, cross, vee, triangle, dash,
    dashRows, dotRows, slantFamily, wavySlantFamily, waves, bricks, hlines, tuft,
} from './hatch-primitives.js';

const T = SW * 0.8; // thin line for FGDC-style fine patterns

const dots = (r, n, rad = 1, gap = 6) => scatter(r, n, gap, rad, (x, y) => dot(x, y, rad));
const randomDashes = (r, n, len, gap) => scatter(r, n, gap, len, perElement(() => dash(len, T, r() * Math.PI)));

export function lithologyArt() {
    const R = code => rng(code);
    const t = {
        // ---- Fill and man-made (no FGDC equivalents)
        FILL: r => dots(r, 12, 1.1, 11) + scatter(r, 6, 20, 4, (x, y, i) => triangle(3.2, T)(x, y, i)) + scatter(r, 6, 18, 5, dash(7, T)),
        FILL_HYD: r => dots(r, 8, 1.1, 13) + scatter(r, 4, 24, 4, (x, y, i) => triangle(3.2, T)(x, y, i)) + waves(3, 3.5, 2, T),
        FILL_ENG: r => dots(r, 8, 1.1, 13) + scatter(r, 4, 24, 4, (x, y, i) => triangle(3.2, T)(x, y, i)) + hlines(4, T),
        FILL_UNDOC: r => dots(r, 8, 1.1, 13) + scatter(r, 4, 24, 4, (x, y, i) => triangle(3.2, T)(x, y, i))
            + scatter(r, 3, 34, 8, (x, y) => path(`M${f(x - 3)} ${f(y - 3)} Q${f(x - 3)} ${f(y - 7)} ${f(x)} ${f(y - 7)} Q${f(x + 3.5)} ${f(y - 7)} ${f(x + 3)} ${f(y - 3)} Q${f(x + 2.5)} ${f(y - 0.5)} ${f(x)} ${f(y + 1)} L${f(x)} ${f(y + 3)}`, T) + dot(x, y + 5.5, 1.1)),
        DEBRIS: r => scatter(r, 12, 20, 8, perElement(() => shard(r, 6, T))),
        ASPHALT: () => ({ background: '#3c3c3c', body: '' }),
        CONCRETE: r => ({ background: '#d9d9d9', body: scatter(r, 9, 18, 4, (x, y, i) => triangle(3.2, T)(x, y, i)) + dots(r, 14, 1, 8) }),
        BASE_COURSE: () => grid(8, 7, (x, y) => ring(x, y, 3.2, T)),
        // ---- Natural materials
        TOPSOIL: r => scatter(r, 8, 24, 8, tuft(6, T)) + dots(r, 10, 1, 9),
        SHELL: r => scatter(r, 12, 18, 6, (x, y, i) => path(`M${f(x - 4.5)} ${f(y)} A4.5 4.5 0 0 ${i % 2} ${f(x + 4.5)} ${f(y)} Z`, T)),
        COBBLES: r => scatter(r, 6, 34, 16, perElement(i => blob(r, 11 + (i % 2) * 3, 'none', SW))) + dots(r, 10, 1, 9),
        WOOD: () => waves(5, 2.5, 1, T) + ellipse(60, 46.5, 7, 3, T),
        ASH: r => scatter(r, 12, 17, 3, vee(3, T)) + dots(r, 14, 1, 8),
        CEMENTED: r => dots(r, 16, 1, 8) + dashRows(4, 12, 34, SW * 1.4),
        LOESS: () => grid(9, 7, (x, y) => path(`M${f(x)} ${f(y - 5)} q1.2 2.5 0 5 t0 5`, T)),                    // FGDC 684
        MARL: () => dashRows(6, 11, 21, T) + grid(5, 6, (x, y) => line(x, y - 3, x, y + 3, T)),                      // FGDC 623
        DIATOMITE: r => scatter(r, 9, 22, 6, (x, y) => line(x - 5, y - 1.5, x + 5, y - 1.5, T) + line(x - 5, y + 1.5, x + 5, y + 1.5, T) + ellipse(x, y, 2, 1.5, T)), // FGDC 653
        BENTONITE: r => hlines(2, T) + hlines(2, T, 'black', 3) + scatter(r, 9, 20, 6, (x, y) => line(x - 5, y, x + 3, y, T) + line(x + 3, y, x + 5.5, y - 2.5, T) + line(x + 3, y, x + 5.5, y + 2.5, T)), // FGDC 662
        QUICK_CLAY: () => slantFamily(3, 2, T, 1) + waves(2, 4, 2, SW),
        // ---- Non-material intervals
        WATER: () => waves(5, 3, 2, T, '#2f6fbf'),
        NO_RECOVERY: () => line(4, 4, W - 4, H - 4, T) + line(W - 4, 4, 4, H - 4, T),
        VOID: () => ({ background: '#eeeeee', body: '' }),
        // ---- Rock categories and transitional
        ROCK: () => bricks(3, 2, SW) + grid(2, 3, (x, y) => line(x - 10, y + 8, x + 10, y - 8, T)),
        ROCK_SED: () => bricks(6, 2, T),
        ROCK_IGN: () => grid(6, 6, cross(2.6, T)),                                                                     // FGDC 721
        ROCK_MET: r => randomDashes(r, 30, 6, 11),                                                                      // FGDC 701
        WEATHERED: r => {
            const out = [];
            for (let c = 0; c < 4; c++) {
                const y = c * (H / 4);
                out.push(line(-2, y, 20, y, T), line(32, y, 72, y, T), line(84, y, W + 2, y, T));
                const shift = c % 2 ? 26 : 0;
                for (const x of [shift + 13, shift + 65]) out.push(line(x, y + 4, x, y + 16, T));
            }
            return out.join('') + dots(r, 16, 1, 8);
        },
        IGM: () => bricks(4, 2, T).replace(/stroke="black"/g, 'stroke="#777"'),
        // ---- Sedimentary, clastic
        SANDSTONE: r => dots(r, 70, 0.9, 5),                                                                              // FGDC 607
        SHALE: () => dashRows(9, 8, 14, T),                                                                               // FGDC 620
        SILTSTONE: () => dashRows(5, 9, 18, T) + dotRows(5, 7, 0.8, H / 10),                                              // FGDC 616
        MUDSTONE: () => dashRows(5, 10, 20, T) + dotRows(5, 10, 0.8, H / 10),                                             // FGDC 619 (closest)
        CLAYSTONE: () => dashRows(9, 8, 14, T),                                                                           // FGDC 620
        CONGLOMERATE: r => scatter(r, 16, 15, 4, perElement(i => blob(r, 2 + (i % 3) * 0.9, 'none', T))) + dots(r, 30, 0.8, 6), // FGDC 601
        BRECCIA: r => scatter(r, 14, 17, 5, perElement(() => shard(r, 4, T))) + dots(r, 16, 0.8, 8),                      // FGDC 605
        // ---- Sedimentary, chemical and organic
        LIMESTONE: () => bricks(6, 4, T),                                                                                  // FGDC 627
        DOLOMITE: () => bricks(6, 4, T, 6),                                                                                // FGDC 642
        CHALK: () => dashRows(8, 14, 26, T) + grid(4, 8, (x, y) => line(x, y - 2.5, x, y + 2.5, T)),                      // FGDC 626
        CHERT: () => {                                                                                                     // FGDC 649
            const out = [];
            for (let row = 0; row < 7; row++) for (let k = -1; k <= 4; k++) {
                const x = (k + 0.5) * 26 + (row % 2 ? 13 : 0);
                out.push(ellipse(x, (row + 0.5) * (H / 7), 13, H / 14, T));
            }
            return out.join('');
        },
        COAL: () => ({ background: '#000000', body: '' }),                                                                 // FGDC 658
        EVAPORITE: () => slantFamily(12, 1, T * 0.9, -1),                                                                   // FGDC 667 (gypsum)
        // ---- Igneous
        GRANITE: r => randomDashes(r, 40, 5, 9),                                                                            // FGDC 718
        GRANODIORITE: r => randomDashes(r, 26, 5, 11) + dots(r, 14, 0.9, 8),
        DIORITE: r => randomDashes(r, 22, 5, 12) + scatter(r, 10, 14, 3, cross(2.4, T)),
        GABBRO: r => scatter(r, 30, 10, 3, cross(2.4, T)),
        PERIDOTITE: r => scatter(r, 16, 13, 3, cross(2.4, T)) + scatter(r, 10, 14, 2.5, (x, y) => ring(x, y, 2, T)),
        BASALT: r => {                                                                                                     // FGDC 717
            const out = [waves(3, 1.5, 2, T)];
            for (let band = 0; band < 3; band++) {
                const y0 = band * 31 + 3;
                for (let x = 1; x < W; x += 2.6) out.push(line(x, y0 + 2 + r() * 2, x, y0 + 24 - r() * 3, T * 0.75));
            }
            return out.join('');
        },
        ANDESITE: r => scatter(r, 16, 14, 3, vee(2.6, T)) + dots(r, 16, 0.9, 8),
        DACITE: r => scatter(r, 16, 14, 3, vee(2.6, T)) + scatter(r, 10, 14, 3, dash(5, T)),
        RHYOLITE: r => scatter(r, 14, 15, 3, vee(2.6, T)) + waves(4, 2, 2, T * 0.8),
        TUFF: () => grid(8, 6, (x, y, row) => (row % 2                                                                    // FGDC 711
            ? path(`M${f(x - 2.5)} ${f(y - 3)} L${f(x)} ${f(y)} L${f(x + 2.5)} ${f(y - 3)} M${f(x)} ${f(y)} L${f(x)} ${f(y + 3)}`, T)
            : path(`M${f(x - 2.5)} ${f(y + 3)} L${f(x)} ${f(y - 3)} L${f(x + 2.5)} ${f(y + 3)}`, T)), false),
        VOLC_BRECCIA: r => scatter(r, 10, 20, 6, perElement(() => shard(r, 5, T))) + scatter(r, 5, 26, 6, perElement(() => shard(r, 4, T, '#999'))) + dots(r, 18, 0.8, 7), // FGDC 715
        SCORIA: r => scatter(r, 12, 16, 3.5, (x, y) => ring(x, y, 2.5, T)) + scatter(r, 12, 14, 3, vee(2.4, T)),
        // ---- Metamorphic
        SLATE: () => slantFamily(10, 1, T * 0.8, -1) + slantFamily(2, 1, T * 1.4, -1),                                    // FGDC 703
        PHYLLITE: () => wavySlantFamily(6, 1, T, 1, 0, 1.2, 3),
        SCHIST: () => wavySlantFamily(8, 1, T, 1, 0, 1.5, 2),                                                              // FGDC 705
        GNEISS: r => wavySlantFamily(4, 1, T, 1, 3, 2, 2) + randomDashes(r, 14, 3.5, 12),                                   // FGDC 708
        QUARTZITE: () => {                                                                                                 // FGDC 702
            const out = [];
            for (let k = 0; k < 4; k++) {
                const x0 = k * 26;
                for (let i = 0; i < 14; i++) {
                    const y = (i + 0.5) * (H / 14);
                    out.push(dot((x0 + 6 * Math.sin((y / H) * 2 * Math.PI) + W) % W, y, 0.8));
                }
            }
            return out.join('') + dotRows(9, 11, 0.7);
        },
        MARBLE: () => bricks(4, 2, T) + waves(4, 2.5, 2, T * 0.8, 'black', H / 8),
        HORNFELS: () => {
            const out = [];
            const courses = [0, 20, 41, 64, 93];
            for (const y of courses) out.push(line(-2, y, W + 2, y, T));
            const joints = [[8, 40, 76], [22, 58, 94], [12, 48, 84], [30, 66, 100]];
            joints.forEach((xs, c) => xs.forEach(x => out.push(line(x, courses[c], x + 3, courses[c + 1], T))));
            return out.join('');
        },
        SERPENTINITE: () => grid(7, 5, (x, y) => path(`M${f(x + 1.5)} ${f(y - 4)} q-3 2 0 4 t0 4`, T)),                  // FGDC 710
        GREENSTONE: r => bricks(4, 2, T) + scatter(r, 10, 16, 3, vee(2.4, T)),
        // ---- Fault rocks
        FAULT_GOUGE: r => scatter(r, 30, 9, 4, (x, y) => line(x - 3, y + 2, x + 3, y - 2, T)),
        FAULT_BRECCIA: r => scatter(r, 9, 22, 7, perElement(() => shard(r, 5, T))) + slantFamily(3, 1, T * 0.7),
        MYLONITE: () => hlines(12, T * 0.7),
    };
    const out = {};
    for (const [code, draw] of Object.entries(t)) {
        const drawn = draw(R(code));
        out[code] = typeof drawn === 'string' ? { width: W, height: H, body: drawn } : { width: W, height: H, ...drawn };
    }
    return out;
}
