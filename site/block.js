// The 3D block model, in the style of Settle3's soil profile view: a box
// cut from the site, its layers as coloured solids (interpolated between the
// borings by src/model3d.js), the borings as columns coloured by their own
// layers, and the names of the layers in a legend rather than on the model.
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { buildModel } from '../src/model3d.js';
import { prepareBoring, colourClass, layerKey, SECTION_COLOURS } from '../src/section.js';
import { localPositions, neighbourEdges, textSprite } from './geometry3d.js';
import { FONT_FAMILY, measureText, wrapText, escapeXml } from '../src/text.js';
import { sliceProfile, clipToBox, renderSlice, MAX_SECTION_LENGTH } from '../src/slice.js';

const UNEXPLORED = '#eceff3';

function niceStep(raw) {
    const p = 10 ** Math.floor(Math.log10(raw));
    const f = raw / p;
    return (f <= 1 ? 1 : f <= 2 ? 2 : f <= 5 ? 5 : 10) * p;
}

// One layer as a closed solid: its top and bottom surfaces over the grid and
// walls on the four sides of the box. top(n), bottom(n): scene y at node n.
function solid(model, top, bottom, withBottom = false) {
    const { nx, ny, nodes } = model;
    const pos = [];
    const P = (n, y) => [nodes[n].x, y, -nodes[n].y];
    const id = (i, j) => j * (nx + 1) + i;
    const tri = (a, b, c) => pos.push(...a, ...b, ...c);
    const thin = ns => ns.every(n => top(n) - bottom(n) < 1e-4);
    for (let j = 0; j < ny; j++) {
        for (let i = 0; i < nx; i++) {
            const a = id(i, j), b = id(i + 1, j), c = id(i + 1, j + 1), d = id(i, j + 1);
            if (thin([a, b, c, d])) continue;
            // The top; a layer's bottom is the next layer's top, so only the
            // lowest solid has its own bottom face.
            tri(P(a, top(a)), P(b, top(b)), P(c, top(c)));
            tri(P(a, top(a)), P(c, top(c)), P(d, top(d)));
            if (withBottom) {
                tri(P(a, bottom(a)), P(c, bottom(c)), P(b, bottom(b)));
                tri(P(a, bottom(a)), P(d, bottom(d)), P(c, bottom(c)));
            }
        }
    }
    // Walls, facing out.
    const wall = (n0, n1) => {
        if (thin([n0, n1])) return;
        tri(P(n0, top(n0)), P(n0, bottom(n0)), P(n1, bottom(n1)));
        tri(P(n0, top(n0)), P(n1, bottom(n1)), P(n1, top(n1)));
    };
    for (let i = 0; i < nx; i++) {
        wall(id(i, 0), id(i + 1, 0));             // south
        wall(id(i + 1, ny), id(i, ny));           // north
    }
    for (let j = 0; j < ny; j++) {
        wall(id(nx, j), id(nx, j + 1));           // east
        wall(id(0, j + 1), id(0, j));             // west
    }
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    geometry.computeVertexNormals();
    return geometry;
}

// Lines along the four sides of the box at a surface (scene y at node n).
function perimeter(model, yAt) {
    const { nx, ny } = model;
    const id = (i, j) => j * (nx + 1) + i;
    const ring = [];
    for (let i = 0; i <= nx; i++) ring.push(id(i, 0));
    for (let j = 1; j <= ny; j++) ring.push(id(nx, j));
    for (let i = nx - 1; i >= 0; i--) ring.push(id(i, ny));
    for (let j = ny - 1; j >= 0; j--) ring.push(id(0, j));
    return ring.map(n => new THREE.Vector3(model.nodes[n].x, yAt(n), -model.nodes[n].y));
}

export function setUpBlock(container, legend) {
    let renderer = null;
    let scene = null;
    let camera = null;
    let controls = null;
    let group = null;
    let key = '';
    let state = null; // what the last show() drew, for the SVG and PNG exports
    // The slice: its ends A and A′ ({ x, y } in metres east and north) and which
    // side of it is cut away; null for none. While picking, `picking` holds the
    // first end (or true before it is clicked).
    let slice = null;
    let picking = null;
    let rubber = null;          // the line from A to the pointer while picking
    let onSlice = () => {};     // told about the slice: { svg, length, ... } or null, or { message }

    function init() {
        renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
        renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));
        renderer.outputColorSpace = THREE.SRGBColorSpace;
        renderer.localClippingEnabled = true;
        container.append(renderer.domElement);
        scene = new THREE.Scene();
        scene.background = new THREE.Color('#ffffff');
        scene.add(new THREE.HemisphereLight(0xffffff, 0x8a8a8a, 2.2));
        const sun = new THREE.DirectionalLight(0xffffff, 1.4);
        sun.position.set(0.6, 1, 0.8);
        scene.add(sun);
        camera = new THREE.PerspectiveCamera(35, 1, 1, 1e6);
        controls = new OrbitControls(camera, renderer.domElement);
        controls.addEventListener('change', () => {
            placeAxes();
            draw();
        });
        // Picking the slice's ends: a click (a press and release without dragging).
        let down = null;
        renderer.domElement.addEventListener('pointerdown', e => { down = { x: e.clientX, y: e.clientY }; });
        renderer.domElement.addEventListener('pointerup', e => {
            if (!picking || !down || Math.hypot(e.clientX - down.x, e.clientY - down.y) > 4 || e.button !== 0) return;
            const p = pick(e);
            if (p) pickPoint(p);
        });
        renderer.domElement.addEventListener('pointermove', e => {
            if (!picking || picking === true) return;
            const p = pick(e);
            if (p) drawRubber(picking, p);
        });
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
        rubber = null; // was in the group
    }

    // Axes on the edges of the box that face the camera (as in Settle3), moved
    // when the view turns far enough to show other sides: distance east along
    // the front bottom edge, distance north along the side bottom edge, and
    // depth (or elevation) up the outer corner, each with tick marks.
    function placeAxes() {
        if (!state || !group) return;
        const { model, Y, extent, range, top, bottomLevel } = state;
        const { box } = model;
        const cam = camera.position;
        const front = cam.z > -(box.y0 + box.y1) / 2 ? 'south' : 'north';
        const side = cam.x > (box.x0 + box.x1) / 2 ? 'east' : 'west';
        const key = `${front}|${side}`;
        if (key === state.axesKey && state.axes) return;
        if (state.axes) {
            state.axes.traverse(o => {
                o.geometry?.dispose();
                o.material?.map?.dispose();
                o.material?.dispose();
            });
            group.remove(state.axes);
        }
        state.axesKey = key;
        const axes = new THREE.Group();
        axes.userData.keep = true;
        const labels = [];
        const lines = [];
        const bY = Y(bottomLevel);
        const tickLen = extent * 0.015;
        const gap = extent * 0.045;
        const mat = new THREE.LineBasicMaterial({ color: 0x333333 });
        const seg = (p, q) => {
            lines.push([p, q]);
            axes.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints([p, q]), mat));
        };
        const label = (textValue, p, kind = 'tick') => {
            const sp = textSprite(textValue, { size: 24, color: '#333', background: 'rgba(255,255,255,0)' });
            const hgt = extent * (kind === 'title' ? 0.026 : 0.022);
            sp.scale.set(hgt * sp.userData.aspect, hgt, 1);
            sp.position.copy(p);
            sp.material.depthTest = true;
            axes.add(sp);
            labels.push({ text: textValue, at: p.clone(), kind, sprite: sp });
        };
        const V = (x, y, z) => new THREE.Vector3(x, y, z);
        // East: along the front bottom edge, labels outside it.
        const zF = front === 'south' ? -box.y0 : -box.y1;
        const out = front === 'south' ? 1 : -1;
        // The depth axis stands at the far end of that edge from the side axis.
        const xC = side === 'east' ? box.x0 : box.x1;
        const outC = side === 'east' ? -1 : 1;
        const hStep = niceStep((box.x1 - box.x0) / 5);
        for (let d = 0; d <= box.x1 - box.x0 + 1e-6; d += hStep) {
            const x = box.x0 + d;
            seg(V(x, bY, zF), V(x, bY, zF + out * tickLen));
            // Leave out the number at the depth axis's corner; the depth axis has its own.
            if (Math.abs(x - xC) > hStep * 0.3) label(`${Math.round(d)}`, V(x, bY - extent * 0.01, zF + out * gap));
        }
        label('E (m)', V((box.x0 + box.x1) / 2, bY - extent * 0.05, zF + out * gap * 2.4), 'title');
        // North: along the side bottom edge.
        const xS = side === 'east' ? box.x1 : box.x0;
        const outS = side === 'east' ? 1 : -1;
        const nStep = niceStep((box.y1 - box.y0) / 5);
        for (let d = 0; d <= box.y1 - box.y0 + 1e-6; d += nStep) {
            const z = -(box.y0 + d);
            seg(V(xS, bY, z), V(xS + outS * tickLen, bY, z));
            label(`${Math.round(d)}`, V(xS + outS * gap, bY - extent * 0.01, z));
        }
        label('N (m)', V(xS + outS * gap * 2.4, bY - extent * 0.05, -(box.y0 + box.y1) / 2), 'title');
        // Depth or elevation up the outer corner, labels outside it.
        const vStep = niceStep(range / 5);
        for (let v = 0; v <= range + 1e-6; v += vStep) {
            const y = Y(top - v);
            seg(V(xC, y, zF), V(xC + outC * tickLen, y, zF));
            label(model.byDepth ? `${v}` : `${(top - v).toFixed(vStep < 1 ? 1 : 0)}`, V(xC + outC * gap, y, zF));
        }
        label(model.byDepth ? 'Depth (m)' : 'Elevation (m)', V(xC + outC * gap, Y(top) + extent * 0.05, zF), 'title');
        state.axes = axes;
        state.axisLabels = labels;
        state.axisLines = lines;
        group.add(axes);
    }

    // sites: [{ name, lat, lon, doc, text }]; options: { ve, opacity }.
    function show(sites, { ve = null, opacity = 1 } = {}) {
        if (!renderer) init();
        const newKey = JSON.stringify([sites.map(s => [s.name, s.lat, s.lon, s.text]), ve, opacity]);
        if (newKey === key && group) return show.last;
        key = newKey;

        const borings = sites.map(s => ({ ...prepareBoring(s.doc), name: s.name }));
        const pos = localPositions(sites);
        const model = buildModel(borings, pos, neighbourEdges(pos), { nx: 48, ny: 48 });
        const { box } = model;
        const extent = Math.max(box.x1 - box.x0, box.y1 - box.y0);
        const top = Math.max(...model.ground);
        const bottomLevel = model.lowest;
        const range = Math.max(1, top - bottomLevel);
        const exag = ve ?? Math.max(1, Math.min(50, Math.round((0.3 * extent) / range)));
        const Y = level => (level - top) * exag;
        const g = new THREE.Group();
        const solids = [];  // the layer solids, for picking the slice's ends
        const transparent = opacity < 1;
        // Deeper layers are pushed back a little in depth, so where a layer thins
        // to nothing the one above it wins instead of flickering.
        const material = (colour, k) => new THREE.MeshLambertMaterial({
            color: colour, side: THREE.DoubleSide, transparent, opacity, depthWrite: !transparent,
            polygonOffset: true, polygonOffsetFactor: 1 + k * 0.5, polygonOffsetUnits: 1 + k * 4,
        });

        // Layers, and below them the part no boring reached.
        const L = model.layers.length;
        const topOf = (k, n) => Y(k < L ? model.nodes[n].tops[k] : model.nodes[n].base);
        model.layers.forEach((layer, k) => {
            const mesh = new THREE.Mesh(solid(model, n => topOf(k, n), n => topOf(k + 1, n)), material(layer.fill, k));
            solids.push(mesh);
            g.add(mesh);
        });
        const unexplored = new THREE.Mesh(solid(model, n => topOf(L, n), () => Y(bottomLevel), true), material(UNEXPLORED, L));
        solids.push(unexplored);
        g.add(unexplored);

        // Outlines: each layer boundary along the sides, the box edges.
        const lineMat = new THREE.LineBasicMaterial({ color: 0x333333 });
        for (let k = 1; k <= L; k++) g.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints(perimeter(model, n => topOf(k, n))), lineMat));
        g.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints(perimeter(model, n => topOf(0, n))), new THREE.LineBasicMaterial({ color: 0x000000 })));
        g.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints(perimeter(model, () => Y(bottomLevel))), new THREE.LineBasicMaterial({ color: 0x000000 })));
        const corners = [[box.x0, box.y0], [box.x1, box.y0], [box.x1, box.y1], [box.x0, box.y1]];
        const cornerNode = [[0, 0], [model.nx, 0], [model.nx, model.ny], [0, model.ny]].map(([i, j]) => j * (model.nx + 1) + i);
        corners.forEach(([x, y], c) => {
            const pts = [new THREE.Vector3(x, topOf(0, cornerNode[c]), -y), new THREE.Vector3(x, Y(bottomLevel), -y)];
            g.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints(pts), new THREE.LineBasicMaterial({ color: 0x000000 })));
        });

        // Water table: a dashed blue line around the sides, and a light surface
        // inside when the layers are see-through.
        if (model.water) {
            const water = new THREE.Line(new THREE.BufferGeometry().setFromPoints(perimeter(model, n => Y(model.water[n]))), new THREE.LineDashedMaterial({ color: 0x1f5fa8, dashSize: extent / 60, gapSize: extent / 120 }));
            water.computeLineDistances();
            g.add(water);
            if (transparent) {
                const surf = solid(model, n => Y(model.water[n]) + 0.001, n => Y(model.water[n]));
                g.add(new THREE.Mesh(surf, new THREE.MeshBasicMaterial({ color: 0x5b9be6, transparent: true, opacity: 0.25, depthWrite: false, side: THREE.DoubleSide })));
            }
        }

        // Borings: columns coloured by their own layers, drawn over the model so
        // they always show, with a stem and name above the ground. Their
        // materials are marked transparent (at full opacity) so they are drawn
        // in the same pass as see-through layers, after them.
        const radius = Math.max(0.5, extent * 0.006);
        const labels = [];   // every text label: { text, at (scene position), kind, sprite }
        const columns = [];  // the boring columns, for the SVG
        const slicedBorings = []; // the borings as the 2D slice draws them (levels in metres)
        borings.forEach((b, i) => {
            const groundY = Y(model.byDepth ? 0 : b.elev);
            // Each layer in its model layer's colour, so the columns match the block.
            const unitOf = new Map(b.units.flatMap(u => u.layers.map(l => [l, u])));
            for (const l of b.layers) {
                const k = model.unitLayer.get(unitOf.get(l));
                const key2 = colourClass(layerKey(l));
                const colour = k !== undefined ? model.layers[k].fill : key2 ? SECTION_COLOURS[key2].fill : '#ffffff';
                const h = Math.max(0.05, (l.bottom - l.top) * exag);
                const seg = new THREE.Mesh(new THREE.CylinderGeometry(radius, radius, h, 20), new THREE.MeshBasicMaterial({ color: colour, depthTest: false, transparent: true }));
                seg.position.set(pos[i].x, groundY - (l.top * exag) - h / 2, -pos[i].y);
                seg.renderOrder = 5;
                g.add(seg);
            }
            const outline = new THREE.Mesh(new THREE.CylinderGeometry(radius * 1.25, radius * 1.25, b.depth * exag, 20, 1, true), new THREE.MeshBasicMaterial({ color: 0x111111, side: THREE.BackSide, depthTest: false, transparent: true }));
            outline.position.set(pos[i].x, groundY - (b.depth * exag) / 2, -pos[i].y);
            outline.renderOrder = 4;
            g.add(outline);
            const stemH = extent * 0.05;
            const stem = new THREE.Mesh(new THREE.CylinderGeometry(radius * 0.4, radius * 0.4, stemH, 8), new THREE.MeshBasicMaterial({ color: 0x111111 }));
            stem.position.set(pos[i].x, groundY + stemH / 2, -pos[i].y);
            g.add(stem);
            const label = textSprite(b.name, { size: 30 });
            const hgt = extent * 0.03;
            label.scale.set(hgt * label.userData.aspect, hgt, 1);
            label.position.set(pos[i].x, groundY + stemH + hgt * 0.7, -pos[i].y);
            g.add(label);
            labels.push({ text: b.name, at: label.position.clone(), kind: 'name', sprite: label });
            const groundLevel = model.byDepth ? 0 : b.elev;
            slicedBorings.push({ name: b.name, x: pos[i].x, y: pos[i].y, ground: groundLevel, segments: b.layers.map(l => {
                const k = model.unitLayer.get(unitOf.get(l));
                const key2 = colourClass(layerKey(l));
                return { top: groundLevel - l.top, bottom: groundLevel - l.bottom, fill: k !== undefined ? model.layers[k].fill : key2 ? SECTION_COLOURS[key2].fill : '#ffffff' };
            }) });
            columns.push({ x: pos[i].x, z: -pos[i].y, groundY, stemH, segments: b.layers.map(l => {
                const k = model.unitLayer.get(unitOf.get(l));
                const key2 = colourClass(layerKey(l));
                return { top: groundY - l.top * exag, bottom: groundY - l.bottom * exag, colour: k !== undefined ? model.layers[k].fill : key2 ? SECTION_COLOURS[key2].fill : '#ffffff' };
            }) });
        });

        clear();
        group = g;
        scene.add(group);
        const cx = (box.x0 + box.x1) / 2;
        const cz = -(box.y0 + box.y1) / 2;
        const depthY = range * exag;
        controls.target.set(cx, -depthY / 2, cz);
        const dist = extent * 1.3 + depthY;
        camera.position.set(cx + dist * 0.6, dist * 0.5, cz + dist * 0.8);
        camera.near = dist / 1000;
        camera.far = dist * 20;
        camera.updateProjectionMatrix();
        controls.update();
        draw();

        // Legend: the layers from the top, with their materials.
        // One entry per material: layers with the same name (e.g. two silt layers
        // at different depths) share a colour and an entry.
        const seen = new Set();
        const entries = model.layers.filter(l => !seen.has(l.label) && seen.add(l.label))
            .map(l => ({ fill: l.fill, label: l.label, more: model.layers.filter(m => m.label === l.label).length > 1 }));
        entries.push({ fill: UNEXPLORED, label: 'Not explored (below the borings)' });
        if (model.water) entries.push({ water: true, label: 'Groundwater (first reading in each boring, interpolated)' });
        const notes = [];
        if (model.layers.some(l => l.guessed.size)) notes.push('* Symbol guessed: the log gives a value that is not a USCS symbol.');
        if (model.byDepth) notes.push('No ground elevations are given for these borings, so the model aligns them at the ground surface. Where the ground is not level, the true layer boundaries between borings lie higher or lower than shown; only the layers in each boring are as logged.');
        notes.push(`${borings.length} borings · box ${Math.round(box.x1 - box.x0)} × ${Math.round(box.y1 - box.y0)} m · vertical exaggeration ×${exag}${model.byDepth ? '' : ''}. Layer thicknesses are interpolated by inverse distance between borings correlated as in the cross-sections; layers missing in a boring thin out to it. An interpretation, not a geologic model.`);
        legend.innerHTML = `<h4>Layers, from the top</h4><ol>${entries.map(e => `<li><i${e.water ? ' class="water"' : ` style="background:${e.fill}"`}></i><span>${escapeHtml(e.label)}${e.more ? ' <em class="muted">(more than one layer)</em>' : ''}</span></li>`).join('')}</ol>`
            + notes.map(n => `<p class="muted small-note">${escapeHtml(n)}</p>`).join('');
        state = { model, exag, Y, topOf, L, bottomLevel, extent, opacity, labels, columns, entries, notes, range, top, axes: null, axesKey: '', solids, slicedBorings, sliceGroup: null };
        placeAxes();
        applySlice();
        draw();
        show.last = { ve: exag, layers: model.layers.length };
        return show.last;
    }

    // ---------------------------------------------------------- slice
    // A vertical cut through the block along a line picked on the model: the
    // block on one side of it is cut away, the cut face shows the layers, and
    // the slice between the two picked points is drawn as a 2D section.

    // The point of the model under the pointer, { x, y } in metres; null off it.
    function pick(e) {
        if (!state) return null;
        const rect = renderer.domElement.getBoundingClientRect();
        const ndc = new THREE.Vector2(((e.clientX - rect.left) / rect.width) * 2 - 1, -((e.clientY - rect.top) / rect.height) * 2 + 1);
        const ray = new THREE.Raycaster();
        ray.setFromCamera(ndc, camera);
        const plane = slice ? state.clipPlane : null;
        const hit = ray.intersectObjects(state.solids, false).find(h => !plane || plane.distanceToPoint(h.point) >= -1e-6);
        if (!hit) return null;
        const { box } = state.model;
        return { x: Math.min(box.x1, Math.max(box.x0, hit.point.x)), y: Math.min(box.y1, Math.max(box.y0, -hit.point.z)) };
    }

    const sceneAt = (p, lift = 0) => {
        const at = sliceProfile(state.model, p, p, 1).points[0];
        return new THREE.Vector3(p.x, state.Y(at.ground) + lift, -p.y);
    };

    function drawRubber(a, b) {
        if (rubber) {
            group.remove(rubber);
            rubber.geometry.dispose();
            rubber.material.dispose();
        }
        const lift = state.extent * 0.004;
        const pts = sliceProfile(state.model, a, b, 40).points.map(p => new THREE.Vector3(p.x, state.Y(p.ground) + lift, -p.y));
        rubber = new THREE.Line(new THREE.BufferGeometry().setFromPoints(pts), new THREE.LineDashedMaterial({ color: 0xd9480f, dashSize: state.extent / 80, gapSize: state.extent / 160, depthTest: false }));
        rubber.computeLineDistances();
        rubber.renderOrder = 20;
        group.add(rubber);
        draw();
    }

    function stopPicking() {
        picking = null;
        container.classList.remove('picking');
        if (rubber) {
            group?.remove(rubber);
            rubber.geometry.dispose();
            rubber.material.dispose();
            rubber = null;
        }
        draw();
    }

    function pickPoint(p) {
        if (picking === true) {
            picking = p;
            drawRubber(p, p);
            return;
        }
        const a = picking;
        const length = Math.hypot(p.x - a.x, p.y - a.y);
        if (length < state.extent * 0.01) return; // the same point again
        if (length > MAX_SECTION_LENGTH) {
            onSlice({ message: `A slice can be at most ${MAX_SECTION_LENGTH / 1000} km long; this one would be ${(length / 1000).toFixed(1)} km. Click a nearer second point.` });
            return;
        }
        stopPicking();
        // Cut away the side nearer the camera, so the cut face is seen.
        slice = { a, b: p, flip: false };
        const n = normalOf(slice);
        const cam = camera.position;
        const toCam = (cam.x - a.x) * n.x + (cam.z + a.y) * n.z;
        slice.flip = toCam > 0;
        applySlice();
        draw();
    }

    // Horizontal normal of the slice's plane, in scene coordinates.
    function normalOf(s) {
        const dx = s.b.x - s.a.x;
        const dz = -(s.b.y - s.a.y);
        const len = Math.hypot(dx, dz) || 1;
        return { x: dz / len, z: -dx / len };
    }

    // Clips the block, borings and outlines; not the axes or the slice itself.
    function setClipping(planes) {
        const visit = o => {
            if (o.userData.keep) return;
            if (o.material) {
                o.material.clippingPlanes = planes;
                o.material.needsUpdate = true;
            }
            o.children.forEach(visit);
        };
        if (group) visit(group);
    }

    // Draws the slice (or removes it): the cut, the cut face over the whole
    // chord of the block, the line A–A′ on the ground and its ends; and tells
    // the page the 2D section.
    function applySlice() {
        if (!state || !group) return;
        if (state.sliceGroup) {
            state.sliceGroup.traverse(o => {
                o.geometry?.dispose();
                o.material?.map?.dispose();
                o.material?.dispose();
            });
            group.remove(state.sliceGroup);
            state.sliceGroup = null;
        }
        state.clipPlane = null;
        setClipping([]);
        if (!slice) return;
        const { model, Y, L, bottomLevel, extent } = state;
        const chord = clipToBox(model.box, ...extend(slice.a, slice.b, model.box));
        if (!chord) {
            slice = null;
            onSlice(null);
            return;
        }
        const n = normalOf(slice);
        const sign = slice.flip ? -1 : 1;
        const normal = new THREE.Vector3(sign * n.x, 0, sign * n.z);
        const plane = new THREE.Plane(normal, -normal.dot(new THREE.Vector3(slice.a.x, 0, -slice.a.y)));
        state.clipPlane = plane;
        setClipping([plane]);

        const sg = new THREE.Group();
        sg.userData.keep = true;
        const profile = sliceProfile(model, chord[0], chord[1], 160).points;
        const levelOf = (p, k) => (k < L ? p.tops[k] : k === L ? p.base : bottomLevel);
        const P = (p, level) => [p.x, Y(level), -p.y];
        for (let k = 0; k <= L; k++) {
            const pos = [];
            for (let q = 1; q < profile.length; q++) {
                const p0 = profile[q - 1];
                const p1 = profile[q];
                const t0 = levelOf(p0, k), b0 = levelOf(p0, k + 1), t1 = levelOf(p1, k), b1 = levelOf(p1, k + 1);
                if (t0 - b0 < 1e-4 && t1 - b1 < 1e-4) continue;
                pos.push(...P(p0, t0), ...P(p0, b0), ...P(p1, b1), ...P(p0, t0), ...P(p1, b1), ...P(p1, t1));
            }
            if (!pos.length) continue;
            const geo = new THREE.BufferGeometry();
            geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
            const fill = k < L ? model.layers[k].fill : UNEXPLORED;
            sg.add(new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ color: fill, side: THREE.DoubleSide, polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -2 })));
        }
        const lineMat = color => new THREE.LineBasicMaterial({ color });
        for (let k = 1; k <= L; k++) sg.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints(profile.map(p => new THREE.Vector3(...P(p, levelOf(p, k))))), lineMat(0x444444)));
        sg.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints(profile.map(p => new THREE.Vector3(...P(p, p.ground)))), lineMat(0x000000)));
        if (model.water) {
            const w = new THREE.Line(new THREE.BufferGeometry().setFromPoints(profile.map(p => new THREE.Vector3(...P(p, p.water)))), new THREE.LineDashedMaterial({ color: 0x1f5fa8, dashSize: extent / 60, gapSize: extent / 120 }));
            w.computeLineDistances();
            sg.add(w);
        }
        // A–A′ on the ground, in orange, and its ends.
        const lift = extent * 0.004;
        const ab = sliceProfile(model, slice.a, slice.b, 40).points.map(p => new THREE.Vector3(p.x, Y(p.ground) + lift, -p.y));
        const abLine = new THREE.Line(new THREE.BufferGeometry().setFromPoints(ab), new THREE.LineBasicMaterial({ color: 0xd9480f, depthTest: false }));
        abLine.renderOrder = 20;
        sg.add(abLine);
        for (const [p, name] of [[slice.a, 'A'], [slice.b, 'A′']]) {
            const at = sceneAt(p, extent * 0.04);
            const label = textSprite(name, { size: 30, color: '#d9480f' });
            const hgt = extent * 0.03;
            label.scale.set(hgt * label.userData.aspect, hgt, 1);
            label.position.copy(at);
            sg.add(label);
            const tick = new THREE.Line(new THREE.BufferGeometry().setFromPoints([sceneAt(p), at]), new THREE.LineBasicMaterial({ color: 0xd9480f, depthTest: false }));
            tick.renderOrder = 20;
            sg.add(tick);
        }
        state.sliceGroup = sg;
        group.add(sg);
        onSlice(renderSlice(model, slice.a, slice.b, { borings: state.slicedBorings, corridor: Math.max(10, extent * 0.05), title: 'Slice A–A′ through the 3D model' }));
    }

    // The line through a and b, extended well past the box (clipped to it after).
    function extend(a, b, box) {
        const far = 4 * Math.max(box.x1 - box.x0, box.y1 - box.y0);
        const len = Math.hypot(b.x - a.x, b.y - a.y) || 1;
        const ux = (b.x - a.x) / len;
        const uy = (b.y - a.y) / len;
        return [{ x: a.x - ux * far, y: a.y - uy * far }, { x: b.x + ux * far, y: b.y + uy * far }];
    }

    function startSlice() {
        if (!state) return;
        picking = true;
        container.classList.add('picking');
    }
    function clearSlice() {
        stopPicking();
        slice = null;
        applySlice();
        draw();
        onSlice(null);
    }
    function flipSlice() {
        if (!slice) return;
        slice.flip = !slice.flip;
        applySlice();
        draw();
    }

    // ---------------------------------------------------------- exports
    // Both exports are the current view (camera, exaggeration, opacity) at the
    // size it has on screen, with the legend below it. Text is drawn as vector
    // text in both, so it stays sharp at any scale.

    const size = () => ({ W: Math.max(100, container.clientWidth), H: Math.max(100, container.clientHeight) });

    // Scene position -> pixel position in the view.
    function projector(W, H) {
        camera.updateMatrixWorld();
        const v = new THREE.Vector3();
        return (x, y, z) => {
            v.set(x, y, z).project(camera);
            return [(v.x + 1) / 2 * W, (1 - v.y) / 2 * H, v.z];
        };
    }

    const r1 = n => Math.round(n * 10) / 10;
    const pts = list => list.map(([x, y]) => `${r1(x)},${r1(y)}`).join(' ');

    // The boring names and axis numbers, as SVG text.
    // Whether the block hides a point from the camera.
    function hidden(at) {
        const solids = group.children.filter(o => o.isMesh && o.material?.isMeshLambertMaterial);
        const dir = at.clone().sub(camera.position);
        const dist = dir.length();
        const hit = new THREE.Raycaster(camera.position.clone(), dir.normalize(), 0, dist).intersectObjects(solids, false)[0];
        return Boolean(hit && hit.distance < dist * 0.995);
    }

    function overlaySvg(W, H) {
        const P = projector(W, H);
        const out = [];
        for (const l of [...state.labels, ...(state.axisLabels ?? [])]) {
            const [x, y, z] = P(l.at.x, l.at.y, l.at.z);
            if (z > 1) continue; // behind the camera
            // Axis numbers the block covers are hidden in the view, so leave them out.
            if (l.kind !== 'name' && hidden(l.at)) continue;
            if (l.kind === 'name') {
                const w = measureText(l.text, 12, true) + 8;
                out.push(`<rect x="${r1(x - w / 2)}" y="${r1(y - 9)}" width="${r1(w)}" height="18" fill="#fff" fill-opacity="0.85"/>`
                    + `<text x="${r1(x)}" y="${r1(y + 4)}" text-anchor="middle" font-size="12" font-weight="bold" fill="#111">${escapeXml(l.text)}</text>`);
            } else if (l.kind === 'north') {
                out.push(`<text x="${r1(x)}" y="${r1(y + 5)}" text-anchor="middle" font-size="16" font-weight="bold" fill="#b42318">${escapeXml(l.text)}</text>`);
            } else {
                const bold = l.kind === 'title';
                out.push(`<text x="${r1(x)}" y="${r1(y + 4)}" text-anchor="middle" font-size="${bold ? 12 : 11}"${bold ? ' font-weight="bold"' : ''} fill="#333">${escapeXml(l.text)}</text>`);
            }
        }
        return out.join('');
    }

    // The legend as SVG, below the view; returns { svg, height }.
    function legendSvg(W, y0) {
        const pad = 12;
        const cols = W >= 640 ? 2 : 1;
        const colW = (W - 2 * pad) / cols;
        const out = [`<text x="${pad}" y="${y0 + 18}" font-size="13" font-weight="bold">Layers, from the top</text>`];
        const rows = [];
        for (const e of state.entries) {
            const text = e.label + (e.more ? ' (more than one layer)' : '');
            rows.push({ e, lines: wrapText(text, colW - 40, 12) });
        }
        const perCol = Math.ceil(rows.length / cols);
        let bottom = y0 + 26;
        for (let c = 0; c < cols; c++) {
            let y = y0 + 28;
            for (const { e, lines } of rows.slice(c * perCol, (c + 1) * perCol)) {
                const x = pad + c * colW;
                out.push(e.water
                    ? `<line x1="${x}" y1="${y + 7}" x2="${x + 24}" y2="${y + 7}" stroke="#1f5fa8" stroke-width="2" stroke-dasharray="5 3"/>`
                    : `<rect x="${x}" y="${y + 1}" width="24" height="12" fill="${e.fill}" stroke="#333" stroke-width="0.8"/>`);
                lines.forEach((t, i) => out.push(`<text x="${x + 32}" y="${y + 11 + i * 15}" font-size="12">${escapeXml(t)}</text>`));
                y += Math.max(1, lines.length) * 15 + 4;
            }
            bottom = Math.max(bottom, y);
        }
        let y = bottom + 4;
        for (const n of state.notes) {
            for (const t of wrapText(n, W - 2 * pad, 11)) {
                out.push(`<text x="${pad}" y="${y + 11}" font-size="11" fill="#555">${escapeXml(t)}</text>`);
                y += 14;
            }
            y += 3;
        }
        return { svg: out.join(''), height: y + pad - y0 };
    }

    // The block as SVG polygons: the faces that face the camera (the ground
    // and two or three sides), shaded like the 3D view, then the outlines,
    // water table and borings.
    function modelSvg(W, H) {
        const { model, Y, topOf, L, bottomLevel, opacity, columns } = state;
        const { nx, ny, nodes, box } = model;
        const P = projector(W, H);
        const cam = camera.position;
        const id = (i, j) => j * (nx + 1) + i;
        const sun = new THREE.Vector3(0.6, 1, 0.8).normalize();
        const lit = (hex, n) => {
            // Hemisphere light plus the sun, as in the view, without colour management.
            const k = Math.min(1.15, 0.62 + 0.25 * (n.y + 1) / 2 + 0.38 * Math.max(0, n.dot(sun)));
            const c = new THREE.Color(hex);
            return `#${c.multiplyScalar(k).getHexString()}`;
        };
        const fo = opacity < 1 ? ` fill-opacity="${opacity}"` : '';
        const out = [];
        const bY = Y(bottomLevel);
        const levelOf = (k, n) => (k <= L ? topOf(k, n) : bY);
        // The four sides: their nodes in order (outside on the left of the walk) and outward normals.
        const walls = {
            south: { nodes: Array.from({ length: nx + 1 }, (_, i) => id(i, 0)), n: new THREE.Vector3(0, 0, 1), at: [box.x0, -box.y0] },
            east: { nodes: Array.from({ length: ny + 1 }, (_, j) => id(nx, j)), n: new THREE.Vector3(1, 0, 0), at: [box.x1, -box.y0] },
            north: { nodes: Array.from({ length: nx + 1 }, (_, i) => id(nx - i, ny)), n: new THREE.Vector3(0, 0, -1), at: [box.x1, -box.y1] },
            west: { nodes: Array.from({ length: ny + 1 }, (_, j) => id(0, ny - j)), n: new THREE.Vector3(-1, 0, 0), at: [box.x0, -box.y1] },
        };
        const midY = (topOf(0, 0) + bY) / 2;
        for (const w of Object.values(walls)) w.visible = w.n.dot(new THREE.Vector3(cam.x - w.at[0], cam.y - midY, cam.z - w.at[1])) > 0;
        const xy = n => [nodes[n].x, -nodes[n].y];

        for (const w of Object.values(walls)) {
            if (!w.visible) continue;
            for (let k = 0; k <= L; k++) {
                const top = w.nodes.map(n => levelOf(k, n));
                const bot = w.nodes.map(n => levelOf(k + 1, n));
                if (top.every((t, i) => t - bot[i] < 1e-4)) continue;
                const ring = [...w.nodes.map((n, i) => P(xy(n)[0], top[i], xy(n)[1])), ...w.nodes.map((n, i) => P(xy(n)[0], bot[i], xy(n)[1])).reverse()];
                const fill = lit(k < L ? model.layers[k].fill : UNEXPLORED, w.n);
                out.push(`<polygon points="${pts(ring)}" fill="${fill}"${fo} stroke="${fill}" stroke-width="0.4"/>`);
            }
        }
        // The ground: each cell in the colour of the top layer there, one path per colour.
        const groundUp = cam.y > Math.min(...nodes.map((_, n) => topOf(0, n)));
        if (groundUp) {
            const paths = new Map();
            for (let j = 0; j < ny; j++) {
                for (let i = 0; i < nx; i++) {
                    const cell = [id(i, j), id(i + 1, j), id(i + 1, j + 1), id(i, j + 1)];
                    let k = 0;
                    while (k < L && cell.reduce((s, n) => s + topOf(k, n) - topOf(k + 1, n), 0) / 4 < 1e-3) k++;
                    const [a, b, c] = cell.map(n => new THREE.Vector3(xy(n)[0], topOf(0, n), xy(n)[1]));
                    const normal = new THREE.Vector3().subVectors(b, a).cross(new THREE.Vector3().subVectors(c, a)).normalize();
                    if (normal.y < 0) normal.negate();
                    const fill = lit(k < L ? model.layers[k].fill : UNEXPLORED, normal);
                    const ring = cell.map(n => P(xy(n)[0], topOf(0, n), xy(n)[1]));
                    if (!paths.has(fill)) paths.set(fill, []);
                    paths.get(fill).push(`M${ring.map(([x, y]) => `${r1(x)} ${r1(y)}`).join('L')}Z`);
                }
            }
            for (const [fill, d] of paths) out.push(`<path d="${d.join('')}" fill="${fill}"${fo} stroke="${fill}" stroke-width="0.4"/>`);
        }
        // Outlines: layer boundaries on the visible sides, the ground's edge all round,
        // the bottom edge and the box corners where a visible side meets them.
        const line = (list, stroke, width, extra = '') => out.push(`<polyline points="${pts(list)}" fill="none" stroke="${stroke}" stroke-width="${width}" stroke-linejoin="round"${extra}/>`);
        for (const w of Object.values(walls)) {
            const along = level => w.nodes.map(n => P(xy(n)[0], level(n), xy(n)[1]));
            if (groundUp || w.visible) line(along(n => topOf(0, n)), '#000', 1);
            if (!w.visible) continue;
            for (let k = 1; k <= L; k++) line(along(n => topOf(k, n)), '#333', 0.6);
            line(along(() => bY), '#000', 1);
            if (model.water) line(along(n => Y(model.water[n])), '#1f5fa8', 1.4, ' stroke-dasharray="7 4"');
        }
        const corner = [[0, 0, 'south', 'west'], [nx, 0, 'south', 'east'], [nx, ny, 'north', 'east'], [0, ny, 'north', 'west']];
        for (const [i, j, a, b] of corner) {
            if (!walls[a].visible && !walls[b].visible) continue;
            const n = id(i, j);
            line([P(xy(n)[0], topOf(0, n), xy(n)[1]), P(xy(n)[0], bY, xy(n)[1])], '#000', 1);
        }
        // Axis tick marks.
        for (const [p, q] of state.axisLines ?? []) line([P(p.x, p.y, p.z), P(q.x, q.y, q.z)], '#333', 0.8);
        // Borings, over the model as in the view.
        for (const c of columns) {
            const top = P(c.x, c.groundY, c.z);
            const bottom = P(c.x, c.segments.length ? c.segments[c.segments.length - 1].bottom : c.groundY, c.z);
            line([top, bottom], '#111', 9, ' stroke-linecap="butt"');
            for (const sgm of c.segments) line([P(c.x, sgm.top, c.z), P(c.x, sgm.bottom, c.z)], sgm.colour, 6.5, ' stroke-linecap="butt"');
            line([top, P(c.x, c.groundY + c.stemH, c.z)], '#111', 1.6);
        }
        return out.join('');
    }

    // The part of the view with something in it (the block, borings and
    // labels), with a margin: { x, y, w, h } in view pixels.
    function contentBox(W, H) {
        const { model, topOf, Y, bottomLevel, columns, labels } = state;
        const P = projector(W, H);
        const xs = [];
        const ys = [];
        const add = ([x, y], dx = 0, dy = 0) => { xs.push(x - dx, x + dx); ys.push(y - dy, y + dy); };
        model.nodes.forEach((n, i) => {
            add(P(n.x, topOf(0, i), -n.y));
            add(P(n.x, Y(bottomLevel), -n.y));
        });
        for (const c of columns) add(P(c.x, c.groundY + c.stemH, c.z));
        for (const l of [...labels, ...(state.axisLabels ?? [])]) add(P(l.at.x, l.at.y, l.at.z), measureText(l.text, 16, true) / 2 + 4, 12);
        const pad = 16;
        const x0 = Math.max(0, Math.min(...xs) - pad);
        const y0 = Math.max(0, Math.min(...ys) - pad);
        const x1 = Math.min(W, Math.max(...xs) + pad);
        const y1 = Math.min(H, Math.max(...ys) + pad);
        return { x: Math.floor(x0), y: Math.floor(y0), w: Math.ceil(x1 - x0), h: Math.ceil(y1 - y0) };
    }

    // The figure: the view cropped to its content (body and labels drawn in
    // view pixels), and the legend below. Returns { svg, crop, width, height }.
    function figure(W, H, body, labelsToo = true) {
        const crop = contentBox(W, H);
        const width = Math.max(crop.w, 420);
        const dx = (width - crop.w) / 2 - crop.x;
        const lg = legendSvg(width, crop.h);
        const total = Math.ceil(crop.h + lg.height);
        return {
            crop: { ...crop, dx },
            width,
            height: total,
            svg: `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${total}" viewBox="0 0 ${width} ${total}" font-family="${escapeXml(FONT_FAMILY)}">`
                + `<rect width="100%" height="100%" fill="#fff"/><g transform="translate(${r1(dx)} ${-crop.y})">${body}${labelsToo ? overlaySvg(W, H) : ''}</g>`
                + `<line x1="0" y1="${crop.h}" x2="${width}" y2="${crop.h}" stroke="#ddd"/>${lg.svg}</svg>`,
        };
    }

    // The view as an SVG drawing (vector), with the legend.
    function toSvg() {
        if (!state) return null;
        const { W, H } = size();
        return figure(W, H, modelSvg(W, H)).svg;
    }

    // The view as a PNG at scale × its size on screen (capped by what the
    // graphics card can draw), with the legend. The model is drawn again by
    // WebGL at that resolution; the text and legend are vector, so they are sharp.
    async function toPng(scale = 2) {
        if (!state) return null;
        const { W, H } = size();
        const gl = renderer.getContext();
        const maxSide = Math.min(gl.getParameter(gl.MAX_RENDERBUFFER_SIZE), gl.getParameter(gl.MAX_VIEWPORT_DIMS)[0], 8192);
        const s = Math.max(0.5, Math.min(scale, maxSide / W, maxSide / H));
        const ratio = renderer.getPixelRatio();
        const sprites = [...state.labels, ...(state.axisLabels ?? [])].map(l => l.sprite);
        for (const sp of sprites) sp.visible = false;
        let model;
        try {
            renderer.setPixelRatio(s);
            renderer.setSize(W, H, false);
            renderer.render(scene, camera);
            model = document.createElement('canvas');
            model.width = renderer.domElement.width;
            model.height = renderer.domElement.height;
            model.getContext('2d').drawImage(renderer.domElement, 0, 0);
        } finally {
            for (const sp of sprites) sp.visible = true;
            renderer.setPixelRatio(ratio);
            resize();
        }
        // The white page and legend (SVG), the model in its place, then the labels over it.
        const fig = figure(W, H, '', false);
        const { crop } = fig;
        const canvas = document.createElement('canvas');
        canvas.width = Math.round(fig.width * s);
        canvas.height = Math.round(fig.height * s);
        const ctx = canvas.getContext('2d');
        const drawSvg = async (svg, x, y, w, h) => {
            // Sized in output pixels, so it is rasterised sharp.
            const sized = svg.replace(/^<svg ([^>]*?)width="[^"]*" height="[^"]*"/, `<svg $1width="${Math.round(w)}" height="${Math.round(h)}"`);
            const url = URL.createObjectURL(new Blob([sized], { type: 'image/svg+xml' }));
            try {
                const img = new Image();
                img.src = url;
                await img.decode();
                ctx.drawImage(img, x, y, Math.round(w), Math.round(h));
            } finally {
                URL.revokeObjectURL(url);
            }
        };
        await drawSvg(fig.svg, 0, 0, canvas.width, canvas.height);
        const k = model.width / W; // the model's actual pixels per view pixel
        ctx.drawImage(model, crop.x * k, crop.y * k, crop.w * k, crop.h * k, (crop.x + crop.dx) * s, 0, crop.w * s, crop.h * s);
        const overlay = `<svg xmlns="http://www.w3.org/2000/svg" width="${fig.width}" height="${crop.h}" viewBox="0 0 ${fig.width} ${crop.h}" font-family="${escapeXml(FONT_FAMILY)}"><g transform="translate(${r1(crop.dx)} ${-crop.y})">${overlaySvg(W, H)}</g></svg>`;
        await drawSvg(overlay, 0, 0, fig.width * s, crop.h * s);
        return new Promise((resolve, reject) => canvas.toBlob(b => (b ? resolve(b) : reject(new Error('PNG export failed'))), 'image/png'));
    }

    // Kept for callers of the old name: the PNG at 2×.
    const snapshot = () => toPng(2);

    return {
        show, snapshot, toPng, toSvg, resize,
        startSlice, cancelSlice: stopPicking, clearSlice, flipSlice,
        isPicking: () => Boolean(picking), hasSlice: () => Boolean(slice),
        onSlice: fn => { onSlice = fn; },
    };
}

function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
