// Custom patterns dialog: turn an uploaded PNG, JPG or SVG into a pattern entry
// in the document's "patterns" section. Raster images are embedded (scaled down
// if large); black-and-white ones can instead be traced to vector shapes.
import ImageTracer from 'imagetracerjs';
import {
    PATTERN_CODE, MAX_PATTERN_SIDE, MAX_PATTERN_URI, listPatterns, addPattern, removePattern,
    thresholdPixels, tidyTracedSvg, base64Utf8, svgSize,
} from './lib.js';

const BUILT_IN_SAMPLERS = ['SPT', 'ModCal', 'Shelby', 'Piston', 'Bulk', 'Core', 'Other'];
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

// The uploaded file as { kind: 'svg' | 'raster', uri, width, height, canvas? }.
async function readPatternFile(file) {
    if (file.size > 10 * 1024 * 1024) throw new Error(`${file.name} is larger than 10 MB.`);
    if (file.type === 'image/svg+xml' || /\.svg$/i.test(file.name)) {
        const text = await readAs(file, 'readAsText');
        const size = svgSize(text);
        if (!size) throw new Error('The SVG needs width and height attributes or a viewBox.');
        return { kind: 'svg', uri: `data:image/svg+xml;base64,${base64Utf8(text)}`, ...size };
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
    return { kind: 'svg', uri: `data:image/svg+xml;base64,${base64Utf8(tidyTracedSvg(svg, width, height))}`, width, height };
}

export function setUpPatternsDialog({ getText, setText }) {
    const $ = id => document.getElementById(id);
    const dialog = $('patterns-dialog');
    const form = $('pattern-form');
    const list = $('pattern-list');
    const errorBox = $('pattern-error');
    const traceBox = $('pattern-trace');
    const threshold = $('pattern-threshold');
    const original = $('pattern-original');
    const traced = $('pattern-traced');
    const tiled = $('pattern-tiled');
    let source = null;   // the uploaded image
    let result = null;   // what will be stored (source, or its traced version)

    const showError = text => {
        errorBox.textContent = text ?? '';
        errorBox.hidden = !text;
    };

    function refreshList() {
        list.replaceChildren();
        const entries = listPatterns(getText());
        $('pattern-none').hidden = entries.length > 0;
        for (const [code, p] of entries) {
            const li = document.createElement('li');
            const img = document.createElement('img');
            img.src = p.image;
            img.alt = '';
            const label = document.createElement('span');
            label.textContent = `${code} – ${p.name ?? code} (${p.kind === 'sampler' ? 'sampler symbol' : 'soil pattern'})`;
            const remove = document.createElement('button');
            remove.type = 'button';
            remove.textContent = 'Remove';
            remove.addEventListener('click', () => {
                try {
                    setText(removePattern(getText(), code));
                    refreshList();
                } catch (e) {
                    showError(e.message);
                }
            });
            li.append(img, label, remove);
            list.append(li);
        }
    }

    function refreshPreview() {
        const vector = form.vector.checked && source?.kind === 'raster';
        traceBox.hidden = source?.kind !== 'raster';
        threshold.disabled = !vector;
        result = source ? (vector ? traceToSvg(source, Number(threshold.value)) : source) : null;
        original.src = source?.uri ?? '';
        traced.src = vector ? result.uri : '';
        traced.closest('figure').hidden = !vector;
        const sampler = form.kind.value === 'sampler';
        form.tile_width.closest('label').hidden = sampler;
        tiled.style.backgroundImage = result && !sampler ? `url("${result.uri}")` : 'none';
        tiled.style.backgroundSize = result ? `${Number(form.tile_width.value) || 40}px auto` : '';
        tiled.closest('figure').hidden = !result || sampler;
        const hint = $('pattern-hint');
        const code = form.code.value.trim();
        hint.textContent = !code ? ''
            : (sampler ? BUILT_IN_SAMPLERS : USCS).includes(code)
                ? `Replaces the built-in ${code} ${sampler ? 'symbol' : 'pattern'} everywhere in this log.`
                : sampler ? `Set a sample's "type" to "${code}" to use it.` : `Set a layer's "hatch" (not "uscs") to "${code}" to use it.`;
    }

    $('patterns-open').addEventListener('click', () => {
        showError();
        refreshList();
        dialog.showModal();
    });
    $('pattern-close').addEventListener('click', () => dialog.close());

    form.file.addEventListener('change', async () => {
        showError();
        source = null;
        const file = form.file.files[0];
        if (file) {
            try {
                source = await readPatternFile(file);
                if (!form.code.value) form.code.value = file.name.replace(/\.[^.]+$/, '').replace(/[^A-Za-z0-9_]/g, '').replace(/^[^A-Za-z]+/, '').slice(0, 16);
            } catch (e) {
                showError(e.message);
            }
        }
        refreshPreview();
    });
    for (const input of [form.vector, threshold, form.kind, form.tile_width, form.code]) {
        input.addEventListener('input', () => {
            showError();
            refreshPreview();
        });
    }

    form.addEventListener('submit', e => {
        e.preventDefault();
        showError();
        const code = form.code.value.trim();
        if (!PATTERN_CODE.test(code)) return showError('The code must start with a letter and use only letters, digits and _ (up to 16 characters).');
        if (!result) return showError('Choose an image first.');
        if (result.uri.length > MAX_PATTERN_URI) {
            return showError(`The image is too large for a pattern (${Math.round(result.uri.length / 1000)} kB encoded, limit ${MAX_PATTERN_URI / 1000} kB). Use a smaller image, or convert it to vector.`);
        }
        const entry = { image: result.uri, width: result.width, height: result.height };
        if (form.name.value.trim()) entry.name = form.name.value.trim();
        if (form.kind.value === 'sampler') entry.kind = 'sampler';
        else if (Number(form.tile_width.value)) entry.tile_width = Number(form.tile_width.value);
        try {
            setText(addPattern(getText(), code, entry));
        } catch (err) {
            return showError(err.message);
        }
        form.reset();
        source = result = null;
        refreshPreview();
        refreshList();
    });

    refreshPreview();
}
