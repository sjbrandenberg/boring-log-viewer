// The location map: a marker for every open log that has latitude and
// longitude, with a street / satellite switch. Clicking a marker opens that log.
import * as L from 'leaflet/dist/leaflet-src.esm.js';

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

export function setUpMap({ panel, container, note, onSelect }) {
    let map = null;
    let markers = null;
    let boundsKey = '';

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
        markers = L.layerGroup().addTo(map);
    }

    // points: [{ index, name, lat, lon }]; active: index of the log in the editor.
    function update(points, active, total) {
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
                color: '#fff',
                weight: 2,
                fillColor: isActive ? '#d9480f' : '#1f5fa8',
                fillOpacity: 1,
            });
            marker.bindTooltip(p.name, { permanent: points.length <= 12, direction: 'right', offset: [8, 0], className: isActive ? 'map-label active' : 'map-label' });
            marker.on('click', () => onSelect(p.index));
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

    return { update, refresh };
}

// Great-circle distance between two { lat, lon } points, in km.
export function distanceKm(a, b) {
    const rad = Math.PI / 180;
    const dLat = (b.lat - a.lat) * rad;
    const dLon = (b.lon - a.lon) * rad;
    const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLon / 2) ** 2;
    return 2 * 6371 * Math.asin(Math.sqrt(h));
}
