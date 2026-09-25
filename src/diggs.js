// DIGGS import: converts a DIGGS XML file (Data Interchange for Geotechnical and
// Geoenvironmental Specialists, https://diggsml.org; versions 2.5, 2.6 and 3.x)
// into boring log documents, one per borehole. Pure JavaScript with its own
// small XML reader, so the web page and the API use the same code.
//
// Read: Project, Borehole (name, location, dates, construction method and rig,
// roles, remarks, water strikes), LithologySystem/LithologyObservation (strata;
// a description is composed from color, constituents, consistency and moisture
// when lithDescription is empty), SamplingActivity (samples), and Test results:
// SPT (DrivenPenetrationTest drive sets and N-value), water content, Atterberg
// limits, fines, dry density, specific gravity and USCS symbol. Depths are in
// each borehole's linear referencing units (ft or m); CPT soundings are skipped.
import { USCS_SYMBOLS } from './classify.js';

export class DiggsError extends Error {}

// ---------------------------------------------------------------- XML

const ENTITIES = { lt: '<', gt: '>', amp: '&', quot: '"', apos: "'" };
const decode = s => s.replace(/&(#x[0-9a-f]+|#\d+|\w+);/gi, (m, e) => {
    if (e[0] === '#') return String.fromCodePoint(e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : Number(e.slice(1)));
    return ENTITIES[e] ?? m;
});

/**
 * Parses XML into { name (local name), qname, attrs, children, text }.
 * No DTDs or external entities are processed.
 */
export function parseXml(text) {
    const src = String(text ?? '').replace(/^﻿/, '');
    const root = { name: '#document', children: [], text: '' };
    const stack = [root];
    const re = /<!--[\s\S]*?-->|<\?[\s\S]*?\?>|<!\[CDATA\[([\s\S]*?)\]\]>|<!DOCTYPE[^>[]*(\[[\s\S]*?\])?\s*>|<\/\s*([^\s>]+)\s*>|<([^\s/>!?]+)((?:\s+[^\s=/>]+\s*=\s*(?:"[^"]*"|'[^']*'))*)\s*(\/?)>|([^<]+)|</g;
    let m;
    while ((m = re.exec(src))) {
        const [whole, cdata, , close, open, attrSrc, selfClose, textPart] = m;
        const top = stack[stack.length - 1];
        if (cdata !== undefined) top.text += cdata;
        else if (textPart !== undefined) top.text += decode(textPart);
        else if (close !== undefined) {
            if (stack.length < 2 || top.qname !== close) throw new DiggsError(`XML: </${close}> doesn't match <${top.qname ?? '?'}>`);
            stack.pop();
        } else if (open !== undefined) {
            const attrs = {};
            for (const a of attrSrc.matchAll(/([^\s=/>]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g)) attrs[a[1]] = decode(a[2] ?? a[3]);
            const el = { name: open.replace(/^.*:/, ''), qname: open, attrs, children: [], text: '', parent: top };
            top.children.push(el);
            if (!selfClose) stack.push(el);
        } else if (whole === '<') {
            throw new DiggsError('XML: a "<" that does not start a tag');
        }
    }
    if (stack.length > 1) throw new DiggsError(`XML: <${stack[stack.length - 1].qname}> is never closed`);
    const doc = root.children[0];
    if (!doc) throw new DiggsError('no XML element found');
    return doc;
}

const kids = (el, name) => (el?.children ?? []).filter(c => c.name === name);
const kid = (el, name) => (el?.children ?? []).find(c => c.name === name);
// First descendant along a path of local names, e.g. path(bh, 'referencePoint', 'PointLocation', 'pos').
const path = (el, ...names) => names.reduce((e, n) => kid(e, n), el);
function* descendants(el, name) {
    for (const c of el?.children ?? []) {
        if (c.name === name) yield c;
        yield* descendants(c, name);
    }
}
const all = (el, name) => [...descendants(el, name)];
const txt = el => (el?.text ?? '').trim();
const id = el => el?.attrs?.['gml:id'] ?? el?.attrs?.id;
const ref = el => (el?.attrs?.['xlink:href'] ?? '').replace(/^#/, '');
const nums = s => String(s ?? '').trim().split(/[\s,]+/).filter(Boolean).map(Number);

// ---------------------------------------------------------------- units

const TO_M = { m: 1, ft: 0.3048, in: 0.0254, cm: 0.01, mm: 0.001, ftus: 0.3048006 };
const unitOf = u => {
    const s = String(u ?? '').trim().toLowerCase().replace(/[^a-z]/g, '');
    if (['ft', 'feet', 'foot', 'mdft', 'usft'].includes(s)) return 'ft';
    if (['m', 'meter', 'metre', 'meters', 'metres', 'mdm'].includes(s)) return 'm';
    if (['in', 'inch', 'inches'].includes(s)) return 'in';
    if (['cm', 'mm'].includes(s)) return s;
    return null;
};
const convert = (value, from, to) => (from && to && TO_M[from] && TO_M[to] ? (value * TO_M[from]) / TO_M[to] : value);
const round = (v, d = 3) => Math.round(v * 10 ** d) / 10 ** d;

// ---------------------------------------------------------------- sampler and property names

const SAMPLER_RULES = [
    ['SPT', /^(ss|spt)$|spt|split/i],
    ['ModCal', /^(mc|cal)$|california|mod\.? ?cal/i],
    ['Shelby', /^(st|sh|tw|ut)$|shelby|thin[- ]?wall/i],
    ['Piston', /^p$|piston/i],
    ['Core', /^(nx|nq|hq|bq|pq|rc|c)$|core/i],
    ['DirectPush', /^(dp|ws)$|direct[- ]?push|window/i],
    ['Bulk', /^(b|bs|bag)$|bulk/i],
    ['Grab', /grab/i],
    ['Auger', /^a$|auger|cutting/i],
];
const samplerType = name => SAMPLER_RULES.find(([, re]) => re.test(String(name ?? '').trim()))?.[0] ?? 'Other';

// Result properties, matched on their class and name with case, punctuation and
// underscores ignored.
const PROPERTY_RULES = [
    ['blow_count', /^n ?value$|^spt n|^nvalue|^n$/],
    ['water_content', /water content|moisture content|natural m ?c$|^w ?c$/],
    ['liquid_limit', /liquid limit|^ll$/],
    ['plastic_limit', /plastic limit|^pl$/],
    ['nonplastic', /non ?plastic/],
    ['fines_content', /percent fines|fines content|passing (no )?200|^fines$/],
    ['dry_density', /dry density|density dry|dry unit weight|unit weight dry/],
    ['specific_gravity', /specific gravity/],
    ['uscs', /^uscs( group)? symbol$|^usc symbol$|^usc classification$|^uscs$|lab classification/],
];
const norm = s => String(s ?? '').toLowerCase().replace(/&lt;|lt;/g, '<').replace(/[_,./()-]+/g, ' ').replace(/\s+/g, ' ').trim();
const propertyField = (cls, name) => {
    for (const [field, re] of PROPERTY_RULES) if (re.test(norm(cls)) || re.test(norm(name))) return field;
    return null;
};
const USCS_RE = new RegExp(`^(${USCS_SYMBOLS.join('|')})([-/](${USCS_SYMBOLS.join('|')}))?$`);
const uscsValue = v => {
    const s = String(v ?? '').trim().toUpperCase().replace(/^\(|\)$/g, '');
    return USCS_RE.test(s) ? s.replace('/', '-') : undefined;
};

// ---------------------------------------------------------------- conversion

/**
 * Converts DIGGS XML text to boring log documents.
 * @returns {{ documents: Array<{ loca_id: string, document: object }>, warnings: string[] }}
 */
export function diggsToBoringLogs(text) {
    const root = parseXml(text);
    if (root.name !== 'Diggs') throw new DiggsError(`not a DIGGS file (root element <${root.qname}>)`);
    const warnings = [];
    const project = all(root, 'Project')[0];
    const projectName = txt(kid(project, 'name'));

    const boreholes = [...all(root, 'Borehole'), ...all(root, 'TestPit'), ...all(root, 'Trench')];
    if (!boreholes.length) throw new DiggsError('the file has no Borehole (CPT soundings are not drawn)');
    const byRef = new Map(); // borehole gml:id -> { bh, lrsUnits: Map(lrs id -> unit), ... }

    for (const bh of boreholes) {
        // Linear referencing: the units depths along the hole are given in.
        const lrsUnits = new Map();
        for (const lrs of all(bh, 'LinearSpatialReferenceSystem')) {
            const u = unitOf(txt(path(lrs, 'lrm', 'LinearReferencingMethod', 'units')))
                ?? unitOf((kid(lrs, 'lrm')?.attrs?.['xlink:href'] ?? '').replace(/^.*#/, ''));
            lrsUnits.set(id(lrs), u);
        }
        const depthUnit = [...lrsUnits.values()].find(Boolean) ?? unitOf(kid(bh, 'totalMeasuredDepth')?.attrs?.uom) ?? 'm';
        byRef.set(id(bh), { bh, lrsUnits, depthUnit, layers: [], samples: [], tests: [] });
    }
    const holeFor = el => byRef.get(ref(kid(el, 'samplingFeatureRef')));
    // Depths of a LinearExtent/PointLocation in the hole's depth unit.
    const depthsOf = (hole, extent) => {
        const posEl = kid(extent, 'posList') ?? kid(extent, 'pos');
        const srs = (posEl?.attrs?.srsName ?? extent?.attrs?.srsName ?? '').replace(/^#/, '');
        const unit = hole.lrsUnits.get(srs) ?? hole.depthUnit;
        return nums(txt(posEl)).filter(Number.isFinite).map(v => round(convert(v, unit, hole.depthUnit)));
    };

    // Strata
    for (const system of all(root, 'LithologySystem')) {
        const hole = holeFor(system);
        if (!hole) continue;
        for (const obs of all(system, 'LithologyObservation')) {
            const [top, base] = depthsOf(hole, path(obs, 'location', 'LinearExtent'));
            const lith = path(obs, 'primaryLithology', 'Lithology');
            const description = lithologyText(lith) || txt(kid(obs, 'unitName'));
            const uscs = uscsValue(txt(kid(lith, 'classificationCode'))) ?? uscsValue(txt(kid(lith, 'legendCode')));
            // A stratum given only by its USCS code is still drawn (pattern and USCS column).
            if (top === undefined || (!description && !uscs)) continue;
            hole.layers.push({ top, bottom: base, ...(description ? { description } : {}), ...(uscs ? { uscs } : {}) });
        }
    }

    // Samples
    const sampleIds = new Map(); // SamplingActivity / SampleProduced / Sample id -> our sample
    for (const act of all(root, 'SamplingActivity')) {
        const hole = holeFor(act);
        if (!hole) continue;
        const [top, base] = depthsOf(hole, path(act, 'samplingLocation', 'LinearExtent'));
        if (top === undefined) continue;
        const method = txt(path(act, 'samplingMethod', 'Specification', 'name')) || txt(path(act, 'samplingMethod', 'Specification', 'shortMethodName'));
        const type = samplerType(method);
        const s = { top, bottom: base > top ? base : top + convert(type === 'SPT' ? 0.45 : 0.15, 'm', hole.depthUnit), name: txt(kid(act, 'name')) || undefined, type };
        const rec = kid(act, 'totalSampleRecoveryLength');
        if (rec && Number.isFinite(Number(txt(rec)))) s.recovery = round(convert(Number(txt(rec)), unitOf(rec.attrs.uom) ?? hole.depthUnit, hole.depthUnit));
        if (type === 'Other' && method) s.remarks = `sampling method ${method}`;
        hole.samples.push(s);
        for (const e of [act, ...all(act, 'SampleProduced'), ...all(act, 'Sample')]) if (id(e)) sampleIds.set(id(e), s);
    }
    for (const smp of all(root, 'Sample')) {
        const act = ref(kid(smp, 'samplingActivityRef')) || ref(kid(smp, 'sampleProducedRef'));
        if (act && sampleIds.has(act) && id(smp)) sampleIds.set(id(smp), sampleIds.get(act));
    }
    for (const spec of all(root, 'SoilSpecimen')) {
        const s = sampleIds.get(ref(kid(spec, 'sampleRef')));
        if (s && id(spec)) sampleIds.set(id(spec), s);
    }

    // Test results
    for (const test of all(root, 'Test')) {
        const hole = holeFor(test);
        if (!hole) continue;
        const result = path(test, 'outcome', 'TestResult');
        const [top, base] = depthsOf(hole, path(result, 'location', 'LinearExtent') ?? path(result, 'location', 'PointLocation'));
        const values = {};
        for (const set of all(result, 'ResultSet')) {
            const props = all(set, 'Property').sort((a, b) => Number(a.attrs.index ?? 0) - Number(b.attrs.index ?? 0));
            const dv = kid(set, 'dataValues');
            const cs = dv?.attrs?.cs ?? ',';
            const ts = dv?.attrs?.ts ?? ' ';
            const rows = txt(dv).split(ts === ' ' ? /\s+/ : ts).filter(r => r !== '');
            // One tuple per result; some files separate the values of a single
            // tuple with ts instead of cs ("31 17" for LL and PL): read those as one row.
            const row = props.length > 1 && rows.length === props.length && rows.every(r => !r.includes(cs)) ? rows : (rows[0] ?? '').split(cs);
            props.forEach((p, k) => {
                const field = propertyField(txt(kid(p, 'propertyClass')), txt(kid(p, 'propertyName')));
                const raw = (row[k] ?? '').trim();
                if (field && raw !== '' && values[field] === undefined) values[field] = { raw, uom: txt(kid(p, 'uom')) };
            });
        }
        const spt = all(test, 'DrivenPenetrationTest')[0];
        const blows = spt ? all(spt, 'DriveSet').sort((a, b) => Number(txt(kid(a, 'index'))) - Number(txt(kid(b, 'index')))).map(d => Number(txt(kid(d, 'blowCount')))) : [];
        if (!Object.keys(values).length && !blows.length) continue;
        hole.tests.push({ top, base, values, blows, spt: Boolean(spt) || values.blow_count !== undefined, sample: sampleIds.get(ref(kid(test, 'sampleRef')) || ref(kid(test, 'specimenRef'))) });
    }

    const documents = [...byRef.values()].map(hole => {
        const { bh } = hole;
        const name = txt(kid(bh, 'name')) || id(bh);
        const say = message => warnings.push(`${name}: ${message}`);
        const u = hole.depthUnit === 'ft' ? 'ft' : 'm';

        // Strata are the observations over an interval. One at a single depth inside a
        // stratum ("@ 4.5'; reddish brown with gray") is a depth note; outside every
        // stratum it starts one, ending at the next (or the hole's depth).
        const total = kid(bh, 'totalMeasuredDepth');
        const totalDepth = total ? convert(Number(txt(total)), unitOf(total.attrs.uom) ?? u, u) : undefined;
        const seen = new Set();
        const unique = hole.layers.filter(l => {
            const key = `${l.top}|${l.bottom}|${l.description}|${l.uscs}`;
            return !seen.has(key) && seen.add(key);
        });
        const intervals = unique.filter(l => l.bottom > l.top);
        const depth_notes = [];
        const starts = [];
        for (const l of unique.filter(x => !(x.bottom > x.top))) {
            if (intervals.some(i => i.top <= l.top && l.top < i.bottom)) {
                if (l.description) depth_notes.push({ depth: l.top, description: l.description });
            } else {
                starts.push({ ...l, bottom: undefined });
            }
        }
        const layers = [...intervals, ...starts].sort((a, b) => a.top - b.top || (a.bottom === undefined) - (b.bottom === undefined));
        layers.forEach((l, k) => { if (l.bottom === undefined) l.bottom = layers[k + 1]?.top ?? totalDepth; });
        const kept = layers.filter(l => l.bottom > l.top);
        if (kept.length < layers.length) say(`${layers.length - kept.length} stratum(s) without a base left out`);

        // Tests onto samples: by reference, else the sample at the same depth, else a new one.
        const samples = hole.samples;
        for (const t of hole.tests) {
            let s = t.sample ?? samples.find(x => t.top !== undefined && Math.abs(x.top - t.top) < 1e-6 && (!t.spt || x.type === 'SPT'))
                ?? samples.find(x => t.top !== undefined && Math.abs(x.top - t.top) < 1e-6);
            if (!s) {
                if (t.top === undefined) continue;
                s = { top: t.top, bottom: t.base > t.top ? t.base : t.top + convert(t.spt ? 0.45 : 0.15, 'm', u), type: t.spt ? 'SPT' : 'Other' };
                samples.push(s);
            }
            applyTest(s, t, u);
        }

        const groundwater = [];
        for (const ws of all(bh, 'WaterStrike')) {
            for (const reading of all(ws, 'WaterStrikeReading')) {
                const [depth] = depthsOf(hole, path(reading, 'waterLocation', 'PointLocation') ?? path(reading, 'waterLocation', 'LinearExtent'));
                if (depth === undefined) continue;
                const note = [txt(kid(ws, 'status')), txt(path(ws, 'remark', 'Remark', 'content'))].filter(Boolean).join('; ');
                groundwater.push({ depth, ...(note ? { note } : {}) });
            }
        }

        // Unit weights were read as kN/m3; a log in feet reports them in pcf.
        if (u === 'ft') for (const s of samples) if (s.dry_unit_weight !== undefined) s.dry_unit_weight = round(s.dry_unit_weight * 6.36588, 1);
        const metadata = boreholeMetadata(bh, projectName, u);
        if (!kept.length) say('no strata (LithologyObservation with a depth and description); add layers before drawing');
        const clean = o => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined && v !== ''));
        return {
            loca_id: name,
            document: {
                schema_version: '1.0',
                units: { length: u, unit_weight: u === 'ft' ? 'pcf' : 'kN/m3', diameter: u === 'ft' ? 'in' : 'mm' },
                metadata: clean(metadata),
                layers: kept,
                samples: samples.sort((a, b) => a.top - b.top).map(clean),
                groundwater,
                ...(depth_notes.length ? { depth_notes: depth_notes.sort((a, b) => a.depth - b.depth) } : {}),
            },
        };
    });
    return { documents, warnings };
}

// A stratum's description: lithDescription, else composed from its parts
// ("Stiff, brown and gray mottled SILT AND CLAY, some sand, trace stone fragments, damp").
function lithologyText(lith) {
    const own = txt(kid(lith, 'lithDescription')) || txt(path(lith, 'lithProperties', 'LithProperties', 'remark', 'Remark', 'content'));
    if (own) return own;
    const colors = all(lith, 'colorName').map(txt).filter(Boolean);
    const cons = kids(lith, 'constituent').map(c => kid(c, 'Constituent')).filter(Boolean);
    const major = cons.filter(c => /major/i.test(txt(kid(c, 'abundanceCode')))).map(c => txt(kid(c, 'codeValue'))).filter(Boolean);
    const minor = cons.filter(c => !/major/i.test(txt(kid(c, 'abundanceCode')))).map(c => txt(kid(c, 'codeValue'))).filter(Boolean);
    if (!major.length && !minor.length) return '';
    const field = path(lith, 'fieldProperties', 'FieldProperties');
    const consistency = txt(kid(field, 'consistency')) || txt(kid(field, 'relativeDensity'));
    const moisture = txt(kid(field, 'moistureCondition'));
    const head = [colors.join(' '), major.join(' and ').toUpperCase()].filter(Boolean).join(' ');
    const text = [consistency, head, ...minor, moisture].filter(Boolean).join(', ');
    return text.charAt(0).toUpperCase() + text.slice(1);
}

function applyTest(s, t, u) {
    const v = t.values;
    const n = v.blow_count ? Number(v.blow_count.raw) : NaN;
    if (t.spt) s.type = 'SPT';
    if (Number.isFinite(n)) s.blow_count = n;
    else if (v.blow_count) s.blow_count = v.blow_count.raw;
    if (t.blows.length && t.blows.every(Number.isFinite)) {
        s.blows = t.blows;
        if (s.blow_count === undefined && t.blows.length >= 3) s.blow_count = t.blows.slice(-2).reduce((a, b) => a + b, 0);
    }
    const number = f => (v[f] && Number.isFinite(Number(v[f].raw)) ? round(Number(v[f].raw), 2) : undefined);
    if (number('water_content') !== undefined) s.water_content = number('water_content');
    if (/^(true|yes|np|1)$/i.test(v.nonplastic?.raw ?? '') || /^np$/i.test(v.liquid_limit?.raw ?? '')) s.nonplastic = true;
    if (number('liquid_limit') !== undefined) s.liquid_limit = number('liquid_limit');
    if (number('plastic_limit') !== undefined) s.plastic_limit = number('plastic_limit');
    if (number('fines_content') !== undefined) s.fines_content = number('fines_content');
    if (number('specific_gravity') !== undefined) s.specific_gravity = number('specific_gravity');
    const dry = number('dry_density');
    if (dry > 0) {
        // To kN/m3: pcf, Mg/m3 (or g/cm3), or already kN/m3 (guessed from the size when no unit is given).
        const uom = norm(v.dry_density.uom);
        const knm3 = /pcf|lb/.test(uom) || (!uom && dry > 30) ? dry / 6.36588 : /kn/.test(uom) || (!uom && dry > 5) ? dry : dry * 9.807;
        s.dry_unit_weight = round(knm3, 2);
    }
    const uscs = uscsValue(v.uscs?.raw);
    if (uscs && !s.uscs) s.uscs = uscs;
}

function boreholeMetadata(bh, projectName, u) {
    const pos = nums(txt(path(bh, 'referencePoint', 'PointLocation', 'pos')));
    const labels = String(path(bh, 'referencePoint', 'PointLocation', 'pos')?.attrs?.uomLabels ?? path(bh, 'referencePoint', 'PointLocation')?.attrs?.uomLabels ?? '').split(/\s+/);
    let lat;
    let lon;
    if (pos.length >= 2) {
        // DIGGS writes x y (longitude latitude) for EPSG 4326; tolerate the reverse.
        [lon, lat] = Math.abs(pos[0]) > 90 || Math.abs(pos[1]) <= 90 ? [pos[0], pos[1]] : [pos[1], pos[0]];
        if (Math.abs(lat) > 90 || Math.abs(lon) > 180) lat = lon = undefined;
    }
    const elevUnit = unitOf(labels[2]) ?? u;
    const elevation = pos.length >= 3 && Number.isFinite(pos[2]) ? round(convert(pos[2], elevUnit, u)) : undefined;
    const time = path(bh, 'whenConstructed', 'TimeInterval');
    const date = el => (txt(el).match(/^\d{4}-\d{2}-\d{2}/) ?? [])[0];
    const roles = kids(bh, 'role').map(r => kid(r, 'Role')).map(r => ({ role: txt(kid(r, 'rolePerformed')).toLowerCase(), who: txt(path(r, 'businessAssociate', 'BusinessAssociate', 'name')) }));
    const roleOf = re => roles.find(r => re.test(r.role) && r.who)?.who;
    const method = all(bh, 'BoreholeConstructionMethod')[0];
    const spec = path(method, 'constructionMethod', 'Specification');
    return {
        project: projectName || undefined,
        boring_name: txt(kid(bh, 'name')) || id(bh),
        latitude: lat,
        longitude: lon,
        elevation,
        start_date: date(kid(time, 'start')),
        end_date: date(kid(time, 'end')),
        boring_type: txt(kid(spec, 'name')) || txt(kid(spec, 'shortMethodName')) || txt(kid(method, 'name')) || undefined,
        rig: txt(path(method, 'constructionEquipment', 'Equipment', 'name')) || undefined,
        logged_by: roleOf(/logger|logged/),
        driller: roleOf(/drilling (firm|contractor|company)/) ?? roleOf(/driller/),
        notes: kids(bh, 'remark').map(r => txt(path(r, 'Remark', 'content'))).filter(Boolean).join('; ') || undefined,
    };
}

/** True if text looks like a DIGGS XML file. */
export const looksLikeDiggs = text => /^\s*(﻿)?\s*(<\?xml[^>]*\?>\s*)?(<!--[\s\S]*?-->\s*)*<([\w-]+:)?Diggs[\s>]/.test(String(text ?? '').slice(0, 4000));
