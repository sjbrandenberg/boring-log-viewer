// The state behind the Layout window, and how it becomes the document's
// "layout" (and the "custom" values of samples and specimens). Kept free of the
// DOM so it can be tested.
import { defaultLayout, layoutColumns, BUILT_IN_COLUMNS } from '../src/index.js';

const round = v => Math.round(v * 100) / 100;
const DEFAULT_CUSTOM_WIDTH = { sample: 3, specimen: 3, blank: 4 };
export const SOURCE_NAMES = { sample: 'Value for each sample', specimen: 'Value for each specimen', blank: 'Blank column' };

// { width, font_size, columns: [{ id, show, label, width, builtIn, defaultLabel,
// hasData, always, source, field, decimals }] }: the document's layout (or the
// built-in one, as drawn now), followed in their usual places by the built-in
// columns it leaves out, unticked.
export function layoutState(doc, options = {}) {
    const catalog = layoutColumns(doc, options);
    const byId = new Map(catalog.map(c => [c.id, c]));
    const drawn = defaultLayout(doc, options);
    const given = Array.isArray(doc.layout?.columns) ? doc.layout.columns.map(e => (typeof e === 'string' ? { id: e } : e)) : null;
    const columns = [];
    for (const e of given ?? drawn.columns) {
        const b = byId.get(e.id);
        if (b) {
            columns.push({ id: e.id, show: true, label: e.label ?? '', width: e.width ?? b.width, builtIn: true, defaultLabel: b.label, hasData: b.hasData, always: b.always });
        } else if (e.source && SOURCE_NAMES[e.source]) {
            columns.push({
                id: e.id, show: true, label: e.label ?? '', width: e.width ?? DEFAULT_CUSTOM_WIDTH[e.source], builtIn: false, defaultLabel: e.label ?? e.id,
                source: e.source, field: e.field ?? e.id, ...(e.decimals !== undefined ? { decimals: e.decimals } : {}), hasData: true, always: false,
            });
        }
    }
    // The built-in columns left out, unticked, after the built-in column that
    // usually comes before them.
    for (const b of catalog) {
        if (columns.some(c => c.id === b.id)) continue;
        const before = BUILT_IN_COLUMNS.slice(0, BUILT_IN_COLUMNS.indexOf(b.id)).reverse().find(id => columns.some(c => c.id === id));
        const at = before ? columns.findIndex(c => c.id === before) + 1 : 0;
        columns.splice(at, 0, { id: b.id, show: b.always, label: '', width: b.width, builtIn: true, defaultLabel: b.label, hasData: b.hasData, always: b.always });
    }
    return {
        width: doc.layout?.width ?? drawn.width,
        font_size: doc.layout?.font_size ?? drawn.font_size,
        columns,
    };
}

// The "layout" for the document: the ticked columns in order.
export function layoutFromState(state) {
    const layout = {};
    if (state.width > 0) layout.width = Math.round(state.width);
    if (state.font_size > 0) layout.font_size = state.font_size;
    layout.columns = state.columns.filter(c => c.show || c.always).map(c => {
        const e = { id: c.id };
        if (!c.builtIn) e.source = c.source;
        if (c.width > 0) e.width = round(c.width);
        const label = String(c.label ?? '').trim();
        // A custom column's heading is always kept; a built-in one's only when changed.
        if (label && (!c.builtIn || label !== c.defaultLabel)) e.label = label;
        if (!c.builtIn && c.source !== 'blank') {
            if (c.field && c.field !== c.id) e.field = c.field;
            if (Number.isInteger(c.decimals)) e.decimals = c.decimals;
        }
        return e;
    });
    return layout;
}

// An id for a new custom column, from its heading: "PP (tsf)" -> "pp_tsf".
export function newColumnId(heading, taken) {
    let base = String(heading ?? '').toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 28);
    if (!/^[a-z]/.test(base)) base = `col${base ? `_${base}` : ''}`.slice(0, 28);
    const used = new Set([...BUILT_IN_COLUMNS, ...taken]);
    let id = base;
    for (let k = 2; used.has(id); k++) id = `${base}_${k}`;
    return id;
}

// A typed value: a number when it reads as one, else the text; '' for none.
export function parseCustomValue(text) {
    const t = String(text ?? '').trim();
    if (t === '') return undefined;
    return /^[-+]?(\d+\.?\d*|\.\d+)([eE][-+]?\d+)?$/.test(t) ? Number(t) : t;
}

const depths = (top, bottom) => (bottom !== undefined && bottom !== top ? `${top}–${bottom}` : `${top}`);

// The samples or specimens a custom column takes values from:
// [{ sample, specimen (index or undefined), label, value }].
export function customTargets(doc, source, field) {
    const out = [];
    (Array.isArray(doc.samples) ? doc.samples : []).forEach((s, i) => {
        const sampleLabel = s?.name ?? `Sample at ${depths(s?.top, s?.bottom)}`;
        if (source === 'sample') {
            out.push({ sample: i, label: `${sampleLabel} (${depths(s?.top, s?.bottom)})`, value: s?.custom?.[field] });
            return;
        }
        (Array.isArray(s?.specimens) ? s.specimens : []).forEach((sp, k) => {
            const at = sp?.top !== undefined ? ` (${depths(sp.top, sp.bottom)})` : '';
            out.push({ sample: i, specimen: k, label: `${sampleLabel} / ${sp?.name ?? `specimen ${k + 1}`}${at}`, value: sp?.custom?.[field] });
        });
    });
    return out;
}

// Sets (or, for undefined, removes) one custom value in the document, in place.
export function setCustomValue(doc, target, field, value) {
    const sample = doc.samples?.[target.sample];
    const owner = target.specimen === undefined ? sample : sample?.specimens?.[target.specimen];
    if (!owner) return;
    if (value === undefined) {
        if (owner.custom) {
            delete owner.custom[field];
            if (!Object.keys(owner.custom).length) delete owner.custom;
        }
    } else {
        owner.custom = { ...owner.custom, [field]: value };
    }
}

// Removes a custom column's values from every sample or specimen.
export function clearCustomValues(doc, source, field) {
    for (const t of customTargets(doc, source, field)) setCustomValue(doc, t, field, undefined);
}
