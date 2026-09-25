// AGS4 import: converts an AGS4 file (the UK/international geotechnical data
// transfer format, https://www.ags.org.uk/data-format/) into boring log
// documents, one per borehole (LOCA_ID). Pure JavaScript, so the web page and
// the API use the same code.
//
// Groups read: PROJ (project), LOCA (borehole), HDIA (hole diameter), GEOL
// (strata), DETL (depth-related remarks), SAMP (samples), ISPT (SPT results),
// WSTG/WSTD and AGS3-style WSTK (water strikes), and the lab groups LNMC (water
// content), LLPL (Atterberg limits), GRAG (fines), LDEN (dry density) and LPDN
// (particle density). ABBR expands codes such as LOCA_TYPE "CP" to "Cable
// percussion". Everything else is ignored.

export class AgsError extends Error {}

// Splits one AGS line into its quoted fields ("" inside a field is a quote).
function fields(line) {
    const out = [];
    let i = 0;
    while (i < line.length) {
        while (line[i] === ' ' || line[i] === '\t') i++;
        if (line[i] !== '"') {
            // Unquoted field (not allowed by AGS4, but tolerated)
            const end = line.indexOf(',', i);
            out.push(line.slice(i, end < 0 ? undefined : end).trim());
            if (end < 0) break;
            i = end + 1;
            continue;
        }
        let value = '';
        i++;
        for (;;) {
            const q = line.indexOf('"', i);
            if (q < 0) throw new AgsError(`unterminated quote in: ${line.slice(0, 60)}`);
            value += line.slice(i, q);
            if (line[q + 1] === '"') {
                value += '"';
                i = q + 2;
            } else {
                i = q + 1;
                break;
            }
        }
        out.push(value);
        while (line[i] === ' ' || line[i] === '\t') i++;
        if (line[i] === ',') i++;
        else break;
    }
    return out;
}

/**
 * Parses AGS4 text into { GROUP: { headings, units, rows: [{HEADING: value}] } }.
 * @throws AgsError for text that isn't AGS4
 */
export function parseAgs(text) {
    const src = String(text ?? '').replace(/^﻿/, '');
    if (/^\s*"\*\*/m.test(src)) throw new AgsError('this looks like an AGS3 file ("**GROUP" lines); only AGS4 is supported');
    const groups = {};
    let group = null;
    src.split(/\r\n|\n|\r/).forEach((line, n) => {
        if (!line.trim()) return;
        const row = fields(line);
        const kind = row[0];
        if (kind === 'GROUP') {
            group = { name: row[1], headings: [], units: {}, rows: [] };
            groups[row[1]] = group;
        } else if (!group) {
            throw new AgsError(`line ${n + 1}: data before the first "GROUP" line; is this an AGS4 file?`);
        } else if (kind === 'HEADING') {
            group.headings = row.slice(1);
        } else if (kind === 'UNIT') {
            group.headings.forEach((h, k) => { group.units[h] = row[k + 1] ?? ''; });
        } else if (kind === 'DATA') {
            group.rows.push(Object.fromEntries(group.headings.map((h, k) => [h, (row[k + 1] ?? '').trim()])));
        }
    });
    if (!Object.keys(groups).length) throw new AgsError('no AGS groups found; is this an AGS4 file?');
    return groups;
}

const num = v => {
    if (v === undefined || v === null || String(v).trim() === '') return undefined;
    const n = Number(String(v).trim());
    return Number.isFinite(n) ? n : undefined;
};
// AGS dates are yyyy-mm-dd (AGS4 DT) or, in older files, dd/mm/yyyy.
function isoDate(v) {
    if (!v) return undefined;
    const s = String(v).trim();
    const dmY = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/);
    if (dmY) return `${dmY[3]}-${dmY[2].padStart(2, '0')}-${dmY[1].padStart(2, '0')}`;
    const iso = s.match(/^\d{4}-\d{2}-\d{2}/);
    return iso ? iso[0] : s;
}

// AGS4 SAMP_TYPE abbreviations to the viewer's sampler types.
const SAMPLE_TYPES = {
    B: 'Bulk', LB: 'Bulk', BLK: 'Block', D: 'Disturbed', SPT: 'SPT', SPTLS: 'SPT', U: 'Shelby', U100: 'Shelby',
    UT: 'Shelby', TW: 'Shelby', P: 'Piston', C: 'Core', CS: 'Core', CORE: 'Core', WS: 'DirectPush', L: 'DirectPush',
};
const WATER_UNIT_WEIGHT = 9.807; // kN/m3 per Mg/m3

/**
 * Converts AGS4 text to boring log documents.
 * @returns {{ documents: Array<{ loca_id: string, document: object }>, warnings: string[] }}
 */
export function agsToBoringLogs(text) {
    const g = parseAgs(text);
    const rows = name => g[name]?.rows ?? [];
    if (!rows('LOCA').length) throw new AgsError('the file has no LOCA group (boreholes)');
    const warnings = [];
    const abbr = {};
    for (const r of rows('ABBR')) (abbr[r.ABBR_HDNG] ??= {})[r.ABBR_CODE] = r.ABBR_DESC;
    const expand = (heading, code) => (code ? abbr[heading]?.[code] ?? code : undefined);
    const lengthUnit = String(g.GEOL?.units?.GEOL_TOP ?? g.LOCA?.units?.LOCA_FDEP ?? 'm').toLowerCase() === 'ft' ? 'ft' : 'm';
    const proj = rows('PROJ')[0] ?? {};
    const byHole = name => {
        const m = new Map();
        for (const r of rows(name)) {
            if (!m.has(r.LOCA_ID)) m.set(r.LOCA_ID, []);
            m.get(r.LOCA_ID).push(r);
        }
        return m;
    };
    const geol = byHole('GEOL');
    const detl = byHole('DETL');
    const samp = byHole('SAMP');
    const ispt = byHole('ISPT');
    const hdia = byHole('HDIA');
    const water = [byHole('WSTG'), byHole('WSTK')];
    const lab = { LNMC: byHole('LNMC'), LLPL: byHole('LLPL'), GRAG: byHole('GRAG'), LDEN: byHole('LDEN'), LPDN: byHole('LPDN') };

    const documents = rows('LOCA').map(loca => {
        const id = loca.LOCA_ID;
        const say = message => warnings.push(`${id}: ${message}`);
        const metadata = {
            project: proj.PROJ_NAME || undefined,
            site_name: proj.PROJ_LOC || undefined,
            boring_name: id,
            latitude: num(loca.LOCA_LAT),
            longitude: num(loca.LOCA_LON),
            elevation: num(loca.LOCA_GL),
            datum: loca.LOCA_DATM || undefined,
            start_date: isoDate(loca.LOCA_STAR),
            end_date: isoDate(loca.LOCA_ENDD),
            boring_type: expand('LOCA_TYPE', loca.LOCA_TYPE),
            driller: proj.PROJ_CONT || undefined,
            notes: loca.LOCA_REM || undefined,
        };
        if (metadata.latitude !== undefined && Math.abs(metadata.latitude) > 90) metadata.latitude = undefined;
        if (metadata.longitude !== undefined && Math.abs(metadata.longitude) > 180) metadata.longitude = undefined;
        const diameters = (hdia.get(id) ?? []).map(r => num(r.HDIA_DIAM)).filter(d => d > 0);
        if (diameters.length) metadata.diameter = diameters[0];

        const layers = [];
        for (const r of (geol.get(id) ?? [])) {
            const top = num(r.GEOL_TOP);
            const bottom = num(r.GEOL_BASE) ?? num(loca.LOCA_FDEP);
            if (top === undefined || bottom === undefined || bottom <= top) {
                say(`stratum at ${r.GEOL_TOP || '?'} m left out (base ${r.GEOL_BASE || 'missing'})`);
                continue;
            }
            layers.push({ top, bottom, description: r.GEOL_DESC || '' });
        }

        const depth_notes = (detl.get(id) ?? [])
            .filter(r => num(r.DETL_TOP) !== undefined && r.DETL_DESC)
            .map(r => ({ depth: num(r.DETL_TOP), description: r.DETL_DESC }));

        // Samples, keyed so SPT results and lab tests can find theirs.
        const samples = [];
        const sampleKey = r => `${num(r.SAMP_TOP)}|${r.SAMP_REF ?? ''}|${r.SAMP_TYPE ?? ''}|${r.SAMP_ID ?? ''}`;
        const index = new Map();
        for (const r of (samp.get(id) ?? [])) {
            const top = num(r.SAMP_TOP);
            if (top === undefined) continue;
            let bottom = num(r.SAMP_BASE);
            const type = SAMPLE_TYPES[String(r.SAMP_TYPE ?? '').toUpperCase()] ?? 'Other';
            // AGS often gives only the sample's top: draw SPTs over 0.45 m, others over 0.15 m.
            if (!(bottom > top)) bottom = top + (type === 'SPT' ? 0.45 : 0.15);
            // A type without a sampler symbol (ES environmental, W water...) keeps its
            // AGS code in the sample number: "3 ES".
            const ref = r.SAMP_REF || r.SAMP_ID || '';
            const name = type === 'Other' && r.SAMP_TYPE ? `${ref} ${r.SAMP_TYPE}`.trim() : ref;
            const s = { top, bottom, name: name || undefined, type };
            if (num(r.SAMP_DIA) > 0) s.sampler_diameter = num(r.SAMP_DIA);
            if (r.SAMP_DESC) s.description = r.SAMP_DESC;
            if (r.SAMP_REM) s.remarks = r.SAMP_REM;
            const recv = num(r.SAMP_RECV);
            if (recv !== undefined && recv >= 0) s.recovery = Math.round(((bottom - top) * recv) / 100 * 1000) / 1000;
            samples.push(s);
            index.set(sampleKey(r), s);
        }
        // The sample a test row belongs to: by full key, else by depth alone.
        const sampleFor = (r, createType) => {
            const exact = index.get(sampleKey(r));
            if (exact) return exact;
            const top = num(r.SAMP_TOP ?? r.ISPT_TOP);
            const byDepth = samples.find(s => Math.abs(s.top - top) < 1e-6 && (!createType || s.type === createType));
            if (byDepth) return byDepth;
            if (top === undefined) return null;
            const s = { top, bottom: top + (createType === 'SPT' ? 0.45 : 0.15), name: r.SAMP_REF || undefined, type: createType ?? 'Other' };
            samples.push(s);
            index.set(sampleKey(r), s);
            return s;
        };

        for (const r of (ispt.get(id) ?? [])) {
            const s = sampleFor({ ...r, SAMP_TOP: r.ISPT_TOP }, 'SPT');
            if (!s) continue;
            s.type = 'SPT';
            const n = num(r.ISPT_NVAL);
            const rep = r.ISPT_REP?.trim();
            // Refusal is reported as blows/penetration in mm, seating drive first
            // ("25/75 50/150"): keep the main drive, "50/150mm".
            const drives = rep && !/^N\s*=/i.test(rep) ? [...rep.matchAll(/(\d+)\s*\/\s*(\d+)/g)] : [];
            if (drives.length) s.blow_count = `${drives.at(-1)[1]}/${drives.at(-1)[2]}mm`;
            else if (n !== undefined) s.blow_count = n;
            else if (rep) s.blow_count = rep;
            const inc = [1, 2, 3, 4, 5, 6].map(k => num(r[`ISPT_INC${k}`]));
            if (inc.every(v => v !== undefined)) s.blows = [inc[0] + inc[1], inc[2] + inc[3], inc[4] + inc[5]];
            if (num(r.ISPT_ERAT) > 0) s.energy_ratio = num(r.ISPT_ERAT);
            const pen = [1, 2, 3, 4, 5, 6].map(k => num(r[`ISPT_PEN${k}`])).filter(v => v !== undefined);
            if (pen.length) s.bottom = s.top + pen.reduce((a, b) => a + b, 0) / 1000;
        }

        const labValue = (group, heading, apply) => {
            for (const r of (lab[group].get(id) ?? [])) {
                const s = sampleFor(r);
                if (s) apply(s, r[heading], r);
            }
        };
        labValue('LNMC', 'LNMC_MC', (s, v) => { if (num(v) !== undefined) s.water_content = num(v); });
        labValue('LLPL', 'LLPL_LL', (s, v, r) => {
            if (/^\s*NP\s*$/i.test(v) || /^\s*NP\s*$/i.test(r.LLPL_PL)) s.nonplastic = true;
            if (num(v) !== undefined) s.liquid_limit = num(v);
            if (num(r.LLPL_PL) !== undefined) s.plastic_limit = num(r.LLPL_PL);
        });
        labValue('GRAG', 'GRAG_FINE', (s, v) => { if (num(v) !== undefined) s.fines_content = num(v); });
        labValue('LDEN', 'LDEN_DDEN', (s, v) => { if (num(v) > 0) s.dry_unit_weight = Math.round(num(v) * WATER_UNIT_WEIGHT * 100) / 100; });
        labValue('LPDN', 'LPDN_PDEN', (s, v) => { if (num(v) > 0) s.specific_gravity = num(v); });

        const groundwater = [];
        for (const r of [...(water[0].get(id) ?? []), ...(water[1].get(id) ?? [])]) {
            const depth = num(r.WSTG_DPTH ?? r.WSTK_DEP);
            if (depth === undefined) continue;
            const date = isoDate(r.WSTG_DTIM ?? r.WSTK_DATE);
            groundwater.push({ depth, ...(date ? { date } : {}), note: ['water strike', r.WSTG_REM ?? r.WSTK_REM].filter(Boolean).join('; ') });
        }

        if (!layers.length) say('no strata (GEOL) with a top and base; add layers before drawing');
        const clean = o => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined && v !== ''));
        const document = {
            schema_version: '1.0',
            units: { length: lengthUnit, unit_weight: 'kN/m3', diameter: 'mm' },
            metadata: clean(metadata),
            layers,
            samples: samples.sort((a, b) => a.top - b.top).map(clean),
            groundwater,
            ...(depth_notes.length ? { depth_notes } : {}),
        };
        return { loca_id: id, document };
    });
    return { documents, warnings };
}

/** True if text looks like an AGS file (AGS4, or AGS3, which parseAgs explains it can't read) rather than JSON. */
export const looksLikeAgs = text => /^\s*﻿?\s*("?GROUP"?\s*,|"\*\*)/m.test(String(text ?? '').slice(0, 4000)) && !/^\s*[{[]/.test(String(text ?? ''));
