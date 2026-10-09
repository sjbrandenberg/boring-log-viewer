// The location map: a marker for every open log that has latitude and
// longitude, with a street / satellite switch. Clicking a marker opens that log.
import * as L from 'leaflet/dist/leaflet-src.esm.js';
import { lineLength, MAX_SECTION_LENGTH } from '../src/section.js';

const BASE_KEY = 'boring-log-viewer:map-base';

const BASES = {
    Street: () => L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
        maxZoom: 19,
        attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
    }),
    Satellite: () => L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', {
        maxZoom: 19,
        attribution: 'Imagery &copy; Esri, Maxar, Earthstar Geographics',
    }),
};

export function setUpMap({ panel, container, note, onSelect, onLine, onLimit = () => {} }) {
    let map = null;
    let markers = null;
    let boundsKey = '';
    // The section line: its vertices, and the layers that draw it.
    let linePts = [];
    let corridorM = 100;
    let drawing = false;
    let lineLayer = null;

    function create() {
        map = L.map(container, { scrollWheelZoom: false, attributionControl: true });
        map.attributionControl.setPrefix(false);
        let saved = 'Street';
        try {
            saved = localStorage.getItem(BASE_KEY) || 'Street';
        } catch {
            // storage unavailable; use the street map
        }
        const layers = Object.fromEntries(Object.entries(BASES).map(([name, make]) => [name, make()]));
        (layers[saved] ?? layers.Street).addTo(map);
        L.control.layers(layers, null, { position: 'topright' }).addTo(map);
        L.control.scale({ imperial: true, metric: true }).addTo(map);
        map.on('baselayerchange', e => {
            try {
                localStorage.setItem(BASE_KEY, e.name);
            } catch {
                // not remembered
            }
        });
        // Scroll-wheel zoom only after the map is clicked, so the page scrolls past it.
        map.on('click focus', () => map.scrollWheelZoom.enable());
        map.on('mouseout blur', () => map.scrollWheelZoom.disable());
        lineLayer = L.layerGroup().addTo(map);
        markers = L.layerGroup().addTo(map);
        map.on('click', e => { if (drawing) addPoint(e.latlng); });
        map.on('dblclick', e => {
            if (!drawing) return;
            L.DomEvent.stop(e);
            finishLine();
        });
        drawLine();
    }

    // ------------------------------------------------ drawing the section line

    // A point that would make the line longer than MAX_SECTION_LENGTH is refused.
    function addPoint(latlng) {
        const next = [...linePts, { lat: latlng.lat, lon: latlng.lng }];
        const length = lineLength(next);
        if (length > MAX_SECTION_LENGTH) {
            onLimit(`A section line can be at most ${MAX_SECTION_LENGTH / 1000} km long; this point would make it ${(length / 1000).toFixed(1)} km. Click a nearer point, or finish the line.`);
            return;
        }
        onLimit('');
        linePts = next;
        drawLine();
    }

    let previous = [];
    function startLine() {
        if (!map) return;
        drawing = true;
        previous = linePts;
        linePts = [];
        map.doubleClickZoom.disable();
        container.classList.add('drawing');
        drawLine();
    }

    function finishLine() {
        drawing = false;
        map?.doubleClickZoom.enable();
        container.classList.remove('drawing');
        // A double-click adds the same point twice; drop repeats.
        linePts = linePts.filter((p, i) => i === 0 || Math.abs(p.lat - linePts[i - 1].lat) + Math.abs(p.lon - linePts[i - 1].lon) > 1e-9);
        if (linePts.length < 2) linePts = [];
        drawLine();
        onLine(linePts.length ? linePts : null);
    }

    // Esc while drawing: keep the line there was before.
    function cancelLine() {
        drawing = false;
        map?.doubleClickZoom.enable();
        container.classList.remove('drawing');
        linePts = previous;
        drawLine();
    }

    function clearLine() {
        drawing = false;
        map?.doubleClickZoom.enable();
        container.classList.remove('drawing');
        linePts = [];
        drawLine();
        onLine(null);
    }

    // The line, its A and A′ ends, and the corridor of borings it includes.
    function drawLine() {
        if (!lineLayer) return;
        lineLayer.clearLayers();
        if (!linePts.length) return;
        const latlngs = linePts.map(p => [p.lat, p.lon]);
        if (!drawing && linePts.length >= 2) {
            const k = Math.cos((linePts[0].lat * Math.PI) / 180);
            const dLat = corridorM / 110540;
            const dLon = corridorM / (111320 * k);
            for (let i = 0; i < linePts.length - 1; i++) {
                const a = linePts[i];
                const b = linePts[i + 1];
                const ex = (b.lon - a.lon) * 111320 * k;
                const ey = (b.lat - a.lat) * 110540;
                const len = Math.hypot(ex, ey) || 1;
                const ny = (ex / len) * dLat;
                const ox = (-ey / len) * dLon;
                L.polygon([[a.lat + ny, a.lon + ox], [b.lat + ny, b.lon + ox], [b.lat - ny, b.lon - ox], [a.lat - ny, a.lon - ox]], {
                    stroke: false, fillColor: '#d9480f', fillOpacity: 0.12, interactive: false,
                }).addTo(lineLayer);
            }
            // Round joins at the bends (the ends are square: borings past them are left out).
            for (const p of linePts.slice(1, -1)) L.circle([p.lat, p.lon], { radius: corridorM, stroke: false, fillColor: '#d9480f', fillOpacity: 0.12, interactive: false }).addTo(lineLayer);
        }
        L.polyline(latlngs, { color: '#d9480f', weight: 3, dashArray: drawing ? '6 6' : null, interactive: false }).addTo(lineLayer);
        for (const p of linePts) L.circleMarker([p.lat, p.lon], { radius: 3, color: '#d9480f', fillOpacity: 1, interactive: false }).addTo(lineLayer);
        const end = (p, label) => L.marker([p.lat, p.lon], {
            interactive: false,
            icon: L.divIcon({ className: 'section-end', html: label, iconSize: [22, 22], iconAnchor: [11, 26] }),
        }).addTo(lineLayer);
        end(linePts[0], 'A');
        if (linePts.length >= 2) end(linePts[linePts.length - 1], 'A′');
    }

    function setLine(line, corridor) {
        linePts = Array.isArray(line) ? line.map(p => ({ lat: p.lat, lon: p.lon })) : [];
        if (corridor > 0) corridorM = corridor;
        drawLine();
    }

    // points: [{ index, name, lat, lon }]; active: index of the log in the editor.
    function update(points, active, total, inSection = new Set()) {
        panel.hidden = points.length === 0;
        if (!points.length) return;
        if (!map) create();
        markers.clearLayers();
        // Draw the active log last so its marker is on top.
        const ordered = [...points].sort((a, b) => (a.index === active) - (b.index === active));
        for (const p of ordered) {
            const isActive = p.index === active;
            const marker = L.circleMarker([p.lat, p.lon], {
                radius: isActive ? 8 : 6,
                color: inSection.has(p.index) ? '#d9480f' : '#fff',
                weight: inSection.has(p.index) ? 3 : 2,
                fillColor: isActive ? '#d9480f' : '#1f5fa8',
                fillOpacity: 1,
            });
            marker.bindTooltip(p.name, { permanent: points.length <= 12, direction: 'right', offset: [8, 0], className: isActive ? 'map-label active' : 'map-label' });
            marker.on('click', e => {
                // While drawing, a click on a boring adds a point there.
                if (drawing) {
                    L.DomEvent.stop(e);
                    addPoint(L.latLng(p.lat, p.lon));
                } else onSelect(p.index);
            });
            marker.addTo(markers);
        }
        const without = total - points.length;
        note.textContent = without > 0 ? `${without} open log${without > 1 ? 's have' : ' has'} no coordinates.` : '';
        // Fit the map to the logs near the active one (within 50 km), so a log
        // from another site doesn't zoom the map out to the whole world. Refit
        // only when that group changes, not on every edit.
        const here = points.find(p => p.index === active);
        const group = here ? points.filter(p => distanceKm(p, here) <= 50) : points;
        const key = group.map(p => `${p.lat.toFixed(6)},${p.lon.toFixed(6)}`).sort().join(';');
        if (key !== boundsKey) {
            boundsKey = key;
            map.invalidateSize();
            if (group.length === 1) map.setView([group[0].lat, group[0].lon], 16);
            else map.fitBounds(L.latLngBounds(group.map(p => [p.lat, p.lon])), { padding: [40, 40], maxZoom: 17 });
        } else if (here && !map.getBounds().contains([here.lat, here.lon])) {
            map.panTo([here.lat, here.lon]);
        }
    }

    // After the panel is opened or resized.
    function refresh() {
        if (map) map.invalidateSize();
    }

    return { update, refresh, startLine, finishLine, cancelLine, clearLine, setLine, isDrawing: () => drawing, pointCount: () => linePts.length };
}

// Great-circle distance between two { lat, lon } points, in km.
export function distanceKm(a, b) {
    const rad = Math.PI / 180;
    const dLat = (b.lat - a.lat) * rad;
    const dLon = (b.lon - a.lon) * rad;
    const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLon / 2) ** 2;
    return 2 * 6371 * Math.asin(Math.sqrt(h));
}
