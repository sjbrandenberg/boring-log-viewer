// The site page, returned by POST /api/site (format=html): all the borings of
// one site, with a 3D block model, suggested cross-sections and each boring's
// log, plus a map. The data is embedded in the page, so it works on its own
// (in a new tab, an iframe, or saved to disk).
import * as L from 'leaflet/dist/leaflet-src.esm.js';
import { renderBoringLog } from '../src/render.js';
import { renderSection, placeAlongLine, lineBearing } from '../src/section.js';
import { siteBorings, autoSections } from '../src/site.js';
import { setUpBlock } from './block.js';

const $ = id => document.getElementById(id);
const data = JSON.parse($('site-data').textContent);
const borings = siteBorings(data.borings);
const located = borings.filter(b => b.lat !== null);
const sections = autoSections(borings);

let view = located.length >= 2 ? '3d' : 'logs';
let sectionIndex = 0;
let boringIndex = 0;
let style = 'colour';
let units = '';
let ve = null;
let opacity = 1;
let shown = null; // { svg, name } of the section or log shown

// ------------------------------------------------------------ header

$('site-name').textContent = data.name || 'Site';
document.title = `${data.name || 'Site'}: boring logs`;
$('site-summary').textContent = `${borings.length} boring${borings.length === 1 ? '' : 's'}`
    + (located.length < borings.length ? ` (${borings.length - located.length} without coordinates, shown only as logs)` : '')
    + (sections.length ? ` · ${sections.length} suggested cross-section${sections.length === 1 ? '' : 's'}` : '');

for (const [i, s] of sections.entries()) $('section-pick').append(new Option(`${s.id}–${s.id}′: ${s.name.replace(/ \(.*\)$/, '')} (${s.borings.length} borings)`, String(i)));
for (const [i, b] of borings.entries()) $('boring-pick').append(new Option(b.name, String(i)));
$('tab-3d').disabled = located.length < 2;
$('tab-sections').disabled = !sections.length;

// ------------------------------------------------------------ map

const map = L.map('map', { scrollWheelZoom: false });
L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19, attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors' }).addTo(map);
map.attributionControl.setPrefix(false);
map.on('click focus', () => map.scrollWheelZoom.enable());
map.on('mouseout blur', () => map.scrollWheelZoom.disable());
const lineLayer = L.layerGroup().addTo(map);
const markerLayer = L.layerGroup().addTo(map);
if (located.length) {
    map.fitBounds(L.latLngBounds(located.map(b => [b.lat, b.lon])), { padding: [40, 40], maxZoom: 17 });
} else {
    $('map-box').hidden = true;
}

function drawMap() {
    lineLayer.clearLayers();
    markerLayer.clearLayers();
    const active = view === 'sections' ? sections[sectionIndex] : null;
    const inSection = new Set(active ? active.borings.map(b => b.index) : []);
    sections.forEach((s, i) => {
        const on = view === 'sections' && i === sectionIndex;
        const line = L.polyline(s.line.map(p => [p.lat, p.lon]), { color: on ? '#d9480f' : '#888', weight: on ? 4 : 2, dashArray: on ? null : '6 5' }).addTo(lineLayer);
        line.on('click', () => {
            sectionIndex = i;
            setView('sections');
        });
        const end = (p, label) => L.marker([p.lat, p.lon], { interactive: false, icon: L.divIcon({ className: `section-end${on ? '' : ' off'}`, html: label, iconSize: [22, 22], iconAnchor: [11, 26] }) }).addTo(lineLayer);
        end(s.line[0], s.id);
        end(s.line[s.line.length - 1], `${s.id}′`);
    });
    for (const b of located) {
        const isLog = view === 'logs' && b.index === boringIndex;
        const m = L.circleMarker([b.lat, b.lon], {
            radius: isLog ? 8 : 6, color: inSection.has(b.index) ? '#d9480f' : '#fff', weight: inSection.has(b.index) ? 3 : 2,
            fillColor: isLog ? '#d9480f' : '#1f5fa8', fillOpacity: 1,
        }).addTo(markerLayer);
        m.bindTooltip(b.name, { permanent: located.length <= 15, direction: 'right', offset: [8, 0], className: 'map-label' });
        m.on('click', () => {
            boringIndex = b.index;
            setView('logs');
        });
    }
}

// ------------------------------------------------------------ views

const block = setUpBlock($('block'), $('block-legend'));

function setView(v) {
    view = v;
    for (const [id, name] of [['tab-3d', '3d'], ['tab-sections', 'sections'], ['tab-logs', 'logs']]) $(id).setAttribute('aria-selected', String(view === name));
    for (const el of document.querySelectorAll('[data-views]')) el.hidden = !el.dataset.views.split(' ').includes(view);
    $('view3d').hidden = view !== '3d';
    $('drawing').hidden = view === '3d';
    $('section-pick').value = String(sectionIndex);
    $('boring-pick').value = String(boringIndex);
    draw();
    drawMap();
}

function draw() {
    if (view === '3d') {
        const info = block.show(located.map(b => ({ name: b.name, lat: b.lat, lon: b.lon, doc: b.doc, text: JSON.stringify(b.doc) })), { ve, opacity });
        if (info) {
            $('ve').value = info.ve;
            $('ve-value').textContent = info.ve;
        }
        shown = null;
        return;
    }
    const note = $('note');
    try {
        if (view === 'sections') {
            const s = sections[sectionIndex];
            const placed = placeAlongLine(located, s.line, s.corridor);
            const { svg } = renderSection(placed, { length: s.length, style, units: units || undefined, title: `Cross-section ${s.id}–${s.id}′`, id: s.id, bearing: lineBearing(s.line), id_prefix: `s${s.id}` });
            shown = { svg, name: `section_${s.id}` };
            note.textContent = `${s.description} ${s.borings.length} borings, from ${s.id} to ${s.id}′: ${s.borings.map(b => `${b.name} (${b.offset} m ${b.side} of the line)`).join(', ')}. Line ${Math.round(s.length)} m long.`;
        } else {
            const b = borings[boringIndex];
            const svg = renderBoringLog(b.doc, units ? { units } : {});
            shown = { svg, name: String(b.name).replace(/[^A-Za-z0-9._-]+/g, '_') || 'boring-log' };
            note.textContent = b.lat === null ? 'This boring has no coordinates, so it is not on the map, in the sections or in the 3D model.' : '';
        }
        // The renderers escape all text from the data, so their output is safe to insert.
        $('drawing').innerHTML = shown.svg;
    } catch (e) {
        shown = null;
        $('drawing').textContent = `Could not draw this: ${e.message}`;
    }
}

$('tab-3d').addEventListener('click', () => setView('3d'));
$('tab-sections').addEventListener('click', () => setView('sections'));
$('tab-logs').addEventListener('click', () => setView('logs'));
$('section-pick').addEventListener('change', e => { sectionIndex = Number(e.target.value); setView('sections'); });
$('boring-pick').addEventListener('change', e => { boringIndex = Number(e.target.value); setView('logs'); });
$('style').addEventListener('change', e => { style = e.target.value; draw(); });
$('units').addEventListener('change', e => { units = e.target.value; draw(); });
$('ve').addEventListener('input', e => { ve = Number(e.target.value); $('ve-value').textContent = e.target.value; draw(); });
$('opacity').addEventListener('input', e => { opacity = Number(e.target.value); draw(); });
$('fit').addEventListener('change', e => $('drawing').classList.toggle('fit', e.target.checked));

// ------------------------------------------------------------ downloads

function saveBlob(blob, name) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = name;
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
}

async function svgToPng(svg, scale = 2) {
    const url = URL.createObjectURL(new Blob([svg], { type: 'image/svg+xml' }));
    try {
        const img = new Image();
        img.src = url;
        await img.decode();
        const canvas = document.createElement('canvas');
        canvas.width = Math.round(img.naturalWidth * scale);
        canvas.height = Math.round(img.naturalHeight * scale);
        const ctx = canvas.getContext('2d');
        ctx.scale(scale, scale);
        ctx.drawImage(img, 0, 0);
        return await new Promise(resolve => canvas.toBlob(resolve, 'image/png'));
    } finally {
        URL.revokeObjectURL(url);
    }
}

const siteFile = () => (data.name || 'site').replace(/[^A-Za-z0-9._-]+/g, '_');
$('download-svg').addEventListener('click', () => {
    if (view === '3d') {
        const svg = block.toSvg();
        if (svg) saveBlob(new Blob([`<?xml version="1.0" encoding="UTF-8"?>\n${svg}\n`], { type: 'image/svg+xml' }), `${siteFile()}_3d.svg`);
    } else if (shown) saveBlob(new Blob([`<?xml version="1.0" encoding="UTF-8"?>\n${shown.svg}\n`], { type: 'image/svg+xml' }), `${shown.name}.svg`);
});
$('download-png').addEventListener('click', async () => {
    if (view === '3d') {
        const blob = await block.toPng(Number($('png-scale').value) || 2);
        if (blob) saveBlob(blob, `${siteFile()}_3d.png`);
    } else if (shown) saveBlob(await svgToPng(shown.svg, Number($('png-scale').value) || 2), `${shown.name}.png`);
});

setView(view);
