// The 3D fence diagram: the borings as columns at their map positions, and
// between neighbouring borings (edges of a Delaunay triangulation) vertical
// panels drawn by the cross-section code (src/section.js), so a panel shows
// exactly what a 2D section between the two borings would.
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import Delaunator from 'delaunator';
import { renderSection } from '../src/section.js';
import { normalizeBoringLog } from '../src/normalize.js';

const TO_M = { m: 1, ft: 0.3048 };

// Positions in metres east (x) and north (y) of the borings' mean position.
export function localPositions(sites) {
    const lat0 = sites.reduce((s, p) => s + p.lat, 0) / sites.length;
    const lon0 = sites.reduce((s, p) => s + p.lon, 0) / sites.length;
    const k = Math.cos((lat0 * Math.PI) / 180);
    return sites.map(p => ({ x: (p.lon - lon0) * 111320 * k, y: (p.lat - lat0) * 110540 }));
}

// The pairs of borings joined by a panel: the edges of a Delaunay
// triangulation, leaving out edges much longer than the others (across the
// outside of a curved site). Borings in a line are joined in order.
export function fenceEdges(pos) {
    const n = pos.length;
    if (n < 2) return [];
    if (n === 2) return [[0, 1]];
    let edges = [];
    try {
        const d = Delaunator.from(pos, p => p.x, p => p.y);
        const seen = new Set();
        for (let t = 0; t < d.triangles.length; t += 3) {
            for (let e = 0; e < 3; e++) {
                const a = d.triangles[t + e];
                const b = d.triangles[t + ((e + 1) % 3)];
                const key = a < b ? `${a},${b}` : `${b},${a}`;
                if (!seen.has(key)) {
                    seen.add(key);
                    edges.push(a < b ? [a, b] : [b, a]);
                }
            }
        }
    } catch {
        edges = [];
    }
    if (!edges.length) {
        // Collinear: join in order along the line.
        const mx = pos.reduce((s, p) => s + p.x, 0) / n;
        const my = pos.reduce((s, p) => s + p.y, 0) / n;
        const far = pos.reduce((best, p) => (Math.hypot(p.x - mx, p.y - my) > Math.hypot(best.x - mx, best.y - my) ? p : best), pos[0]);
        const dir = { x: far.x - mx, y: far.y - my };
        const order = pos.map((p, i) => [i, (p.x - mx) * dir.x + (p.y - my) * dir.y]).sort((a, b) => a[1] - b[1]).map(([i]) => i);
        return order.slice(1).map((j, k) => [order[k], j]);
    }
    // Each boring keeps its edge to its nearest neighbour; other edges are left
    // out when they are more than 2.5 times the longer nearest-neighbour distance
    // of their two ends.
    const len = ([a, b]) => Math.hypot(pos[a].x - pos[b].x, pos[a].y - pos[b].y);
    const nearest = pos.map((_, i) => Math.min(...edges.filter(e => e.includes(i)).map(len)));
    return edges.filter(e => len(e) <= 2.5 * Math.max(nearest[e[0]], nearest[e[1]]) + 1e-6);
}

function svgToCanvas(svg, width, height) {
    return new Promise((resolve, reject) => {
        const img = new Image();
        const url = URL.createObjectURL(new Blob([svg], { type: 'image/svg+xml' }));
        img.onload = () => {
            const canvas = document.createElement('canvas');
            canvas.width = width;
            canvas.height = height;
            canvas.getContext('2d').drawImage(img, 0, 0, width, height);
            URL.revokeObjectURL(url);
            resolve(canvas);
        };
        img.onerror = () => {
            URL.revokeObjectURL(url);
            reject(new Error('panel image failed'));
        };
        img.src = url;
    });
}

export function textSprite(textValue, { size = 28, color = '#111', background = 'rgba(255,255,255,0.85)' } = {}) {
    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d');
    ctx.font = `bold ${size}px Arial, sans-serif`;
    const w = Math.ceil(ctx.measureText(textValue).width) + 16;
    canvas.width = w;
    canvas.height = size + 12;
    ctx.font = `bold ${size}px Arial, sans-serif`;
    ctx.fillStyle = background;
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.fillStyle = color;
    ctx.textBaseline = 'middle';
    ctx.fillText(textValue, 8, canvas.height / 2);
    const texture = new THREE.CanvasTexture(canvas);
    texture.colorSpace = THREE.SRGBColorSpace;
    const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: texture, depthTest: false }));
    sprite.userData.aspect = canvas.width / canvas.height;
    sprite.renderOrder = 10;
    return sprite;
}

export function setUpFence(container) {
    let renderer = null;
    let scene = null;
    let camera = null;
    let controls = null;
    let group = null;
    let key = '';
    let building = 0;

    function init() {
        renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
        renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));
        renderer.outputColorSpace = THREE.SRGBColorSpace;
        container.append(renderer.domElement);
        scene = new THREE.Scene();
        scene.background = new THREE.Color('#f4f6f8');
        camera = new THREE.PerspectiveCamera(40, 1, 1, 1e6);
        controls = new OrbitControls(camera, renderer.domElement);
        controls.enableDamping = false;
        controls.addEventListener('change', draw);
        new ResizeObserver(resize).observe(container);
        resize();
    }

    function resize() {
        if (!renderer) return;
        const w = Math.max(100, container.clientWidth);
        const h = Math.max(100, container.clientHeight);
        renderer.setSize(w, h, false);
        renderer.domElement.style.width = '100%';
        renderer.domElement.style.height = '100%';
        camera.aspect = w / h;
        camera.updateProjectionMatrix();
        draw();
    }

    function draw() {
        if (renderer) renderer.render(scene, camera);
    }

    function clear() {
        if (!group) return;
        group.traverse(o => {
            o.geometry?.dispose();
            if (o.material) {
                o.material.map?.dispose();
                o.material.dispose();
            }
        });
        scene.remove(group);
        group = null;
    }

    // sites: [{ name, lat, lon, doc }]; options: { ve, style }.
    // Returns { edges, ve, colours, byDepth } once drawn.
    async function show(sites, { ve = null, style = 'colour' } = {}) {
        if (!renderer) init();
        const newKey = JSON.stringify([sites.map(s => [s.name, s.lat, s.lon, s.text]), ve, style]);
        if (newKey === key && group) return show.last;
        key = newKey;
        const run = ++building;

        const docs = sites.map(s => normalizeBoringLog(s.doc));
        const pos = localPositions(sites);
        const depthM = docs.map(d => Math.max(0, ...d.layers.map(l => l.bottom)) * (TO_M[d.units.length] ?? 1));
        const elevM = docs.map(d => (typeof d.metadata.elevation === 'number' ? d.metadata.elevation * (TO_M[d.units.length] ?? 1) : null));
        const byDepth = elevM.some(e => e === null);
        const topOf = i => (byDepth ? 0 : elevM[i]);
        const top = Math.max(...sites.map((_, i) => topOf(i)));
        const bottom = Math.min(...sites.map((_, i) => topOf(i) - depthM[i]));
        const range = Math.max(1, top - bottom);
        const xs = pos.map(p => p.x);
        const ys = pos.map(p => p.y);
        const extent = Math.max(50, Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys));
        // Default vertical exaggeration: the deepest boring about a third of the site's width.
        const exag = ve ?? Math.max(1, Math.min(50, Math.round((0.35 * extent) / range)));
        const Y = v => (v - top) * exag; // level (m) -> scene y; ground at the top is 0

        const edges = fenceEdges(pos);
        const g = new THREE.Group();
        const colours = new Set();

        // Panels.
        for (const [a, b] of edges) {
            const dx = pos[b].x - pos[a].x;
            const dz = -(pos[b].y - pos[a].y);
            const L = Math.hypot(dx, dz);
            if (L < 0.5) continue;
            const H = range * exag;
            let hPx = 768;
            let wPx = Math.round((hPx * L) / H);
            if (wPx > 4096) {
                hPx = Math.max(96, Math.round((hPx * 4096) / wPx));
                wPx = 4096;
            }
            wPx = Math.max(64, wPx);
            let result;
            try {
                result = renderSection(
                    [{ doc: sites[a].doc, chainage: 0, name: sites[a].name }, { doc: sites[b].doc, chainage: L, name: sites[b].name }],
                    { units: 'm', style, by_depth: byDepth, column_width: Math.max(4, Math.round(hPx / 90)), font_size: Math.max(11, Math.round(hPx / 26)), id_prefix: `f${a}x${b}`, panel: { width: wPx, height: hPx, top: byDepth ? 0 : top, bottom: byDepth ? range : bottom } },
                );
            } catch {
                continue;
            }
            (result.colours ?? []).forEach(c => colours.add(c));
            let canvas;
            try {
                canvas = await svgToCanvas(result.svg, wPx, hPx);
            } catch {
                continue;
            }
            if (run !== building) return null;
            const texture = new THREE.CanvasTexture(canvas);
            texture.colorSpace = THREE.SRGBColorSpace;
            texture.anisotropy = renderer.capabilities.getMaxAnisotropy();
            const angle = Math.atan2(dz, dx);
            const geometry = new THREE.PlaneGeometry(L, H);
            const front = new THREE.Mesh(geometry, new THREE.MeshBasicMaterial({ map: texture, side: THREE.FrontSide }));
            // The back face shows the panel mirrored back, so its text reads from both sides.
            const backTexture = texture.clone();
            backTexture.wrapS = THREE.RepeatWrapping;
            backTexture.repeat.x = -1;
            backTexture.offset.x = 1;
            backTexture.needsUpdate = true;
            const back = new THREE.Mesh(geometry, new THREE.MeshBasicMaterial({ map: backTexture, side: THREE.BackSide }));
            for (const m of [front, back]) {
                m.position.set(pos[a].x + dx / 2, -H / 2, -pos[a].y + dz / 2);
                m.rotation.y = -angle;
                g.add(m);
            }
            const outline = new THREE.LineSegments(new THREE.EdgesGeometry(geometry), new THREE.LineBasicMaterial({ color: 0x555555 }));
            outline.position.copy(front.position);
            outline.rotation.copy(front.rotation);
            g.add(outline);
        }

        // Borings: dark columns with their names above.
        const radius = Math.max(0.4, extent * 0.004);
        sites.forEach((s, i) => {
            const y0 = Y(topOf(i));
            const y1 = Y(topOf(i) - depthM[i]);
            const column = new THREE.Mesh(new THREE.CylinderGeometry(radius, radius, Math.max(0.1, y0 - y1), 16), new THREE.MeshBasicMaterial({ color: 0x222222 }));
            column.position.set(pos[i].x, (y0 + y1) / 2, -pos[i].y);
            g.add(column);
            const label = textSprite(s.name);
            const hgt = extent * 0.035;
            label.scale.set(hgt * label.userData.aspect, hgt, 1);
            label.position.set(pos[i].x, y0 + hgt * 1.2, -pos[i].y);
            g.add(label);
        });

        // Ground: a faint grid at the top level, and a north arrow.
        const step = 10 ** Math.floor(Math.log10(extent / 2));
        const size = Math.ceil((extent * 1.4) / step) * step;
        const grid = new THREE.GridHelper(size, Math.round(size / step), 0xbbbbbb, 0xdddddd);
        grid.position.set((Math.max(...xs) + Math.min(...xs)) / 2, 0, -(Math.max(...ys) + Math.min(...ys)) / 2);
        g.add(grid);
        const north = textSprite('N ↑', { size: 32, color: '#b42318' });
        const nh = extent * 0.04;
        north.scale.set(nh * north.userData.aspect, nh, 1);
        north.position.set(grid.position.x - size / 2 + nh, 0, grid.position.z - size / 2 + nh);
        g.add(north);
        const gridNote = textSprite(`grid ${step >= 1000 ? `${step / 1000} km` : `${step} m`}`, { size: 22, color: '#555' });
        gridNote.scale.set(nh * 0.7 * gridNote.userData.aspect, nh * 0.7, 1);
        gridNote.position.set(grid.position.x + size / 2 - nh * 2, 0, grid.position.z + size / 2 - nh);
        g.add(gridNote);

        if (run !== building) return null;
        clear();
        group = g;
        scene.add(group);
        // Frame the site from the south-east, a little above.
        const cx = grid.position.x;
        const cz = grid.position.z;
        const depthY = range * exag;
        controls.target.set(cx, -depthY / 3, cz);
        const dist = extent * 1.4 + depthY;
        camera.position.set(cx + dist * 0.55, dist * 0.55, cz + dist * 0.75);
        camera.near = dist / 1000;
        camera.far = dist * 20;
        camera.updateProjectionMatrix();
        controls.update();
        draw();
        show.last = { edges: edges.length, ve: exag, colours: [...colours], byDepth };
        return show.last;
    }

    function snapshot() {
        return new Promise(resolve => {
            draw();
            renderer.domElement.toBlob(resolve, 'image/png');
        });
    }

    return { show, snapshot, resize };
}
