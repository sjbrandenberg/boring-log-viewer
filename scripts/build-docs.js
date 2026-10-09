// Builds the documentation website (for GitHub Pages) into _site/.
//   node scripts/build-docs.js           one-off build
//   node scripts/build-docs.js --serve   build, then serve on :8081 and rebuild on change
//
// Each page in docs/pages/ is an HTML fragment wrapped in docs/_layout.html.
// The first lines of a page set its title and summary:
//   <!-- title: Your first boring log -->
//   <!-- description: ... -->
// Comments like these are replaced with output from the renderer, so the
// figures and symbol lists always match the code:
//   <!-- log: step1-layers.json -->                       the example drawn as SVG
//   <!-- log: full-example.json -> full-ft.svg {"units":"ft"} -->   with render options
//   <!-- json: step1-layers.json -->                      the example's JSON, with a download link
//   <!-- gallery: uscs | duals | materials | samplers --> swatches with codes and names
//   <!-- inference: description | description | ... -->  what the renderer infers from each
//   <!-- uscscheck: SP-SM = well graded SAND ; ... -->    how a recorded symbol is checked against its description
//   <!-- section: NAS-1.json NAS-2.json ... -> nas-a.svg {"id":"A"} -->  a suggested cross-section of those borings
// Examples are read from docs/examples/, else from the repository's examples/.
// The docs' own examples must validate without warnings.
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, watch, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
    renderBoringLog, validateBoringLog, hatchSwatch, hatchName, samplerSwatch, SAMPLER_NAMES,
    USCS_SYMBOLS, USCS_NAMES, DUAL_NAMES, LITHOLOGY, LITHOLOGY_GROUPS, inferMaterial, layerHatch,
    renderSection, placeAlongLine,
} from '../src/index.js';
import { describedUscs, checkUscs } from '../src/classify.js';
import { siteBorings, siteSummary } from '../src/site.js';
import { lineBearing } from '../src/section.js';

const root = new URL('../', import.meta.url);
const src = new URL('docs/', root);
const out = new URL('_site/', root);
const path = url => fileURLToPath(url);

const escapeHtml = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

// Navigation, in reading order: [file, label, section heading or null].
const NAV = [
    ['index.html', 'Overview', 'Start here'],
    ['getting-started.html', 'Your first boring log', null],
    ['reading-the-log.html', 'Reading the log', null],
    ['data-format.html', 'Data format reference', 'Entering data'],
    ['graphic-log.html', 'Graphic log and soil symbols', null],
    ['samples.html', 'Samples, specimens and tests', null],
    ['layout.html', 'Columns and layout', null],
    ['custom-hatches.html', 'Your own hatches', null],
    ['several-logs.html', 'Several logs and the map', 'Sites with many borings'],
    ['site-view.html', 'Site view: sections and 3D', null],
    ['cross-sections.html', 'How cross-sections are drawn', null],
    ['model-3d.html', 'The 3D model', null],
    ['importing.html', 'Importing AGS4 and DIGGS', 'Other ways in and out'],
    ['options.html', 'Display options', null],
    ['api.html', 'Render API (scripts)', null],
    ['troubleshooting.html', 'Troubleshooting and FAQ', 'Help'],
];

function nav(current) {
    let html = '';
    for (const [file, label, section] of NAV) {
        if (section) html += `${html ? '</ul>' : ''}<p class="nav-section">${section}</p><ul>`;
        html += `<li><a href="${file}"${file === current ? ' aria-current="page"' : ''}>${label}</a></li>`;
    }
    return `${html}</ul>`;
}

function pager(current) {
    const i = NAV.findIndex(([file]) => file === current);
    const prev = NAV[i - 1];
    const next = NAV[i + 1];
    return '<nav class="pager" aria-label="Previous and next page">'
        + (prev ? `<a class="prev" href="${prev[0]}"><span>Previous</span>${prev[1]}</a>` : '<span></span>')
        + (next ? `<a class="next" href="${next[0]}"><span>Next</span>${next[1]}</a>` : '<span></span>')
        + '</nav>';
}

// ------------------------------------------------------------- directives

// An example's JSON, copied into the site so it can be downloaded.
function example(name) {
    const file = [new URL(`examples/${name}`, src), new URL(`examples/${name}`, root)].find(existsSync);
    if (!file) throw new Error(`examples/${name} not found in docs/ or the repository`);
    const json = readFileSync(file, 'utf8');
    const check = validateBoringLog(json);
    if (!check.valid) throw new Error(`${name}: ${check.errors.map(e => `${e.path} ${e.message}`).join('; ')}`);
    if (file.href.startsWith(src.href) && check.warnings.length) throw new Error(`${name}: ${check.warnings.map(e => `${e.path} ${e.message}`).join('; ')}`);
    writeFileSync(new URL(`examples/${name}`, out), json);
    return json;
}

const logsWritten = new Set();
function logFigure(arg) {
    const m = /^(\S+)(?:\s*->\s*(\S+))?\s*(\{.*\})?$/.exec(arg.trim());
    if (!m) throw new Error(`bad log directive: ${arg}`);
    const [, name, outName = name.replace(/\.json$/, '.svg'), opts] = m;
    const json = example(name);
    const options = { width: 900, ...(opts ? JSON.parse(opts) : {}) };
    if (!logsWritten.has(outName)) {
        writeFileSync(new URL(`examples/${outName}`, out), renderBoringLog(json, options));
        logsWritten.add(outName);
    }
    return `<figure class="log"><a href="examples/${outName}" title="Open full size"><img src="examples/${outName}" alt="Boring log drawn from ${name}" loading="lazy"></a>`
        + `<figcaption>Drawn from <a href="examples/${name}" download><code>${name}</code></a>. Click to open full size.</figcaption></figure>`;
}

function jsonBlock(name) {
    return `<div class="code-file"><div class="code-file-head"><code>${name}</code><a href="examples/${name}" download>Download</a></div>`
        + `<pre><code>${escapeHtml(example(name).trim())}</code></pre></div>`;
}

// A pair without a tile of its own (e.g. CL-ML) is drawn as a split column.
function swatch(code) {
    const svg = hatchSwatch(code);
    if (svg || !/[-/]/.test(code)) return svg;
    const [a, b] = code.split(/[-/]/).map(c => hatchSwatch(c, { width: 21 }));
    return `<svg xmlns="http://www.w3.org/2000/svg" width="40" height="24" viewBox="0 0 40 24">${a}<g transform="translate(19 0)">${b}</g></svg>`;
}

const swatchItem =(svg, code, name) => `<li><span class="swatch">${svg}</span><code>${escapeHtml(code)}</code><span>${escapeHtml(name)}</span></li>`;

function gallery(kind) {
    switch (kind.trim()) {
        case 'uscs':
            return `<ul class="gallery">${USCS_SYMBOLS.map(c => swatchItem(hatchSwatch(c), c, USCS_NAMES[c])).join('')}</ul>`;
        case 'duals':
            return `<ul class="gallery">${Object.keys(DUAL_NAMES).filter(c => hatchSwatch(c)).map(c => swatchItem(hatchSwatch(c), c, DUAL_NAMES[c])).join('')}</ul>`;
        case 'materials':
            return LITHOLOGY_GROUPS.map(group => {
                const codes = Object.keys(LITHOLOGY).filter(c => LITHOLOGY[c].group === group);
                return `<h4>${escapeHtml(group)}</h4><ul class="gallery">`
                    + codes.map(c => swatchItem(hatchSwatch(c), c, LITHOLOGY[c].name)).join('') + '</ul>';
            }).join('');
        case 'samplers':
            return `<ul class="gallery samplers">${Object.keys(SAMPLER_NAMES).map(c => swatchItem(samplerSwatch(c), c, SAMPLER_NAMES[c])).join('')}</ul>`;
        default:
            throw new Error(`unknown gallery: ${kind}`);
    }
}

// What the renderer does with each description: the hatch it draws (same order
// as layerHatch() with infer_uscs and infer_materials on) and the USCS shown.
function inference(arg) {
    const rows = arg.split('|').map(s => s.trim()).filter(Boolean).map(d => {
        const uscs = describedUscs(d);
        const hatch = inferMaterial(d) ?? uscs;
        const svg = hatch ? swatch(hatch) : '';
        return `<tr><td>${escapeHtml(d)}</td><td>${hatch ? `<span class="swatch">${svg}</span> <code>${hatch}</code> ${escapeHtml(hatchName(hatch))}` : '<span class="muted">none</span>'}</td>`
            + `<td>${uscs ? `<code>(${uscs})</code>` : '<span class="muted">blank</span>'}</td></tr>`;
    });
    return '<div class="table-wrap"><table class="inference"><thead><tr><th>Description</th><th>Graphic log draws</th><th>USCS column shows</th></tr></thead>'
        + `<tbody>${rows.join('')}</tbody></table></div>`;
}

// A recorded symbol checked against its description, as the log shows it
// (prepareDoc() and the USCS column in render.js).
function uscsCheck(arg) {
    const rows = arg.split(';').map(s => s.trim()).filter(Boolean).map(pair => {
        const [uscs, description] = pair.split('=').map(s => s.trim());
        const check = checkUscs(uscs, description);
        const hatch = layerHatch({ uscs, ...(check?.inferred ? { uscs_check: check.inferred } : {}) }).join('-');
        const shown = check?.inferred ? `<code>${uscs}</code> over <code>(${check.inferred})</code>` : `<code>${uscs}</code>`;
        const why = !check ? 'Agrees with the description' : check.invalid ? 'Not a possible USCS symbol' : 'The description reads as a different symbol';
        return `<tr><td><code>${escapeHtml(uscs)}</code></td><td>${escapeHtml(description)}</td><td>${shown}</td>`
            + `<td>${hatch ? `<span class="swatch">${swatch(hatch)}</span> <code>${hatch}</code>` : '<span class="muted">blank</span>'}</td><td>${why}${check ? ' (warning)' : ''}</td></tr>`;
    });
    return '<div class="table-wrap"><table class="inference"><thead><tr><th>Recorded <code>uscs</code></th><th>Description</th><th>USCS column shows</th><th>Graphic log draws</th><th>Why</th></tr></thead>'
        + `<tbody>${rows.join('')}</tbody></table></div>`;
}

// A suggested cross-section of a site, as the site API draws it (server/app.js).
function sectionFigure(arg) {
    const m = /^(.+?)\s*->\s*(\S+)\s*(\{.*\})?$/.exec(arg.trim());
    if (!m) throw new Error(`bad section directive: ${arg}`);
    const [, list, outName, opts] = m;
    const names = list.split(/\s+/);
    const docs = names.map(n => JSON.parse(example(n)));
    const { id = 'A', ...options } = opts ? JSON.parse(opts) : {};
    const s = siteSummary(docs).sections.find(x => x.id === id);
    if (!s) throw new Error(`section ${id} not suggested for ${list}`);
    const located = siteBorings(docs).filter(b => b.lat !== null);
    const { svg } = renderSection(placeAlongLine(located, s.line, s.corridor), {
        length: s.length, id: s.id, bearing: lineBearing(s.line) ?? undefined, title: `Cross-section ${s.id}–${s.id}′`, id_prefix: `s${s.id}`, ...options,
    });
    writeFileSync(new URL(`examples/${outName}`, out), svg);
    return `<figure class="log"><a href="examples/${outName}" title="Open full size"><img src="examples/${outName}" alt="Cross-section ${s.id} through ${names.length} borings" loading="lazy"></a>`
        + `<figcaption>${escapeHtml(s.name)}, drawn from ${names.map(n => `<a href="examples/${n}" download><code>${n}</code></a>`).join(', ')}. ${escapeHtml(s.description)} Click to open full size.</figcaption></figure>`;
}

const DIRECTIVES = { log: logFigure, json: jsonBlock, gallery, inference, uscscheck: uscsCheck, section: sectionFigure };

// ------------------------------------------------------------------ build

function build() {
    rmSync(out, { recursive: true, force: true });
    mkdirSync(new URL('examples/', out), { recursive: true });
    logsWritten.clear();
    cpSync(new URL('assets/', src), new URL('assets/', out), { recursive: true });
    cpSync(new URL('site/favicon.svg', root), new URL('favicon.svg', out));
    cpSync(new URL('schema/boring-log.schema.json', root), new URL('boring-log.schema.json', out));
    for (const f of readdirSync(new URL('examples/', src)).filter(f => f.endsWith('.json'))) example(f);
    writeFileSync(new URL('.nojekyll', out), '');

    const layout = readFileSync(new URL('_layout.html', src), 'utf8');
    for (const [file] of NAV) {
        const page = readFileSync(new URL(`pages/${file}`, src), 'utf8');
        const title = /<!--\s*title:\s*(.*?)\s*-->/.exec(page)?.[1] ?? 'Boring Log Viewer';
        const description = /<!--\s*description:\s*(.*?)\s*-->/.exec(page)?.[1] ?? '';
        const body = page
            .replace(/<!--\s*(title|description):.*?-->\s*/g, '')
            .replace(/<!--\s*(log|json|gallery|inference|uscscheck|section):([\s\S]*?)-->/g, (_, name, arg) => DIRECTIVES[name](arg.trim()));
        const html = layout
            .replaceAll('{{title}}', escapeHtml(file === 'index.html' ? 'Boring Log Viewer documentation' : `${title} · Boring Log Viewer`))
            .replaceAll('{{description}}', escapeHtml(description))
            .replace('{{nav}}', nav(file))
            .replace('{{content}}', body)
            .replace('{{pager}}', pager(file));
        writeFileSync(new URL(file, out), html);
    }
    console.log(`built ${NAV.length} pages into _site/`);
}

build();

if (process.argv.includes('--serve')) {
    const TYPES = { '.html': 'text/html', '.css': 'text/css', '.js': 'text/javascript', '.svg': 'image/svg+xml', '.json': 'application/json' };
    let timer;
    watch(path(src), { recursive: true }, () => {
        clearTimeout(timer);
        timer = setTimeout(() => {
            try { build(); } catch (e) { console.error(e.message); }
        }, 100);
    });
    createServer((req, res) => {
        let p = decodeURIComponent(new URL(req.url, 'http://x').pathname).replace(/^\/+/, '');
        if (p === '' || p.endsWith('/')) p += 'index.html';
        const file = new URL(p, out);
        if (p.includes('..') || !existsSync(file)) {
            res.writeHead(404).end('not found');
            return;
        }
        res.writeHead(200, { 'Content-Type': TYPES[extname(p)] ?? 'application/octet-stream' }).end(readFileSync(file));
    }).listen(8081, () => console.log('serving http://localhost:8081/'));
}
