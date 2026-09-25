// Hatches dialog: turn an uploaded PNG, JPG or SVG into a pattern entry in the
// document's "patterns" section, and apply it to the layers or samples picked.
// SVG files, and raster images traced to vector shapes (the default), are stored
// as SVG markup ("svg"); a raster image can instead be kept as a picture
// ("image", a data URI, scaled down if large).
import ImageTracer from 'imagetracerjs';
import {
    PATTERN_CODE, MAX_PATTERN_SIDE, MAX_PATTERN_URI, listPatterns, addPattern, removePattern,
    thresholdPixels, tidyTracedSvg, patternTargets, applyPattern,
} from './lib.js';
import { cleanSvg, svgDataUri } from '../src/svg-pattern.js';
import { hatchSwatch, samplerSwatch, SAMPLER_NAMES, USCS_NAMES, LITHOLOGY, LITHOLOGY_GROUPS } from '../src/index.js';

const BUILT_IN_SAMPLERS = Object.keys(SAMPLER_NAMES);
const USCS = ['GW', 'GP', 'GM', 'GC', 'SW', 'SP', 'SM', 'SC', 'ML', 'CL', 'OL', 'MH', 'CH', 'OH', 'PT'];

function loadImage(url) {
    const img = new Image();
    img.src = url;
    return img.decode().then(() => img);
}

function readAs(file, how) {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result);
        reader.onerror = () => reject(reader.error);
        reader[how](file);
    });
}

// Cleaned SVG markup as { kind: 'svg', svg, uri (for previews), width, height }.
function svgResult(text) {
    const { svg, width, height } = cleanSvg(text);
    return { kind: 'svg', svg, uri: svgDataUri(svg), width, height };
}

// The uploaded file as { kind: 'svg', svg, ... } or { kind: 'raster', uri, width, height, canvas }.
async function readPatternFile(file) {
    if (file.size > 10 * 1024 * 1024) throw new Error(`${file.name} is larger than 10 MB.`);
    if (file.type === 'image/svg+xml' || /\.svg$/i.test(file.name)) {
        const text = await readAs(file, 'readAsText');
        try {
            return svgResult(text);
        } catch (e) {
            throw new Error(`This SVG can't be used as a hatch: it ${e.message}.`);
        }
    }
    if (!/^image\/(png|jpeg)$/.test(file.type)) throw new Error('Use a PNG, JPG or SVG image.');
    const img = await loadImage(await readAs(file, 'readAsDataURL'));
    const scale = Math.min(1, MAX_PATTERN_SIDE / Math.max(img.naturalWidth, img.naturalHeight));
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(img.naturalWidth * scale));
    canvas.height = Math.max(1, Math.round(img.naturalHeight * scale));
    const ctx = canvas.getContext('2d');
    if (file.type === 'image/jpeg') {
        ctx.fillStyle = '#fff';
        ctx.fillRect(0, 0, canvas.width, canvas.height);
    }
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
    const type = file.type === 'image/jpeg' ? 'image/jpeg' : 'image/png';
    return { kind: 'raster', uri: canvas.toDataURL(type, 0.9), width: canvas.width, height: canvas.height, canvas };
}

// Traces a raster pattern to black-and-white vector shapes.
function traceToSvg(source, threshold) {
    const { width, height } = source.canvas;
    const pixels = source.canvas.getContext('2d').getImageData(0, 0, width, height);
    const bw = { width, height, data: thresholdPixels(pixels.data, threshold) };
    const svg = ImageTracer.imagedataToSVG(bw, {
        colorsampling: 0, numberofcolors: 2,
        pal: [{ r: 0, g: 0, b: 0, a: 255 }, { r: 255, g: 255, b: 255, a: 255 }],
        ltres: 1, qtres: 1, pathomit: 2, strokewidth: 0, roundcoords: 1, viewbox: true, blurradius: 0,
    });
    return svgResult(tidyTracedSvg(svg, width, height));
}

export function setUpPatternsDialog({ getText, setText }) {
    const $ = id => document.getElementById(id);
    const dialog = $('patterns-dialog');
    const form = $('pattern-form');
    const list = $('pattern-list');
    const errorBox = $('pattern-error');
    const doneBox = $('pattern-done');
    const traceBox = $('pattern-trace');
    const threshold = $('pattern-threshold');
    const original = $('pattern-original');
    const traced = $('pattern-traced');
    const tiled = $('pattern-tiled');
    const targets = $('pattern-targets');
    let source = null;   // the uploaded image
    let result = null;   // what will be stored (source, or its traced version)
    let fileError = null; // why the chosen file can't be used, kept for the submit button

    const say = (box, text) => {
        box.textContent = text ?? '';
        box.hidden = !text;
    };
    const showError = text => say(errorBox, text);
    const sampler = () => form.kind.value === 'sampler';
    const code = () => form.code.value.trim();
    const isBuiltIn = () => (sampler() ? BUILT_IN_SAMPLERS : USCS).includes(code());
    // Built-in materials (FILL, SANDSTONE...) aren't used by any layer until it gets
    // "hatch": CODE, so they get the layer checklist, and an image is optional.
    const isMaterial = () => !sampler() && Object.prototype.hasOwnProperty.call(LITHOLOGY, code());

    // ---- the log's own patterns
    function refreshList() {
        list.replaceChildren();
        const text = getText();
        const entries = listPatterns(text);
        $('pattern-none').hidden = entries.length > 0;
        for (const [c, p] of entries) {
            const kind = p.kind === 'sampler' ? 'sampler' : 'soil';
            const users = patternTargets(text, kind)
                .filter(t => t.current === c || (kind === 'soil' && String(t.current).split(/[-/]/).includes(c))).length;
            const builtIn = (kind === 'sampler' ? BUILT_IN_SAMPLERS : USCS).includes(c);
            const noun = kind === 'sampler' ? 'sample' : 'layer';
            const li = document.createElement('li');
            const img = document.createElement('img');
            let src = typeof p.image === 'string' ? p.image : '';
            try {
                if (typeof p.svg === 'string') src = svgDataUri(cleanSvg(p.svg).svg);
            } catch {
                // shown without a picture; validation reports the problem
            }
            img.src = src;
            img.alt = '';
            const label = document.createElement('span');
            label.textContent = `${c} – ${p.name ?? c} (${kind === 'sampler' ? 'sampler symbol' : 'hatch'}; `
                + (builtIn ? `replaces the built-in ${c})` : `used by ${users} ${noun}${users === 1 ? '' : 's'})`);
            const remove = document.createElement('button');
            remove.type = 'button';
            remove.textContent = 'Remove';
            remove.addEventListener('click', () => {
                try {
                    setText(removePattern(getText(), c));
                    refreshList();
                    refreshTargets();
                } catch (e) {
                    showError(e.message);
                }
            });
            li.append(img, label, remove);
            list.append(li);
        }
    }

    // ---- step 3: which layers or samples use it
    function refreshTargets() {
        const kind = sampler() ? 'sampler' : 'soil';
        const noun = kind === 'sampler' ? 'sample' : 'layer';
        const field = kind === 'sampler' ? 'type' : 'hatch';
        const c = code() || 'CODE';
        $('pattern-targets-title').textContent = `3. Choose the ${noun}s that use it`;
        const note = $('pattern-targets-note');
        if (isBuiltIn()) {
            note.textContent = `${c} is a built-in ${kind === 'sampler' ? 'sampler symbol' : 'hatch'}, so your image replaces it everywhere it is used in this log. There is nothing to choose.`;
            targets.replaceChildren();
        } else {
            const items = patternTargets(getText(), kind);
            note.textContent = !items.length ? '' : isMaterial()
                ? `${c} (${LITHOLOGY[c].name}) is a built-in hatch: tick each layer that should be drawn with it. You don't need an image; if you add one, it replaces the built-in ${c} in this log.`
                : items.length
                ? `Tick each ${noun} that should be drawn with it. To change this later, add it again with the same code.`
                : `This log has no ${noun}s yet. You can add it now and choose ${noun}s after adding them to the JSON.`;
            const checked = new Set([...targets.querySelectorAll('input:checked')].map(i => Number(i.value)));
            targets.replaceChildren(...items.map(t => {
                const li = document.createElement('li');
                const label = document.createElement('label');
                const box = document.createElement('input');
                box.type = 'checkbox';
                box.value = String(t.index);
                box.checked = checked.has(t.index) || (code() !== '' && t.current === code());
                const text = document.createElement('span');
                text.textContent = t.label + (t.current ? ` (now: ${t.current})` : '');
                label.append(box, text);
                li.append(label);
                return li;
            }));
        }
        // What gets written to the JSON, with the code filled in.
        $('pattern-json-text').textContent = isMaterial()
            ? `Each layer you tick gets "hatch": "${c}". ${c} is built in, so nothing else is added, unless you choose an image: that is stored in the log's "patterns" section and replaces the built-in ${c} in this log. A layer's "uscs" (its soil classification) stays as it is.`
            : isBuiltIn()
            ? `Your image is stored once, in the log's "patterns" section under "${c}". Every ${noun} that uses ${c} is then drawn with it; the ${noun}s themselves don't change.`
            : `Your image is stored once, in the log's "patterns" section under "${c}". Each ${noun} you tick gets "${field}": "${c}"`
              + (kind === 'soil'
                  ? '. Its "uscs" (the soil classification) stays as it is: "uscs" only takes USCS symbols, and the drawing is chosen by "hatch".'
                  : ', which selects the symbol drawn in the sample type column.');
        $('pattern-json-example').textContent = kind === 'sampler'
            ? `"samples": [\n  { "top": 1.5, "bottom": 1.95, "name": "V-1", "type": "${c}" }\n]`
            : `"layers": [\n  { "top": 0, "bottom": 1.2, "description": "Rubble fill", "hatch": "${c}" }\n]`;
        $('pattern-submit').textContent = isBuiltIn() ? `Replace ${c}` : isMaterial() && !result ? `Use ${c} for the ticked layers` : 'Add to log';
    }

    // ---- step 2: the image and its previews
    function refreshPreview() {
        const vector = form.vector.checked && source?.kind === 'raster';
        traceBox.hidden = source?.kind !== 'raster';
        threshold.disabled = !vector;
        result = source ? (vector ? traceToSvg(source, Number(threshold.value)) : source) : null;
        original.src = source?.uri ?? '';
        traced.src = vector ? result.uri : '';
        traced.closest('figure').hidden = !vector;
        form.tile_width.closest('label').hidden = sampler();
        tiled.style.backgroundImage = result && !sampler() ? `url("${result.uri}")` : 'none';
        tiled.style.backgroundSize = result ? `${Number(form.tile_width.value) || 40}px auto` : '';
        tiled.closest('figure').hidden = !result || sampler();
        const c = code();
        if (c) $('pattern-submit').textContent = isBuiltIn() ? `Replace ${c}` : isMaterial() && !result ? `Use ${c} for the ticked layers` : 'Add to log';
    }

    // ---- built-in codes, each with a Replace button that fills in step 1
    function builtInItem(swatch, c, name, kind, action = 'Replace') {
        const li = document.createElement('li');
        const pic = document.createElement('span');
        pic.className = 'swatch';
        pic.innerHTML = swatch; // drawn by the renderer from its own tables, not user input
        const label = document.createElement('span');
        const strong = document.createElement('strong');
        strong.textContent = c;
        label.append(strong, ` – ${name}`);
        const use = document.createElement('button');
        use.type = 'button';
        use.textContent = action;
        use.title = action === 'Use' ? `Draw layers you choose with ${c}` : `Use your own image for ${c}`;
        use.addEventListener('click', () => {
            form.kind.value = kind;
            form.code.value = c;
            if (!form.name.value) form.name.value = name;
            showError();
            refreshPreview();
            refreshTargets();
            if (action === 'Use') {
                $('pattern-targets-title').scrollIntoView({ block: 'start' });
            } else {
                form.code.scrollIntoView({ block: 'center' });
                form.file.focus();
            }
        });
        li.append(pic, label, use);
        return li;
    }
    $('builtin-hatches').replaceChildren(...USCS.map(c => builtInItem(hatchSwatch(c), c, USCS_NAMES[c], 'soil')));
    $('builtin-samplers').replaceChildren(...BUILT_IN_SAMPLERS.map(t => builtInItem(samplerSwatch(t), t, SAMPLER_NAMES[t], 'sampler')));
    // Other materials and rock, by group
    const materials = $('builtin-materials');
    for (const group of LITHOLOGY_GROUPS) {
        const heading = document.createElement('li');
        heading.className = 'builtin-group';
        heading.textContent = group;
        materials.append(heading, ...Object.entries(LITHOLOGY).filter(([, m]) => m.group === group)
            .map(([c, m]) => builtInItem(hatchSwatch(c), c, m.name, 'soil', 'Use')));
    }

    // ---- wiring
    $('patterns-open').addEventListener('click', () => {
        showError();
        say(doneBox);
        refreshList();
        refreshTargets();
        dialog.showModal();
    });
    $('pattern-close').addEventListener('click', () => dialog.close());
    // Links to the help below the page close the window so the help is visible.
    for (const link of dialog.querySelectorAll('a[data-close-dialog]')) link.addEventListener('click', () => dialog.close());

    form.file.addEventListener('change', async () => {
        showError();
        source = null;
        fileError = null;
        const file = form.file.files[0];
        if (file) {
            try {
                source = await readPatternFile(file);
                if (!form.code.value) {
                    form.code.value = file.name.replace(/\.[^.]+$/, '').replace(/[^A-Za-z0-9_]/g, '').replace(/^[^A-Za-z]+/, '').slice(0, 16);
                    refreshTargets();
                }
            } catch (e) {
                fileError = e.message;
                showError(e.message);
            }
        }
        refreshPreview();
    });
    for (const input of [form.vector, threshold, form.tile_width]) {
        input.addEventListener('input', () => {
            showError();
            refreshPreview();
        });
    }
    for (const input of [form.kind, form.code]) {
        input.addEventListener('input', () => {
            showError();
            refreshPreview();
            refreshTargets();
        });
    }

    form.addEventListener('submit', e => {
        e.preventDefault();
        showError();
        say(doneBox);
        const c = code();
        if (!PATTERN_CODE.test(c)) return showError('The code must start with a letter and use only letters, digits and _ (up to 16 characters).');
        if (!result && isMaterial()) {
            const ticked = [...targets.querySelectorAll('input:checked')].map(i => Number(i.value));
            if (!ticked.length) return showError(`Tick at least one layer to draw with ${c} (step 3).`);
            try {
                setText(applyPattern(getText(), c, 'soil', ticked));
            } catch (err) {
                return showError(err.message);
            }
            say(doneBox, `Applied the built-in ${c} (${LITHOLOGY[c].name}) to ${ticked.length} layer${ticked.length === 1 ? '' : 's'}.`);
            form.reset();
            source = result = null;
            refreshPreview();
            refreshList();
            refreshTargets();
            return;
        }
        if (!result) return showError(fileError ?? 'Choose an image first (step 2).');
        const stored = result.svg ?? result.uri;
        if (stored.length > MAX_PATTERN_URI) {
            return showError(`The image is too large (${Math.round(stored.length / 1000)} kB ${result.svg ? 'of SVG' : 'encoded'}, limit ${MAX_PATTERN_URI / 1000} kB). Use a smaller or simpler image${result.svg ? '' : ', or convert it to vector'}.`);
        }
        const kind = sampler() ? 'sampler' : 'soil';
        const builtIn = isBuiltIn();
        // SVG markup is stored as is (its size comes from its viewBox); a picture as a data URI.
        const entry = result.svg ? { svg: result.svg } : { image: result.uri, width: result.width, height: result.height };
        if (form.name.value.trim()) entry.name = form.name.value.trim();
        if (kind === 'sampler') entry.kind = 'sampler';
        else if (Number(form.tile_width.value)) entry.tile_width = Number(form.tile_width.value);
        const chosen = builtIn ? [] : [...targets.querySelectorAll('input:checked')].map(i => Number(i.value));
        try {
            setText(applyPattern(addPattern(getText(), c, entry), c, kind, chosen));
        } catch (err) {
            return showError(err.message);
        }
        const noun = kind === 'sampler' ? 'sample' : 'layer';
        say(doneBox, builtIn
            ? `Replaced the built-in ${c}. The preview now uses your image.`
            : chosen.length
                ? `Added ${c} and applied it to ${chosen.length} ${noun}${chosen.length === 1 ? '' : 's'}.`
                : `Added ${c}. No ${noun}s use it yet: add it again with ${noun}s ticked, or set "${kind === 'sampler' ? 'type' : 'hatch'}": "${c}" in the JSON.`);
        form.reset();
        source = result = fileError = null;
        refreshPreview();
        refreshList();
        refreshTargets();
    });

    refreshPreview();
    refreshTargets();
}
