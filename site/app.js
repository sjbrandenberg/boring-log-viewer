// Paste page: edit JSON, see validation messages and a live preview, download
// the log as SVG or PNG, or print it to PDF. Everything runs in the browser.
import { renderBoringLog, validateBoringLog, BoringLogError } from '../src/index.js';
import { syntaxErrorLocation, locatePointer, downloadName, renderOptions, summarize } from './lib.js';
import { setUpPatternsDialog } from './patterns.js';
import coastal from '../tests/fixtures/coastal-style.json' with { type: 'json' };
import vspdb from '../tests/fixtures/vspdb-style.json' with { type: 'json' };
import dense from '../tests/fixtures/dense-text.json' with { type: 'json' };
import minimal from '../tests/fixtures/minimal.json' with { type: 'json' };

const EXAMPLES = {
    coastal: { label: 'Coastal boring (metric, lab data)', doc: coastal },
    vspdb: { label: 'Treasure Island boring (US units, SPT)', doc: vspdb },
    dense: { label: 'Thin layers with long descriptions', doc: dense },
    minimal: { label: 'Minimal (one layer)', doc: minimal },
};
const STORAGE_KEY = 'boring-log-viewer:v1';

const $ = id => document.getElementById(id);
const editor = $('json');
const preview = $('preview');
const messages = $('messages');
const status = $('status');
const form = $('options');

let current = null; // { svg, doc } for the preview currently shown

// ------------------------------------------------------------ persistence

function loadState() {
    try {
        return JSON.parse(localStorage.getItem(STORAGE_KEY)) ?? {};
    } catch {
        return {};
    }
}

function saveState() {
    try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify({ json: editor.value, options: formValues() }));
    } catch {
        // Storage can be unavailable (private windows, blocked site data); the page works without it.
    }
}

// ------------------------------------------------------------ options form

function formValues() {
    return {
        units: form.units.value,
        width: form.width.value,
        png_scale: form.png_scale.value,
        header: form.header.checked,
        legend: form.legend.checked,
        fit_text: form.fit_text.checked,
        hide_empty_columns: form.hide_empty_columns.checked,
    };
}

function applyFormValues(values) {
    for (const [key, value] of Object.entries(values ?? {})) {
        const field = form.elements[key];
        if (!field) continue;
        if (field.type === 'checkbox') field.checked = Boolean(value);
        else field.value = value;
    }
}

// ------------------------------------------------------------ messages

function showMessages(items) {
    messages.replaceChildren();
    for (const item of items) {
        const li = document.createElement('li');
        li.className = item.level;
        const where = document.createElement('code');
        where.textContent = item.where;
        li.append(where, ' ', item.message);
        if (item.select) {
            li.tabIndex = 0;
            li.title = 'Show in editor';
            const go = () => selectRange(item.select.start, item.select.end);
            li.addEventListener('click', go);
            li.addEventListener('keydown', e => { if (e.key === 'Enter') go(); });
        }
        messages.append(li);
    }
    messages.hidden = items.length === 0;
}

function selectRange(start, end) {
    editor.focus();
    editor.setSelectionRange(start, Math.max(end, start + 1));
    // Scroll the selection into view: approximate by line height.
    const line = editor.value.slice(0, start).split('\n').length;
    const lineHeight = parseFloat(getComputedStyle(editor).lineHeight) || 18;
    editor.scrollTop = Math.max(0, (line - 4) * lineHeight);
}

function setStatus(text, level) {
    status.textContent = text;
    status.className = `status ${level}`;
}

// ------------------------------------------------------------ render

function update() {
    const text = editor.value;
    saveState();
    if (!text.trim()) {
        showMessages([]);
        setStatus('Paste boring log JSON, open a file, or load an example.', 'idle');
        setPreview(null);
        return;
    }

    let doc;
    try {
        doc = JSON.parse(text);
    } catch (e) {
        const loc = syntaxErrorLocation(text, e.message);
        showMessages([{
            level: 'error',
            where: loc ? `line ${loc.line}, column ${loc.column}` : 'JSON',
            // The location is shown separately; drop the browser's own copy of it.
            message: e.message
                .replace(/^JSON\.parse: /, '')
                .replace(/\s*(in JSON )?at position \d+( \(line \d+ column \d+\))?/, '')
                .replace(/\s*at line \d+ column \d+ of the JSON data/, ''),
            select: loc ? { start: loc.offset, end: loc.offset + 1 } : null,
        }]);
        setStatus('Invalid JSON; preview not updated.', 'error');
        markStale();
        return;
    }

    const result = validateBoringLog(doc);
    const items = [
        ...result.errors.map(e => ({ level: 'error', ...e })),
        ...result.warnings.map(w => ({ level: 'warning', ...w })),
    ].map(item => ({
        level: item.level,
        where: item.path || '/',
        message: item.message,
        select: locatePointer(text, item.path),
    }));
    showMessages(items);

    try {
        const svg = renderBoringLog(doc, renderOptions(formValues()));
        setPreview({ svg, doc });
        if (result.valid) {
            setStatus(`Valid: ${summarize(doc)}${result.warnings.length ? ` · ${result.warnings.length} warning(s)` : ''}.`, 'ok');
        } else {
            setStatus(`${result.errors.length} schema error(s). The preview is drawn from the fields that could be read.`, 'warning');
        }
    } catch (e) {
        if (!(e instanceof BoringLogError)) throw e;
        if (!items.length) {
            showMessages(e.issues.map(i => ({ level: 'error', where: i.path || '/', message: i.message, select: locatePointer(text, i.path) })));
        }
        setStatus('This log cannot be drawn until the errors are fixed.', 'error');
        markStale();
    }
}

function setPreview(value) {
    current = value;
    preview.classList.remove('stale');
    if (value) {
        // The renderer escapes all user text, so its output is safe to insert.
        preview.innerHTML = value.svg;
    } else {
        preview.innerHTML = '<p class="placeholder">The boring log will appear here.</p>';
    }
    for (const button of document.querySelectorAll('[data-download]')) button.disabled = !value;
}

function markStale() {
    if (!current) return;
    preview.classList.add('stale');
    for (const button of document.querySelectorAll('[data-download]')) button.disabled = true;
}

// ------------------------------------------------------------ downloads

function saveBlob(blob, filename) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
}

async function svgToPng(svg, scale) {
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
        return await new Promise((resolve, reject) => canvas.toBlob(b => (b ? resolve(b) : reject(new Error('PNG export failed'))), 'image/png'));
    } finally {
        URL.revokeObjectURL(url);
    }
}

$('download-svg').addEventListener('click', () => {
    if (!current) return;
    saveBlob(new Blob([`<?xml version="1.0" encoding="UTF-8"?>\n${current.svg}\n`], { type: 'image/svg+xml' }), downloadName(current.doc, 'svg'));
});

$('download-png').addEventListener('click', async () => {
    if (!current) return;
    const button = $('download-png');
    button.disabled = true;
    try {
        saveBlob(await svgToPng(current.svg, Number(form.png_scale.value) || 2), downloadName(current.doc, 'png'));
    } catch (e) {
        setStatus(`PNG export failed: ${e.message}`, 'error');
    } finally {
        button.disabled = !current;
    }
});

$('print').addEventListener('click', () => window.print());

// ------------------------------------------------------------ editor actions

function setText(text) {
    editor.value = text;
    update();
}

const exampleSelect = $('example');
for (const [key, { label }] of Object.entries(EXAMPLES)) {
    exampleSelect.append(new Option(label, key));
}
exampleSelect.addEventListener('change', () => {
    const example = EXAMPLES[exampleSelect.value];
    if (example) setText(JSON.stringify(example.doc, null, 2));
    exampleSelect.value = '';
});

$('format').addEventListener('click', () => {
    try {
        setText(JSON.stringify(JSON.parse(editor.value), null, 2));
    } catch {
        update(); // shows the syntax error
    }
});

$('clear').addEventListener('click', () => setText(''));

async function openFile(file) {
    if (!file) return;
    if (file.size > 5 * 1024 * 1024) {
        setStatus(`${file.name} is larger than 5 MB.`, 'error');
        return;
    }
    setText(await file.text());
}

$('file').addEventListener('change', e => {
    openFile(e.target.files[0]);
    e.target.value = '';
});

const dropZone = $('editor-pane');
dropZone.addEventListener('dragover', e => {
    e.preventDefault();
    dropZone.classList.add('dragging');
});
dropZone.addEventListener('dragleave', () => dropZone.classList.remove('dragging'));
dropZone.addEventListener('drop', e => {
    e.preventDefault();
    dropZone.classList.remove('dragging');
    openFile(e.dataTransfer.files[0]);
});

// Tab indents instead of leaving the editor.
editor.addEventListener('keydown', e => {
    if (e.key !== 'Tab' || e.shiftKey || e.ctrlKey || e.altKey || e.metaKey) return;
    e.preventDefault();
    editor.setRangeText('  ', editor.selectionStart, editor.selectionEnd, 'end');
    scheduleUpdate();
});

let timer = null;
function scheduleUpdate() {
    clearTimeout(timer);
    timer = setTimeout(update, 250);
}
editor.addEventListener('input', scheduleUpdate);
form.addEventListener('input', scheduleUpdate);
form.addEventListener('submit', e => e.preventDefault());

$('fit').addEventListener('change', e => preview.classList.toggle('fit', e.target.checked));

setUpPatternsDialog({ getText: () => editor.value, setText });

// ------------------------------------------------------------ start

const saved = loadState();
applyFormValues(saved.options);
editor.value = saved.json ?? JSON.stringify(EXAMPLES.coastal.doc, null, 2);
update();
