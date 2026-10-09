// Layout window: choose the log's columns, their order, relative widths and
// headings, add custom columns and fill in their values, without editing the
// JSON. Every change is written to the log's "layout" (and the samples' and
// specimens' "custom" values) straight away, so the preview follows.
import { BoringLogError } from '../src/index.js';
import {
    layoutState, layoutFromState, newColumnId, parseCustomValue, customTargets, setCustomValue, clearCustomValues, SOURCE_NAMES,
} from './layout-state.js';

export function setUpLayoutDialog({ getText, setText, getOptions }) {
    const $ = id => document.getElementById(id);
    const dialog = $('layout-dialog');
    const rows = $('layout-rows');
    const bar = $('layout-bar');
    const widthInput = $('layout-width');
    const fontInput = $('layout-font');
    const errorBox = $('layout-error');
    const body = $('layout-body');
    const addForm = $('layout-add');
    let doc = null;          // the log being edited
    let state = null;        // the editor's state (see layout-state.js)
    let original = '';       // the JSON when the window opened, for Undo
    const open = new Set();  // custom columns whose values are shown

    const showError = text => {
        errorBox.textContent = text ?? '';
        errorBox.hidden = !text;
        body.hidden = Boolean(text);
    };

    // Writes the state into the log.
    function commit() {
        doc.layout = layoutFromState(state);
        setText(JSON.stringify(doc, null, 2));
        drawBar();
    }

    function load() {
        try {
            doc = JSON.parse(getText());
        } catch {
            showError('The JSON has a syntax error. Fix it (see the messages under the editor), then open this window again.');
            return false;
        }
        try {
            state = layoutState(doc, getOptions());
        } catch (e) {
            if (!(e instanceof BoringLogError)) throw e;
            showError('This log has errors that stop it from being drawn. Fix them (see the messages under the editor), then open this window again.');
            return false;
        }
        showError('');
        widthInput.value = state.width;
        fontInput.value = state.font_size;
        draw();
        return true;
    }

    const headingOf = c => String(c.label ?? '').trim() || c.defaultLabel;

    // A small picture of the log's headings: each column as wide as its share,
    // narrow ones with their heading turned upwards as on the log. Clicking one
    // goes to its row in the table.
    function drawBar() {
        bar.replaceChildren();
        const shown = state.columns.filter(x => x.show || x.always);
        const total = shown.reduce((n, c) => n + c.width, 0) || 1;
        const barWidth = bar.clientWidth || 800;
        for (const c of shown) {
            const seg = document.createElement('button');
            seg.type = 'button';
            seg.style.flex = `${Math.max(c.width, 0.01)} 1 0`;
            const px = (barWidth * c.width) / total;
            seg.className = `${px > 90 ? 'level' : 'vertical'}${c.builtIn ? '' : ' custom'}`;
            const text = document.createElement('span');
            text.textContent = headingOf(c);
            seg.append(text);
            seg.title = `${headingOf(c)}: width ${c.width} (${Math.round((100 * c.width) / total)}%)`;
            seg.addEventListener('click', () => {
                const row = rows.querySelector(`tr[data-id="${c.id}"]`);
                if (!row) return;
                row.scrollIntoView({ block: 'center', behavior: 'smooth' });
                row.classList.add('flash');
                setTimeout(() => row.classList.remove('flash'), 900);
                row.querySelector('input[type="number"]')?.focus({ preventScroll: true });
            });
            bar.append(seg);
        }
    }

    function button(text, title, onClick, disabled = false) {
        const b = document.createElement('button');
        b.type = 'button';
        b.textContent = text;
        if (title) b.title = title;
        b.disabled = disabled;
        b.addEventListener('click', onClick);
        return b;
    }

    function move(i, step) {
        const j = i + step;
        if (j < 0 || j >= state.columns.length) return;
        [state.columns[i], state.columns[j]] = [state.columns[j], state.columns[i]];
        commit();
        draw();
    }

    function valuesRow(c) {
        const tr = document.createElement('tr');
        tr.className = 'layout-values';
        const td = document.createElement('td');
        td.colSpan = 6;
        const targets = customTargets(doc, c.source, c.field);
        if (!targets.length) {
            td.textContent = c.source === 'specimen' ? 'This log has no specimens to give values to.' : 'This log has no samples to give values to.';
        } else {
            const note = document.createElement('p');
            note.className = 'muted';
            note.textContent = `Values for "${headingOf(c)}". Numbers are shown as you type them; the column appears in the log once it has a value.`;
            const grid = document.createElement('div');
            grid.className = 'grid';
            for (const t of targets) {
                const label = document.createElement('label');
                const name = document.createElement('span');
                name.textContent = t.label;
                const input = document.createElement('input');
                input.value = t.value ?? '';
                input.addEventListener('change', () => {
                    setCustomValue(doc, t, c.field, parseCustomValue(input.value));
                    commit();
                });
                label.append(name, input);
                grid.append(label);
            }
            td.append(note, grid);
        }
        tr.append(td);
        return tr;
    }

    function draw() {
        rows.replaceChildren();
        state.columns.forEach((c, i) => {
            const tr = document.createElement('tr');
            tr.dataset.id = c.id;
            if (!c.show && !c.always) tr.className = 'off';

            const show = document.createElement('input');
            show.type = 'checkbox';
            show.checked = c.show || c.always;
            show.disabled = c.always;
            show.title = c.always ? 'Always drawn' : 'Draw this column';
            show.addEventListener('change', () => {
                c.show = show.checked;
                commit();
                draw();
            });

            const name = document.createElement('td');
            name.textContent = c.defaultLabel;
            const kind = document.createElement('span');
            kind.className = 'kind';
            kind.textContent = !c.builtIn ? SOURCE_NAMES[c.source] : c.hasData ? '' : 'No data in this log (not drawn)';
            if (kind.textContent) name.append(kind);

            const heading = document.createElement('input');
            heading.type = 'text';
            heading.value = c.label ?? '';
            heading.placeholder = c.defaultLabel;
            heading.maxLength = 80;
            heading.addEventListener('change', () => {
                c.label = heading.value;
                commit();
            });

            const width = document.createElement('input');
            width.type = 'number';
            width.min = '0.1';
            width.max = '100';
            width.step = '0.1';
            width.value = c.width;
            width.addEventListener('change', () => {
                const v = Number(width.value);
                if (v > 0 && v <= 100) {
                    c.width = v;
                    commit();
                } else {
                    width.value = c.width;
                }
            });

            const order = document.createElement('td');
            order.className = 'order';
            order.append(
                button('↑', 'Move left in the log', () => move(i, -1), i === 0),
                button('↓', 'Move right in the log', () => move(i, 1), i === state.columns.length - 1),
            );

            const extra = document.createElement('td');
            extra.className = 'extra';
            if (!c.builtIn) {
                if (c.source !== 'blank') {
                    extra.append(button(open.has(c.id) ? 'Hide values' : 'Values…', 'Enter this column\'s value for each sample or specimen', () => {
                        if (open.has(c.id)) open.delete(c.id);
                        else open.add(c.id);
                        draw();
                    }));
                }
                extra.append(button('Remove', 'Remove this column and its values', () => {
                    if (c.source !== 'blank') clearCustomValues(doc, c.source, c.field);
                    state.columns.splice(i, 1);
                    open.delete(c.id);
                    commit();
                    draw();
                }));
            }

            const cell = el => {
                const td = document.createElement('td');
                td.append(el);
                return td;
            };
            tr.append(cell(show), name, cell(heading), cell(width), order, extra);
            rows.append(tr);
            if (!c.builtIn && open.has(c.id)) rows.append(valuesRow(c));
        });
        drawBar();
    }

    widthInput.addEventListener('change', () => {
        const v = Number(widthInput.value);
        if (v >= 300 && v <= 4000) {
            state.width = v;
            commit();
        } else {
            widthInput.value = state.width;
        }
    });
    fontInput.addEventListener('change', () => {
        const v = Number(fontInput.value);
        if (v >= 6 && v <= 24) {
            state.font_size = v;
            commit();
        } else {
            fontInput.value = state.font_size;
        }
    });

    addForm.addEventListener('submit', e => {
        e.preventDefault();
        const label = addForm.label.value.trim();
        if (!label) return;
        const source = addForm.source.value;
        const id = newColumnId(label, state.columns.map(c => c.id));
        // New columns go before the remarks, or at the end.
        const at = state.columns.findIndex(c => c.id === 'remarks');
        const column = { id, show: true, label, width: source === 'blank' ? 4 : 3, builtIn: false, defaultLabel: label, source, field: id, hasData: true, always: false };
        state.columns.splice(at >= 0 ? at : state.columns.length, 0, column);
        if (source !== 'blank') open.add(id);
        addForm.label.value = '';
        commit();
        draw();
    });

    $('layout-reset').addEventListener('click', () => {
        delete doc.layout;
        setText(JSON.stringify(doc, null, 2));
        open.clear();
        load();
    });
    $('layout-undo').addEventListener('click', () => {
        setText(original);
        open.clear();
        load();
    });
    $('layout-done').addEventListener('click', () => dialog.close());
    $('layout-x').addEventListener('click', () => dialog.close());

    $('layout-open').addEventListener('click', () => {
        original = getText();
        open.clear();
        dialog.showModal();
        load(); // after opening, so the bar knows its width
    });
}
