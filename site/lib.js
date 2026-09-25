// DOM-free helpers for the paste page, kept separate so they can be unit tested.

// Line and column (1-based) of a character offset.
export function lineColumn(text, offset) {
    const before = text.slice(0, offset);
    const line = before.split('\n').length;
    return { line, column: offset - before.lastIndexOf('\n') };
}

// Where a JSON.parse error happened. Browsers word the message differently:
// Chrome/Node say "at position 42 (line 3 column 5)", Firefox says
// "at line 3 column 5 of the JSON data". Returns { offset, line, column } or null.
export function syntaxErrorLocation(text, message) {
    const lc = message.match(/line (\d+) column (\d+)/);
    if (lc) {
        const line = Number(lc[1]);
        const column = Number(lc[2]);
        const lines = text.split('\n');
        let offset = 0;
        for (let i = 0; i < line - 1 && i < lines.length; i++) offset += lines[i].length + 1;
        return { offset: offset + column - 1, line, column };
    }
    const pos = message.match(/position (\d+)/);
    if (pos) {
        const offset = Number(pos[1]);
        return { offset, ...lineColumn(text, offset) };
    }
    return null;
}

// Finds the text span of the value at a JSON Pointer ("/layers/2/uscs") so an
// error can be highlighted in the editor. Returns { start, end } or null.
// A small scanner rather than a full parser: it only has to follow keys and
// array indices through text that JSON.parse already accepted.
export function locatePointer(text, pointer) {
    const path = pointer === '' ? [] : pointer.slice(1).split('/').map(p => p.replace(/~1/g, '/').replace(/~0/g, '~'));
    let i = 0;
    const ws = () => { while (/\s/.test(text[i])) i++; };
    const skipString = () => {
        i++;
        while (i < text.length && text[i] !== '"') i += text[i] === '\\' ? 2 : 1;
        i++;
    };
    const readString = () => {
        const start = i;
        skipString();
        return JSON.parse(text.slice(start, i));
    };
    const skipValue = () => {
        ws();
        const c = text[i];
        if (c === '"') return skipString();
        if (c === '{' || c === '[') {
            const close = c === '{' ? '}' : ']';
            i++;
            ws();
            if (text[i] === close) { i++; return; }
            for (;;) {
                if (c === '{') { ws(); skipString(); ws(); i++; }
                skipValue();
                ws();
                if (text[i++] === close) return;
            }
        }
        while (i < text.length && !/[\s,\]}]/.test(text[i])) i++;
    };

    ws();
    for (const key of path) {
        const c = text[i];
        if (c === '{') {
            i++;
            let found = false;
            for (;;) {
                ws();
                if (text[i] === '}') break;
                const k = readString();
                ws();
                i++; // colon
                ws();
                if (k === key) { found = true; break; }
                skipValue();
                ws();
                if (text[i] === ',') i++;
            }
            if (!found) return null;
        } else if (c === '[') {
            i++;
            const index = Number(key);
            if (!Number.isInteger(index)) return null;
            for (let n = 0; ; n++) {
                ws();
                if (text[i] === ']') return null;
                if (n === index) break;
                skipValue();
                ws();
                if (text[i] === ',') i++;
            }
        } else {
            return null;
        }
    }
    ws();
    const start = i;
    skipValue();
    return { start, end: i };
}

// Download filename from the boring name, e.g. "B-3 (north)" -> "B-3_north".
export function downloadName(doc, ext) {
    const name = doc?.metadata?.boring_name ?? 'boring-log';
    const slug = String(name).replace(/[^A-Za-z0-9._-]+/g, '_').replace(/^_+|_+$/g, '') || 'boring-log';
    return `${slug}.${ext}`;
}

// Render options from the form's raw values.
export function renderOptions(form) {
    const options = {
        header: form.header,
        legend: form.legend,
        fit_text: form.fit_text,
        hide_empty_columns: form.hide_empty_columns,
    };
    const width = Number(form.width);
    if (Number.isFinite(width) && width >= 300) options.width = Math.min(width, 4000);
    if (form.units === 'm' || form.units === 'ft') options.units = form.units;
    return options;
}

// One-line summary of what a valid document contains.
export function summarize(doc) {
    const count = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
    const parts = [count(doc.layers?.length ?? 0, 'layer'), count(doc.samples?.length ?? 0, 'sample')];
    if (doc.groundwater?.length) parts.push(count(doc.groundwater.length, 'groundwater reading'));
    return parts.join(', ');
}

// ------------------------------------------------------------ custom patterns

export const PATTERN_CODE = /^[A-Za-z][A-Za-z0-9_]{0,15}$/;
export const MAX_PATTERN_SIDE = 512;      // px; larger images are scaled down
export const MAX_PATTERN_URI = 340000;    // characters of data URI (the schema allows 350000)

function parseDoc(text) {
    let doc;
    try {
        doc = JSON.parse(text);
    } catch (e) {
        throw new Error(`Fix the JSON first (${e.message}).`);
    }
    if (!doc || typeof doc !== 'object' || Array.isArray(doc)) throw new Error('The JSON must be an object.');
    return doc;
}

// The document's custom patterns as [code, entry] pairs; [] if the JSON can't be read.
export function listPatterns(text) {
    try {
        const p = parseDoc(text).patterns;
        return p && typeof p === 'object' ? Object.entries(p) : [];
    } catch {
        return [];
    }
}

// Returns the document text with the pattern added (or replaced), pretty-printed.
export function addPattern(text, code, entry) {
    if (!PATTERN_CODE.test(code)) throw new Error('The code must start with a letter and use only letters, digits and _ (up to 16 characters).');
    const doc = parseDoc(text);
    doc.patterns = { ...(doc.patterns && typeof doc.patterns === 'object' ? doc.patterns : {}), [code]: entry };
    return JSON.stringify(doc, null, 2);
}

export function removePattern(text, code) {
    const doc = parseDoc(text);
    if (doc.patterns && typeof doc.patterns === 'object') {
        delete doc.patterns[code];
        if (!Object.keys(doc.patterns).length) delete doc.patterns;
    }
    return JSON.stringify(doc, null, 2);
}

// Black and white copy of RGBA pixels: dark enough pixels become black, the rest
// (and transparent pixels) white. threshold is 0-255 on luminance.
export function thresholdPixels(data, threshold = 128) {
    const out = new Uint8ClampedArray(data.length);
    for (let i = 0; i < data.length; i += 4) {
        const alpha = data[i + 3] / 255;
        const luma = (0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2]) * alpha + 255 * (1 - alpha);
        const v = luma < threshold ? 0 : 255;
        out[i] = out[i + 1] = out[i + 2] = v;
        out[i + 3] = 255;
    }
    return out;
}

// Tidies imagetracer output for use as a pattern: drops the white shapes (so the
// tile is transparent), the "desc" attribute and default attributes, and gives the
// SVG its pixel size.
export function tidyTracedSvg(svg, width, height) {
    return svg
        .replace(/<path fill="rgb\(255,255,255\)"[^>]*\/>/g, '')
        .replace(/\s+desc="[^"]*"/, '')
        .replace(/ stroke="rgb\(0,0,0\)" stroke-width="0" opacity="1"/g, '')
        .replace(/<svg /, `<svg width="${width}" height="${height}" `);
}

// Base64 of a string's UTF-8 bytes (btoa only handles Latin-1).
export function base64Utf8(text) {
    const bytes = new TextEncoder().encode(text);
    let binary = '';
    for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    return btoa(binary);
}

// Pixel size of an SVG from its width/height attributes or viewBox, or null.
export function svgSize(svgText) {
    const tag = (svgText.match(/<svg\b[^>]*>/i) || [''])[0];
    const attr = name => {
        const m = tag.match(new RegExp(String.raw`\s${name}\s*=\s*["']\s*([\d.]+)(px)?\s*["']`, 'i'));
        return m ? Number(m[1]) : null;
    };
    let width = attr('width');
    let height = attr('height');
    const vb = tag.match(/viewBox\s*=\s*["']\s*[-\d.]+[\s,]+[-\d.]+[\s,]+([\d.]+)[\s,]+([\d.]+)\s*["']/i);
    if ((!width || !height) && vb) {
        const [vw, vh] = [Number(vb[1]), Number(vb[2])];
        if (width) height = (width * vh) / vw;       // keep the viewBox's aspect ratio
        else if (height) width = (height * vw) / vh;
        else [width, height] = [vw, vh];
    }
    return width > 0 && height > 0 ? { width, height } : null;
}
