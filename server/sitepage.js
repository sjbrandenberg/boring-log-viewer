// The HTML of the site page: the page script and styles (built by
// `npm run build` into public/) with the site's data embedded, so the page
// needs nothing from this server once it is loaded.
import { readFileSync, existsSync } from 'node:fs';
import { escapeXml } from '../src/text.js';

const root = new URL('../', import.meta.url);
let assets = null;

// The built script and styles; null when the site hasn't been built.
export function siteAssets() {
    if (assets) return assets;
    const file = name => new URL(`public/${name}`, root);
    if (!['site-page.js', 'site-page.css', 'leaflet.css'].every(n => existsSync(file(n)))) return null;
    assets = {
        script: readFileSync(file('site-page.js'), 'utf8'),
        css: readFileSync(file('leaflet.css'), 'utf8') + readFileSync(file('site-page.css'), 'utf8'),
    };
    return assets;
}

// JSON inside a <script> element: "<" is escaped so the data can't end it.
const scriptJson = value => JSON.stringify(value).replace(/</g, '\\u003c').replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');

export function sitePage({ name, borings }) {
    const a = siteAssets();
    if (!a) return null;
    const title = `${name || 'Site'}: boring logs`;
    return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeXml(title)}</title>
<style>${a.css.replace(/<\/style/gi, '<\\/style')}</style>
</head>
<body>
<header>
    <h1 id="site-name"></h1>
    <p id="site-summary"></p>
</header>
<main class="layout">
    <section class="pane">
        <div class="tabs" role="tablist" aria-label="What to show">
            <button id="tab-3d" type="button" role="tab">3D model</button>
            <button id="tab-sections" type="button" role="tab">Cross-sections</button>
            <button id="tab-logs" type="button" role="tab">Boring logs</button>
        </div>
        <div class="toolbar">
            <label data-views="sections">Section <select id="section-pick"></select></label>
            <label data-views="logs">Boring <select id="boring-pick"></select></label>
            <label data-views="sections">Layers between borings
                <select id="style"><option value="colour">Colours and labels</option><option value="hatch">USCS hatches</option></select>
            </label>
            <label data-views="sections logs">Units
                <select id="units"><option value="">As in data</option><option value="m">Metric</option><option value="ft">US</option></select>
            </label>
            <label data-views="3d">Vertical exaggeration ×<span id="ve-value">1</span> <input id="ve" type="range" min="1" max="50" step="1" value="10"></label>
            <label data-views="3d" title="See through the layers to the borings and the water table">Opacity <input id="opacity" type="range" min="0.2" max="1" step="0.05" value="1"></label>
            <label data-views="sections logs"><input id="fit" type="checkbox" checked> Fit to width</label>
            <span class="spacer"></span>
            <label title="PNG resolution: times the size on screen">PNG <select id="png-scale"><option value="1">1×</option><option value="2" selected>2×</option><option value="3">3×</option><option value="4">4×</option></select></label>
            <button id="download-svg" type="button" class="primary">SVG</button>
            <button id="download-png" type="button" class="primary">PNG</button>
        </div>
        <p id="note" class="note" data-views="sections logs"></p>
        <div id="view3d">
            <div id="block" class="block3d" role="img" aria-label="3D model of the site"></div>
            <aside id="block-legend" class="block-legend"></aside>
            <p class="muted small-note">Drag to turn, right-drag or Shift-drag to move, scroll to zoom.</p>
        </div>
        <div id="drawing" class="drawing fit"></div>
    </section>
    <aside class="pane map-box" id="map-box">
        <h2>Map</h2>
        <div id="map" role="region" aria-label="Map of the borings and sections"></div>
        <p class="muted small-note">Click a boring to see its log, or a line to see that cross-section.</p>
    </aside>
</main>
<footer>Drawn by the UCLA Boring Log Viewer. Layers between borings, in the sections and the 3D model, are connected automatically: an interpretation, not a geologic model.</footer>
<script type="application/json" id="site-data">${scriptJson({ name, borings })}</script>
<script type="module">${a.script.replace(/<\/script/gi, '<\\/script')}</script>
</body>
</html>
`;
}
