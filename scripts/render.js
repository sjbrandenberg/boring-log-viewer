// Command-line renderer, mainly for previewing fixtures:
//   node scripts/render.js input.json [output.svg|output.png] [--units=ft] [--width=900]
// Without an output path the SVG is written to stdout.
import { readFileSync, writeFileSync } from 'node:fs';
import { renderBoringLog, validateBoringLog } from '../src/index.js';

const args = process.argv.slice(2);
const positional = args.filter(a => !a.startsWith('--'));
const options = {};
for (const a of args.filter(a => a.startsWith('--'))) {
    const [key, value] = a.slice(2).split('=');
    options[key] = /^\d+(\.\d+)?$/.test(value) ? Number(value) : value;
}
const [input, output] = positional;
if (!input) {
    console.error('usage: node scripts/render.js input.json [output.svg|output.png] [--option=value ...]');
    process.exit(2);
}

const json = readFileSync(input, 'utf8');
const check = validateBoringLog(json);
for (const w of check.warnings) console.error(`warning ${w.path}: ${w.message}`);
if (!check.valid) {
    for (const e of check.errors) console.error(`error ${e.path || '/'}: ${e.message}`);
    process.exit(1);
}

const svg = renderBoringLog(json, options);
if (!output) {
    process.stdout.write(svg);
} else if (output.endsWith('.png')) {
    const { Resvg } = await import('@resvg/resvg-js');
    const png = new Resvg(svg, { fitTo: { mode: 'zoom', value: 2 }, font: { loadSystemFonts: true, defaultFontFamily: 'Arial' } }).render().asPng();
    writeFileSync(output, png);
} else {
    writeFileSync(output, svg);
}
