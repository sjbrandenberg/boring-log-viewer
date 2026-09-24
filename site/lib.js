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
