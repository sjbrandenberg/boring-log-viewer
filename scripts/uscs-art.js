// Procedural artwork for the USCS hatches, following the Caltrans Soil and Rock
// Logging, Classification, and Presentation Manual (2010) legend conventions:
// a grain pattern for the coarse fraction (filled pebbles for well-graded gravel,
// open pebbles for poorly graded and dirty gravel, triangles and dots for
// well-graded sand, dots for poorly graded and dirty sand) with a fines pattern on
// top (vertical lines for silt M, gentle diagonals for clay C, doubled for high
// plasticity H, wavy for organic O). Dual symbols are one tile: the coarse soil's
// grain with a lighter overlay of the fines (e.g. SP-SM = SP dots + two vertical
// lines per tile), except CL-ML, which the renderer draws as split halves.
import { W, H, SW, rng, scatter, grid, dot, blob, perElement, triangle, verticals, slantFamily, wavySlantFamily, tuft } from './hatch-primitives.js';

// ---- grain (coarse fraction), seeded by the soil it belongs to
const filledGravel = r => scatter(r, 9, 22, 11, perElement(i => blob(r, 4.5 + (i % 3) * 2.2, 'black', 1))) + scatter(r, 6, 14, 2, (x, y) => dot(x, y, 1.4));
const openGravel = (r, n = 11) => scatter(r, n, 20, 10, perElement(i => blob(r, 4 + (i % 3) * 1.8, 'none', SW)));
const wellGradedSand = r => scatter(r, 9, 22, 4, (x, y, i) => triangle(3, SW * 0.9)(x, y, i)) + scatter(r, 12, 12, 2, (x, y) => dot(x, y, 1.2));
const sandDots = r => scatter(r, 34, 8, 2, (x, y) => dot(x, y, 1.1));

// ---- fines (silt, clay, organic), full strength and as a lighter dual overlay
const SILT = verticals(3, SW);
// Two lines at a quarter and three quarters across, clear of the column's middle
// (where they would look like the divider of a split dual) and its edges.
const SILT_DUAL = verticals(2, SW);
const CLAY = slantFamily(3, 2, SW, 1);
const CLAY_DUAL = slantFamily(2, 2, SW, 1);
const HIGH_SILT = verticals(3, SW * 0.85, 4);
const HIGH_CLAY = slantFamily(3, 2, SW * 0.85, 1, 4);
const ORGANIC_LOW = wavySlantFamily(3, 2, SW, 1, 0, 2.6, 2);
const ORGANIC_HIGH = wavySlantFamily(3, 2, SW * 0.85, 1, 4, 2.6, 2);

export function uscsArt() {
    const R = code => rng(`uscs-${code}`);
    const t = {
        GW: () => filledGravel(R('GW')),
        GP: () => openGravel(R('GP')),
        GM: () => openGravel(R('GP'), 9) + SILT,
        GC: () => openGravel(R('GP'), 9) + CLAY,
        SW: () => wellGradedSand(R('SW')),
        SP: () => sandDots(R('SP')),
        SM: () => sandDots(R('SP')) + SILT,
        SC: () => sandDots(R('SP')) + CLAY,
        ML: () => SILT,
        CL: () => CLAY,
        MH: () => HIGH_SILT,
        CH: () => HIGH_CLAY,
        OL: () => ORGANIC_LOW,
        OH: () => ORGANIC_HIGH,
        PT: () => grid(3, 4, (x, y) => tuft(6, SW)(x, y + 4)),
        // Dual symbols, drawn as one tile (Caltrans style)
        'GW-GM': () => filledGravel(R('GW')) + SILT_DUAL,
        'GW-GC': () => filledGravel(R('GW')) + CLAY_DUAL,
        'GP-GM': () => openGravel(R('GP')) + SILT_DUAL,
        'GP-GC': () => openGravel(R('GP')) + CLAY_DUAL,
        'GC-GM': () => openGravel(R('GP'), 9) + CLAY_DUAL + SILT_DUAL,
        'SW-SM': () => wellGradedSand(R('SW')) + SILT_DUAL,
        'SW-SC': () => wellGradedSand(R('SW')) + CLAY_DUAL,
        'SP-SM': () => sandDots(R('SP')) + SILT_DUAL,
        'SP-SC': () => sandDots(R('SP')) + CLAY_DUAL,
        'SC-SM': () => sandDots(R('SP')) + CLAY_DUAL + SILT_DUAL,
    };
    const out = {};
    for (const [code, draw] of Object.entries(t)) out[code] = { width: W, height: H, body: draw() };
    return out;
}
