// Draws every built-in hatch as a labelled swatch, at the scale used in logs
// (40 px graphic column), to check the artwork:
//   node scripts/hatch-catalog.js catalog.png [--all]
// Without --all only the non-USCS materials are drawn.
import { writeFileSync } from 'node:fs';
import { Resvg } from '@resvg/resvg-js';
import { HATCH_TILES } from '../src/hatches.js';
import { LITHOLOGY, LITHOLOGY_GROUPS } from '../src/lithology.js';
import { DUAL_NAMES, USCS_NAMES } from '../src/classify.js';
import { loadFonts } from '../server/fonts.js';

const esc = s => s.replace(/&/g, '&amp;').replace(/</g, '&lt;');
const all = process.argv.includes('--all');
const groups = [...(all ? [['USCS soils', Object.keys(USCS_NAMES).map(c => [c, USCS_NAMES[c]])],
    ['USCS dual symbols', Object.keys(DUAL_NAMES).filter(c => HATCH_TILES[c]).map(c => [c, DUAL_NAMES[c]])]] : []),
    ...LITHOLOGY_GROUPS.map(g => [g, Object.entries(LITHOLOGY).filter(([, v]) => v.group === g).map(([c, v]) => [c, v.name])])];
const cols = 4, cellW = 250, cellH = 62, sw = 80, sh = 50, scale = 40 / 104;
const out = [];
const defs = [];
let y = 20;
for (const [group, items] of groups) {
    out.push(`<text x="16" y="${y + 14}" font-size="15" font-weight="bold">${esc(group)}</text>`);
    y += 26;
    items.forEach(([code, name], i) => {
        const x = 16 + (i % cols) * cellW;
        const yy = y + Math.floor(i / cols) * cellH;
        const t = HATCH_TILES[code];
        defs.push(`<pattern id="c-${code}" patternUnits="userSpaceOnUse" width="${t.width}" height="${t.height}" patternTransform="translate(${x} ${yy}) scale(${scale})">${t.body}</pattern>`);
        out.push(`<rect x="${x}" y="${yy}" width="${sw}" height="${sh}" fill="${t.background ?? '#fff'}"/><rect x="${x}" y="${yy}" width="${sw}" height="${sh}" fill="url(#c-${code})" stroke="#000" stroke-width="1"/>`);
        out.push(`<text x="${x + sw + 8}" y="${yy + 20}" font-size="12" font-weight="bold">${esc(code)}</text><text x="${x + sw + 8}" y="${yy + 36}" font-size="11">${esc(name.length > 26 ? name.slice(0, 25) + '…' : name)}</text>`);
    });
    y += Math.ceil(items.length / cols) * cellH + 10;
}
const width = 16 + cols * cellW;
const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${y}" font-family="Arimo"><rect width="100%" height="100%" fill="#fff"/><defs>${defs.join('')}</defs>${out.join('')}</svg>`;
writeFileSync(process.argv[2], new Resvg(svg, { fitTo: { mode: 'zoom', value: 2 }, font: { fontFiles: loadFonts(), loadSystemFonts: false, defaultFontFamily: 'Arimo' } }).render().asPng());
console.log(`wrote ${process.argv[2]} (${groups.reduce((n, [, i]) => n + i.length, 0)} hatches)`);
