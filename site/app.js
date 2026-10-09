// Paste page: edit JSON, see validation messages and a live preview, download
// the log as SVG or PNG, or print it to PDF. Everything runs in the browser.
import { renderBoringLog, validateBoringLog, BoringLogError, agsToBoringLogs, looksLikeAgs, diggsToBoringLogs, looksLikeDiggs } from '../src/index.js';
import { syntaxErrorLocation, locatePointer, downloadName, renderOptions, renderOptionsFor, summarize } from './lib.js';
import { setUpPatternsDialog } from './patterns.js';
import { setUpLayoutDialog } from './layout.js';
import { createLog, logName, logLocation, restoreLogs, saveLogs, addLogs, removeLog, uniqueNames } from './logs.js';
import { setUpMap } from './map.js';
import { makeZip } from './zip.js';
import coastal from '../tests/fixtures/coastal-style.json' with { type: 'json' };
import vspdb from '../tests/fixtures/vspdb-style.json' with { type: 'json' };
import dense from '../tests/fixtures/dense-text.json' with { type: 'json' };
import minimal from '../tests/fixtures/minimal.json' with { type: 'json' };
import nas1 from '../examples/NAS-1.json' with { type: 'json' };
import nas2 from '../examples/NAS-2.json' with { type: 'json' };
import nas3 from '../examples/NAS-3.json' with { type: 'json' };
import nas4 from '../examples/NAS-4.json' with { type: 'json' };

const EXAMPLES = {
    coastal: { label: 'Coastal boring (metric, lab data)', doc: coastal },
    vspdb: { label: 'Treasure Island boring (US units, SPT)', doc: vspdb },
    dense: { label: 'Thin layers with long descriptions', doc: dense },
    minimal: { label: 'Minimal (one layer)', doc: minimal },
    nantou_site: { label: 'Nantou site: NAS-1 to NAS-4 (four real borings, opens four tabs)', docs: [nas1, nas2, nas3, nas4] },
};
const STORAGE_KEY = 'boring-log-viewer-logs-only:v1'; // separate from the full version's

const $ = id => document.getElementById(id);
const editor = $('json');
const preview = $('preview');
const messages = $('messages');
const status = $('status');
const form = $('options');

let current = null; // { svg, doc } for the preview currently shown

// The open logs; the editor shows logs[active].
let logs = [createLog()];
let active = 0;

let view = 'log';          // what the preview shows (only the log in this version)

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
        logs[active].text = editor.value;
        localStorage.setItem(STORAGE_KEY, JSON.stringify({ ...saveLogs(logs, active), options: formValues() }));
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
        references: form.references.checked,
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
    renderTabs();
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
        const svg = renderBoringLog(doc, renderOptionsFor(doc, formValues()));
        form.width.title = doc?.layout?.width > 0 ? `The log uses the width in its layout (${doc.layout.width} px)` : '';
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
    showView();
}

// What the preview shows: the log in the editor.
function shown() {
    return current ? { svg: current.svg, name: downloadName(current.doc, 'x').replace(/\.x$/, '') } : null;
}

// Shows only the options that apply to the log view.
function showViewOptions() {
    for (const el of document.querySelectorAll('[data-views]')) el.hidden = !el.dataset.views.split(' ').includes(view);
    $('download-all').hidden = logs.filter(l => l.text.trim()).length < 2;
}

function showView() {
    showViewOptions();
    const item = shown();
    // The renderer escapes all user text, so its output is safe to insert.
    if (item) preview.innerHTML = item.svg;
    else preview.innerHTML = '<p class="placeholder">The boring log will appear here.</p>';
    for (const button of document.querySelectorAll('[data-download]')) button.disabled = !item;
}

function markStale() {
    if (!current || view !== 'log') return;
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
    const item = shown();
    if (!item) return;
    saveBlob(new Blob([`<?xml version="1.0" encoding="UTF-8"?>\n${item.svg}\n`], { type: 'image/svg+xml' }), `${item.name}.svg`);
});

$('download-png').addEventListener('click', async () => {
    if (!current) return;
    const button = $('download-png');
    button.disabled = true;
    try {
        const item = shown();
        if (item) saveBlob(await svgToPng(item.svg, Number(form.png_scale.value) || 2), `${item.name}.png`);
    } catch (e) {
        setStatus(`PNG export failed: ${e.message}`, 'error');
    } finally {
        button.disabled = !current;
    }
});

$('print').addEventListener('click', () => window.print());

// ------------------------------------------------------------ open logs

const tabs = $('log-tabs');
const importNote = $('import-note');

function note(text) {
    logs[active].note = text ?? '';
    importNote.textContent = text ?? '';
    importNote.hidden = !text;
}

function renderTabs() {
    const items = logs.map((log, i) => {
        const tab = document.createElement('div');
        tab.className = `log-tab${i === active ? ' active' : ''}`;
        const pick = document.createElement('button');
        pick.type = 'button';
        pick.setAttribute('role', 'tab');
        pick.setAttribute('aria-selected', String(i === active));
        pick.textContent = logName(log);
        pick.title = `Show ${logName(log)}`;
        pick.addEventListener('click', () => selectLog(i));
        const close = document.createElement('button');
        close.type = 'button';
        close.className = 'log-close';
        close.textContent = '×';
        close.title = `Close ${logName(log)}`;
        close.setAttribute('aria-label', `Close ${logName(log)}`);
        close.addEventListener('click', () => closeLog(i));
        tab.append(pick, close);
        return tab;
    });
    tabs.replaceChildren(...items);
    items[active]?.scrollIntoView?.({ block: 'nearest', inline: 'nearest' });
    $('log-count').textContent = logs.length > 1 ? `${active + 1} of ${logs.length}` : '';
    $('log-prev').disabled = active === 0;
    $('log-next').disabled = active === logs.length - 1;
    $('download-all').hidden = logs.filter(l => l.text.trim()).length < 2;
    updateMap();
}

// ------------------------------------------------------------ map

const siteMap = setUpMap({
    panel: $('map-panel'), container: $('map'), note: $('map-note'),
    onSelect: i => selectLog(i),
});
$('map-panel').addEventListener('toggle', () => siteMap.refresh());

// Locations are read from each log's JSON; parsing is cached by text.
const locationCache = new Map();
function locationOf(text) {
    if (!locationCache.has(text)) {
        if (locationCache.size > 200) locationCache.clear();
        locationCache.set(text, logLocation(text));
    }
    return locationCache.get(text);
}

function updateMap() {
    const points = logs.map((log, index) => {
        const at = locationOf(index === active ? editor.value : log.text);
        return at && { index, name: logName(log), ...at };
    }).filter(Boolean);
    siteMap.update(points, active, logs.filter(l => l.text.trim()).length);
}

function showActive() {
    editor.value = logs[active].text;
    editor.scrollTop = 0;
    note(logs[active].note);
    update();
}

function selectLog(i) {
    if (i < 0 || i >= logs.length || i === active) return;
    logs[active].text = editor.value;
    active = i;
    showActive();
}

// Closes a log straight away (no confirmation); the files it came from are not changed.
function closeLog(i) {
    logs[active].text = editor.value;
    ({ logs, active } = removeLog(logs, active, i));
    showActive();
}

function openLogs(added) {
    logs[active].text = editor.value;
    ({ logs, active } = addLogs(logs, active, added));
    showActive();
}

$('log-new').addEventListener('click', () => openLogs([createLog()]));
$('log-prev').addEventListener('click', () => selectLog(active - 1));
$('log-next').addEventListener('click', () => selectLog(active + 1));

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
    if (example) openLogs((example.docs ?? [example.doc]).map(doc => createLog(JSON.stringify(doc, null, 2), { name: example.label })));
    exampleSelect.value = '';
});

$('format').addEventListener('click', () => {
    try {
        setText(JSON.stringify(JSON.parse(editor.value), null, 2));
    } catch {
        update(); // shows the syntax error
    }
});

$('clear').addEventListener('click', () => {
    note('');
    setText('');
});

// ------------------------------------------------------------ opening files (JSON, AGS4, DIGGS)

// An AGS4 or DIGGS file becomes one log per borehole with strata.
function convertFile(name, text, format) {
    const converted = format === 'DIGGS' ? diggsToBoringLogs(text) : agsToBoringLogs(text);
    const holes = converted.documents.filter(d => d.document.layers.length);
    const skipped = converted.documents.length - holes.length;
    return holes.map(({ loca_id, document }, i) => {
        const own = converted.warnings.filter(w => w.startsWith(`${loca_id}: `)).map(w => w.slice(loca_id.length + 2));
        const text = `Converted ${loca_id} from ${name} (${format})${holes.length > 1 ? `, borehole ${i + 1} of ${holes.length}` : ''}.`
            + (skipped && i === 0 ? ` ${skipped} borehole(s) without strata were left out.` : '')
            + (own.length ? ` Note: ${own.join('; ')}.` : '') + ` Edit the JSON as usual; the ${format} file itself is not changed.`;
        return createLog(JSON.stringify(document, null, 2), { name: loca_id, note: text });
    });
}

async function openFiles(fileList) {
    const files = [...(fileList ?? [])];
    if (!files.length) return;
    const added = [];
    const problems = [];
    for (const file of files) {
        if (file.size > 20 * 1024 * 1024) {
            problems.push(`${file.name} is larger than 20 MB`);
            continue;
        }
        const text = await file.text();
        try {
            if (/\.ags$/i.test(file.name) || looksLikeAgs(text)) added.push(...convertFile(file.name, text, 'AGS4'));
            else if (looksLikeDiggs(text)) added.push(...convertFile(file.name, text, 'DIGGS'));
            else added.push(createLog(text, { name: file.name.replace(/\.json$/i, '') }));
        } catch (e) {
            problems.push(`${file.name}: ${e.message}`);
        }
    }
    if (added.length) openLogs(added);
    if (problems.length) setStatus(`Not opened: ${problems.join('; ')}.`, 'error');
    else if (added.length > 1) setStatus(`Opened ${added.length} logs. Use the tabs above the editor to switch between them.`, 'ok');
}

$('file').addEventListener('change', e => {
    openFiles(e.target.files);
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
    openFiles(e.dataTransfer.files);
});

// ------------------------------------------------------------ download all logs

$('download-all').addEventListener('click', async () => {
    logs[active].text = editor.value;
    const button = $('download-all');
    button.disabled = true;
    setStatus('Preparing the ZIP file…', 'idle');
    try {
        const scale = Number(form.png_scale.value) || 2;
        const drawn = [];
        const skipped = [];
        for (const log of logs) {
            if (!log.text.trim()) continue;
            try {
                const doc = JSON.parse(log.text);
                // A log without a boring name is named after its tab.
                const named = doc?.metadata?.boring_name ? doc : { metadata: { boring_name: logName(log) } };
                drawn.push({ doc: named, svg: renderBoringLog(doc, renderOptionsFor(doc, formValues())) });
            } catch {
                skipped.push(logName(log));
            }
        }
        const svgNames = uniqueNames(drawn.map(d => downloadName(d.doc, 'svg')));
        const files = [];
        for (const [i, d] of drawn.entries()) {
            files.push({ name: svgNames[i], data: `<?xml version="1.0" encoding="UTF-8"?>\n${d.svg}\n` });
            const png = await svgToPng(d.svg, scale);
            files.push({ name: svgNames[i].replace(/\.svg$/, '.png'), data: new Uint8Array(await png.arrayBuffer()) });
        }
        saveBlob(new Blob([makeZip(files)], { type: 'application/zip' }), 'boring-logs.zip');
        setStatus(`Downloaded ${drawn.length} logs as SVG and PNG.${skipped.length ? ` Not included (errors): ${skipped.join(', ')}.` : ''}`, skipped.length ? 'warning' : 'ok');
    } catch (e) {
        setStatus(`Download failed: ${e.message}`, 'error');
    } finally {
        button.disabled = false;
    }
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
setUpLayoutDialog({ getText: () => editor.value, setText, getOptions: () => renderOptions(formValues()) });

// ------------------------------------------------------------ start

const saved = loadState();
applyFormValues(saved.options);
const restored = restoreLogs(saved);
if (restored) ({ logs, active } = restored);
else logs = [createLog(JSON.stringify(EXAMPLES.coastal.doc, null, 2), { name: EXAMPLES.coastal.label })];
showActive();
