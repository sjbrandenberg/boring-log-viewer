// Excel import: converts an .xlsx workbook laid out like the template
// (public/templates/boring-log-template.xlsx) into one boring log document.
// Each sheet holds one part of the JSON: Units, Metadata, Layers, Samples,
// Specimens, Groundwater, Depth notes, References, Layout and Columns.
//
// The instruction rows at the top of each template sheet are optional: a
// table sheet's header row is found by its field names (the row that holds,
// for example, both "top" and "bottom" on the Layers sheet), and a
// field/value sheet is read wherever a known field name appears in a row with
// a value to its right. Rows above the header, the explanation column of the
// field/value sheets and sheets with other names (README) are ignored.
//
// Pure JavaScript with no dependencies: the .xlsx (a ZIP of XML files) is
// unpacked with DecompressionStream, available in browsers and Node 18+.

export class XlsxError extends Error {}

// ------------------------------------------------------------------ the layout

const DEPTH = 'in the length unit chosen on the Units sheet (m or ft)';
const UW = 'in the unit weight unit chosen on the Units sheet (kN/m3 or pcf)';
const DIAM = 'in the diameter unit chosen on the Units sheet (mm, cm, m, in or ft)';

export const SAMPLER_TYPES = ['SPT', 'ModCal', 'DamesMoore', 'Shelby', 'Piston', 'Osterberg', 'Pitcher', 'Denison',
    'LargeDiameter', 'Block', 'DirectPush', 'GelPush', 'Sonic', 'Core', 'TripleTube', 'Bulk', 'Grab', 'Composite',
    'Auger', 'Trench', 'Disturbed', 'Other'];

// Field types: number, integer, text, date, boolean, blows (a list of numbers),
// count (number or text such as 50/3in), choice (one of `choices`).
// `required` fields are the ones the header row is recognised by.
export const SHEETS = [
    {
        key: 'units', title: 'Units', form: 'fields', aliases: ['unit'],
        about: 'The units every number in the workbook is given in. Leave a value empty for the default (shown first).',
        fields: [
            { name: 'length', type: 'choice', choices: ['m', 'ft'], help: 'Depths, thicknesses and elevation: m or ft. Default m.' },
            { name: 'unit_weight', type: 'choice', choices: ['kN/m3', 'pcf'], help: 'Unit weights: kN/m3 or pcf. Default kN/m3.' },
            { name: 'diameter', type: 'choice', choices: ['mm', 'cm', 'm', 'in', 'ft'], help: 'Borehole and sampler diameters: mm, cm, m, in or ft. Default mm.' },
        ],
    },
    {
        key: 'metadata', title: 'Metadata', form: 'fields', aliases: ['boring', 'boring_info', 'header', 'info'],
        about: 'The boring itself: shown in the heading of the log. Every value is optional.',
        fields: [
            { name: 'boring_name', type: 'text', help: 'Name of the boring, e.g. B-1. Also used for the file names of downloads.' },
            { name: 'project', type: 'text', help: 'Project name.' },
            { name: 'site_name', type: 'text', help: 'Site name or address.' },
            { name: 'latitude', type: 'number', help: 'Decimal degrees, WGS84 (e.g. 34.0689). Places the boring on the map.' },
            { name: 'longitude', type: 'number', help: 'Decimal degrees, WGS84; negative west of Greenwich (e.g. -118.4452).' },
            { name: 'elevation', type: 'number', help: `Ground surface elevation, ${DEPTH}.` },
            { name: 'datum', type: 'text', help: 'Elevation datum, e.g. NAVD88.' },
            { name: 'start_date', type: 'date', help: 'Date drilling started. An Excel date or text such as 2024-05-01.' },
            { name: 'end_date', type: 'date', help: 'Date drilling ended.' },
            { name: 'boring_type', type: 'text', help: 'Drilling method, e.g. hollow-stem auger, mud rotary.' },
            { name: 'rig', type: 'text', help: 'Drill rig.' },
            { name: 'diameter', type: 'number', help: `Borehole diameter, ${DIAM}.` },
            { name: 'hammer', type: 'text', help: 'Hammer type, e.g. automatic trip, 140 lb.' },
            { name: 'energy_ratio', type: 'number', help: 'Hammer energy ratio, percent (e.g. 80).' },
            { name: 'logged_by', type: 'text', help: 'Who logged the boring.' },
            { name: 'driller', type: 'text', help: 'Drilling contractor or driller.' },
            { name: 'notes', type: 'text', help: 'Any other notes, shown in the heading.' },
        ],
    },
    {
        key: 'layers', title: 'Layers', form: 'table', aliases: ['layer', 'strata', 'stratum', 'lithology', 'geology'],
        about: 'One row per stratigraphic layer, from the top down. At least one layer is needed to draw a log.',
        fields: [
            { name: 'top', type: 'number', required: true, help: `Depth to the top of the layer, ${DEPTH}. Required.` },
            { name: 'bottom', type: 'number', required: true, help: `Depth to the bottom of the layer, ${DEPTH}. Required.` },
            { name: 'description', type: 'text', help: 'Soil or rock description, as it should appear on the log.' },
            { name: 'uscs', type: 'text', help: 'USCS group symbol, e.g. SM, a dual symbol such as SP-SM, or a borderline symbol such as CL/ML.' },
            { name: 'hatch', type: 'text', help: 'Graphic log pattern if different from the USCS symbol, e.g. FILL, SANDSTONE. Leave empty to draw the USCS pattern.' },
        ],
    },
    {
        key: 'samples', title: 'Samples', form: 'table', aliases: ['sample', 'sampling'],
        about: 'One row per sample. Lab test results go on the Specimens sheet. Any extra column you add (e.g. cu) is kept as a custom value of the sample; show it with the Columns sheet.',
        custom: true,
        fields: [
            { name: 'name', type: 'text', help: 'Sample name or number, e.g. S-1. Specimens are linked to their sample by this name.' },
            { name: 'top', type: 'number', required: true, help: `Depth to the top of the sample, ${DEPTH}. Required.` },
            { name: 'bottom', type: 'number', required: true, help: `Depth to the bottom of the sample, ${DEPTH}. Required.` },
            { name: 'type', type: 'text', help: `Sampler type: ${SAMPLER_TYPES.join(', ')}. Empty means Other.` },
            { name: 'uscs', type: 'text', help: 'USCS symbol of the sample, if classified separately from the layer.' },
            { name: 'sampler_diameter', type: 'number', help: `Sampler outer diameter, ${DIAM}.` },
            { name: 'recovery_percent', type: 'number', help: 'Recovery, percent of the sample length (top to bottom); 0 means no recovery.' },
            { name: 'blow_count', type: 'count', help: 'Blow count as reported (N or blows/ft), e.g. 23, or text such as 50/3in for refusal.' },
            { name: 'blows', type: 'blows', help: 'Blows per increment, separated by commas, e.g. 6, 8, 10.' },
            { name: 'energy_ratio', type: 'number', help: 'Hammer energy ratio for this sample, percent. Overrides the one on the Metadata sheet.' },
            { name: 'total_unit_weight', type: 'number', help: `Total unit weight of the whole sample (e.g. a tube weighed before extrusion), ${UW}. Results on specimens go on the Specimens sheet.` },
            { name: 'dry_unit_weight', type: 'number', help: `Dry unit weight of the whole sample, ${UW}.` },
            { name: 'remarks', type: 'text', help: 'Sample remarks, shown in the remarks column.' },
        ],
    },
    {
        key: 'specimens', title: 'Specimens', form: 'table', aliases: ['specimen', 'lab', 'lab_tests', 'laboratory', 'tests'],
        about: 'One row per laboratory specimen. Each belongs to a sample: give the sample\'s name in sample_name (or leave it empty and the specimen goes to the sample whose depths contain its top). Extra columns are kept as custom values of the specimen.',
        custom: true,
        anchors: [['sample_name'], ['top'], ['water_content'], ['liquid_limit'], ['fines_content'], ['dry_unit_weight']],
        fields: [
            { name: 'sample_name', type: 'text', link: true, help: 'Name of the sample (Samples sheet) the specimen was cut from.' },
            { name: 'name', type: 'text', help: 'Specimen name within the sample, e.g. 1 or A.' },
            { name: 'top', type: 'number', help: `Depth to the top of the specimen, ${DEPTH}. Empty: the sample's depths are used.` },
            { name: 'bottom', type: 'number', help: `Depth to the bottom of the specimen, ${DEPTH}.` },
            { name: 'water_content', type: 'number', help: 'Natural water content, percent.' },
            { name: 'total_unit_weight', type: 'number', help: `Total (bulk) unit weight, ${UW}.` },
            { name: 'dry_unit_weight', type: 'number', help: `Dry unit weight, ${UW}.` },
            { name: 'specific_gravity', type: 'number', help: 'Specific gravity of solids, e.g. 2.65.' },
            { name: 'fines_content', type: 'number', help: 'Percent passing the No. 200 sieve.' },
            { name: 'liquid_limit', type: 'number', help: 'Liquid limit, percent.' },
            { name: 'plastic_limit', type: 'number', help: 'Plastic limit, percent.' },
            { name: 'nonplastic', type: 'boolean', help: 'TRUE (or yes, NP) if the specimen is non-plastic; LL and PL are then ignored.' },
            { name: 'uscs', type: 'text', help: 'USCS symbol from the laboratory classification of the specimen, e.g. CL. Shown in the Lab USCS column.' },
            { name: 'remarks', type: 'text', help: 'Specimen remarks.' },
        ],
    },
    {
        key: 'groundwater', title: 'Groundwater', form: 'table', aliases: ['water', 'water_levels', 'water_level', 'gwt'],
        about: 'One row per groundwater reading.',
        fields: [
            { name: 'depth', type: 'number', required: true, help: `Depth to water, ${DEPTH}. Required.` },
            { name: 'date', type: 'date', help: 'Date of the reading. An Excel date or text.' },
            { name: 'note', type: 'text', help: 'E.g. encountered during drilling, stabilized.' },
        ],
    },
    {
        key: 'depth_notes', title: 'Depth notes', form: 'table', aliases: ['depth_note', 'notes', 'observations'],
        about: 'Observations at a single depth within a layer, e.g. "trace gravel" or "becomes wet". Drawn as a tick in the description column.',
        fields: [
            { name: 'depth', type: 'number', required: true, help: `Depth of the observation, ${DEPTH}. Required.` },
            { name: 'description', type: 'text', required: true, help: 'The observation. Required.' },
        ],
    },
    {
        key: 'references', title: 'References', form: 'table', aliases: ['reference', 'sources', 'source'],
        about: 'Sources of the data, e.g. the report the boring comes from. Listed under the log.',
        fields: [
            { name: 'text', type: 'text', required: true, help: 'The reference, e.g. author, year, title. Required.' },
            { name: 'url', type: 'text', help: 'Link to the source (optional).' },
        ],
    },
    {
        key: 'layout', title: 'Layout', form: 'fields', aliases: ['page', 'settings'],
        about: 'Size of the log. Leave empty to use the viewer\'s settings. The columns themselves go on the Columns sheet.',
        fields: [
            { name: 'width', type: 'number', help: 'Width of the log in px, 300 to 4000 (e.g. 900).' },
            { name: 'font_size', type: 'number', help: 'Font size in px, 6 to 24 (e.g. 10).' },
        ],
    },
    {
        key: 'columns', title: 'Columns', form: 'table', aliases: ['column', 'layout_columns'],
        about: 'Which columns the log shows, in order (left to right). Leave the sheet empty for the built-in columns. depth, graphic and description are always drawn.',
        fields: [
            { name: 'id', type: 'text', required: true, help: 'Column id: depth, elevation, groundwater, graphic, uscs, description, sample_type, sample_name, sampler_diameter, blow_count, energy_ratio, specimen, specimen_name, water_content, total_unit_weight, dry_unit_weight, specific_gravity, fines_content, liquid_limit, plastic_limit, specimen_uscs, remarks; or a new id for your own column.' },
            { name: 'width', type: 'number', help: 'Relative width, e.g. 1 for a narrow column and 8 for the description. Empty: the default.' },
            { name: 'label', type: 'text', help: 'Column heading. Empty: the built-in heading, or the id.' },
            { name: 'source', type: 'choice', choices: ['sample', 'specimen', 'blank'], help: 'Your own columns only: sample (a column of the Samples sheet), specimen (of the Specimens sheet) or blank (an empty column).' },
            { name: 'field', type: 'text', help: 'Your own columns only: the header of that extra column on the Samples or Specimens sheet. Empty: the same as id.' },
            { name: 'decimals', type: 'integer', help: 'Your own columns only: decimals shown for numbers, 0 to 6.' },
        ],
    },
];

const IGNORED_SHEETS = new Set(['readme', 'read_me', 'instructions', 'help', 'about', 'notes_and_instructions', 'lists']);

// Other spellings accepted for a header, by sheet.
const ALIASES = {
    '*': { depth_top: 'top', top_depth: 'top', from: 'top', depth_from: 'top', bottom_depth: 'bottom', depth_bottom: 'bottom', base: 'bottom', to: 'bottom', depth_to: 'bottom', remark: 'remarks', comments: 'remarks', comment: 'remarks', uscs_symbol: 'uscs', usc: 'uscs' },
    metadata: { boring: 'boring_name', boring_id: 'boring_name', borehole: 'boring_name', name: 'boring_name', site: 'site_name', lat: 'latitude', lon: 'longitude', lng: 'longitude', long: 'longitude', ground_elevation: 'elevation', drilling_method: 'boring_type', method: 'boring_type', er: 'energy_ratio', logger: 'logged_by' },
    samples: { sample: 'name', sample_name: 'name', sample_id: 'name', sampler: 'type', sampler_type: 'type', sample_type: 'type', n: 'blow_count', spt_n: 'blow_count', n_value: 'blow_count', blowcount: 'blow_count', er: 'energy_ratio', diameter: 'sampler_diameter', recovery: 'recovery_percent', recovery_pct: 'recovery_percent', rec: 'recovery_percent', recovery_percentage: 'recovery_percent' },
    specimens: { sample: 'sample_name', sample_id: 'sample_name', specimen: 'name', specimen_name: 'name', wc: 'water_content', w: 'water_content', moisture_content: 'water_content', ll: 'liquid_limit', pl: 'plastic_limit', fines: 'fines_content', gs: 'specific_gravity', np: 'nonplastic', dry_density: 'dry_unit_weight', total_density: 'total_unit_weight', unit_weight: 'total_unit_weight' },
    groundwater: { water_depth: 'depth', depth_to_water: 'depth', remarks: 'note', notes: 'note' },
    depth_notes: { note: 'description', remarks: 'description', observation: 'description' },
    references: { reference: 'text', citation: 'text', link: 'url' },
    columns: { column: 'id', heading: 'label', column_id: 'id' },
};

/** Lower case, words joined with _, anything in brackets (units) dropped. */
export function normalizeName(value) {
    return String(value ?? '')
        .replace(/\([^)]*\)|\[[^\]]*\]/g, ' ')
        .replace(/[*:]+\s*$/, '')
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '_')
        .replace(/^_+|_+$/g, '');
}

function sheetSpec(name) {
    const n = normalizeName(name);
    return SHEETS.find(s => s.key === n || normalizeName(s.title) === n || s.aliases.includes(n));
}

function fieldName(spec, header) {
    const n = normalizeName(header);
    if (!n) return null;
    const alias = ALIASES[spec.key]?.[n] ?? (spec.fields.some(f => f.name === n) ? n : ALIASES['*'][n] ?? n);
    return spec.fields.find(f => f.name === alias)?.name ?? null;
}

// ------------------------------------------------------------- reading cells

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
function decodeXml(s) {
    return s.replace(/&(#x[0-9a-f]+|#\d+|\w+);/gi, (m, e) => {
        if (e[0] === '#') return String.fromCodePoint(e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : Number(e.slice(1)));
        return ENTITIES[e] ?? m;
    });
}

// Text of the <t> elements (rich text runs), leaving out phonetic runs.
function textOf(xml) {
    return decodeXml(xml.replace(/<rPh\b[\s\S]*?<\/rPh>/g, '')
        .match(/<t\b[^>]*>[\s\S]*?<\/t>|<t\b[^>]*\/>/g)?.map(t => t.replace(/^<t\b[^>]*>|<\/t>$|^<t\b[^>]*\/>$/g, '')).join('') ?? '')
        .replace(/_x([0-9A-F]{4})_/gi, (m, h) => String.fromCharCode(parseInt(h, 16)));
}

const attr = (attrs, name) => attrs.match(new RegExp(`(?:^|\\s)${name}="([^"]*)"`))?.[1];

function columnIndex(ref) {
    const letters = /^([A-Z]+)/i.exec(ref ?? '')?.[1]?.toUpperCase();
    if (!letters) return null;
    let n = 0;
    for (const ch of letters) n = n * 26 + ch.charCodeAt(0) - 64;
    return n - 1;
}

export function columnLetter(index) {
    let s = '';
    for (let n = index + 1; n > 0; n = Math.floor((n - 1) / 26)) s = String.fromCharCode(65 + ((n - 1) % 26)) + s;
    return s;
}

// Excel cell types are kept: numbers stay numbers (dates are serial numbers),
// booleans stay booleans, everything else is text.
function parseSheet(xml, shared) {
    const rows = [];
    const body = xml.replace(/<(\/?)[A-Za-z][\w.-]*:/g, '<$1');
    let next = 0;
    for (const row of body.matchAll(/<row\b([^>]*?)(?:\/>|>([\s\S]*?)<\/row>)/g)) {
        const r = Number(attr(row[1], 'r'));
        const index = Number.isInteger(r) && r > 0 ? r - 1 : next;
        next = index + 1;
        const cells = [];
        let col = 0;
        for (const cell of (row[2] ?? '').matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
            const at = cell[1];
            const c = columnIndex(attr(at, 'r')) ?? col;
            col = c + 1;
            const inner = cell[2] ?? '';
            const type = attr(at, 't');
            const v = /<v\b[^>]*>([\s\S]*?)<\/v>/.exec(inner)?.[1];
            let value = null;
            if (type === 'inlineStr') value = textOf(/<is\b[^>]*>([\s\S]*?)<\/is>/.exec(inner)?.[1] ?? '');
            else if (v === undefined) value = null;
            else if (type === 's') value = shared[Number(v)] ?? '';
            else if (type === 'str') value = decodeXml(v);
            else if (type === 'b') value = v.trim() === '1';
            else if (type === 'e') value = null;
            else if (type === 'd') value = decodeXml(v);
            else {
                const n = Number(v);
                value = Number.isFinite(n) ? n : decodeXml(v);
            }
            if (value !== null && value !== '') cells[c] = value;
        }
        rows[index] = cells;
    }
    return Array.from(rows, r => r ?? []);
}

// ---------------------------------------------------------------- unzipping

async function inflateRaw(bytes) {
    if (typeof DecompressionStream === 'undefined') throw new XlsxError('this browser cannot unpack .xlsx files (no DecompressionStream)');
    const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
    return new Uint8Array(await new Response(stream).arrayBuffer());
}

/** True for the start of a ZIP file (an .xlsx is one). */
export function looksLikeXlsx(bytes) {
    const b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes ?? []);
    return b.length > 4 && b[0] === 0x50 && b[1] === 0x4b && b[2] === 0x03 && b[3] === 0x04;
}

async function unzip(bytes, wanted) {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    let eocd = -1;
    for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 22 - 65557); i--) {
        if (view.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
    }
    if (eocd < 0) throw new XlsxError('this is not an .xlsx workbook (it is not a ZIP file). Save it from Excel as "Excel Workbook (.xlsx)"');
    const count = view.getUint16(eocd + 10, true);
    let p = view.getUint32(eocd + 16, true);
    const dec = new TextDecoder();
    const files = new Map();
    for (let i = 0; i < count; i++) {
        if (view.getUint32(p, true) !== 0x02014b50) throw new XlsxError('the workbook is damaged (bad ZIP directory)');
        const method = view.getUint16(p + 10, true);
        const size = view.getUint32(p + 20, true);
        const nameLen = view.getUint16(p + 28, true);
        const extraLen = view.getUint16(p + 30, true);
        const commentLen = view.getUint16(p + 32, true);
        const local = view.getUint32(p + 42, true);
        const name = dec.decode(bytes.subarray(p + 46, p + 46 + nameLen));
        p += 46 + nameLen + extraLen + commentLen;
        if (!wanted(name)) continue;
        const start = local + 30 + view.getUint16(local + 26, true) + view.getUint16(local + 28, true);
        const data = bytes.subarray(start, start + size);
        if (method === 0) files.set(name, dec.decode(data));
        else if (method === 8) files.set(name, dec.decode(await inflateRaw(data)));
        else throw new XlsxError(`the workbook uses an unsupported compression (method ${method})`);
    }
    return files;
}

/**
 * Reads the sheets of an .xlsx file.
 * @param {ArrayBuffer|Uint8Array} data
 * @returns {Promise<{ sheets: { name: string, rows: any[][] }[], date1904: boolean }>}
 */
export async function readXlsx(data) {
    const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
    if (!looksLikeXlsx(bytes)) {
        if (bytes[0] === 0xd0 && bytes[1] === 0xcf) throw new XlsxError('this is an old .xls workbook. Open it in Excel and save it as "Excel Workbook (.xlsx)"');
        throw new XlsxError('this is not an .xlsx workbook');
    }
    const files = await unzip(bytes, n => /^xl\/(workbook\.xml|_rels\/workbook\.xml\.rels|sharedStrings\.xml|worksheets\/[^/]+\.xml)$/i.test(n));
    const get = name => [...files].find(([k]) => k.toLowerCase() === name.toLowerCase())?.[1];
    const workbook = get('xl/workbook.xml');
    if (!workbook) throw new XlsxError('this ZIP file is not an Excel workbook (no xl/workbook.xml)');
    const strip = s => s.replace(/<(\/?)[A-Za-z][\w.-]*:/g, '<$1');
    const shared = [...strip(get('xl/sharedStrings.xml') ?? '').matchAll(/<si\b[^>]*>([\s\S]*?)<\/si>|<si\b[^>]*\/>/g)].map(m => textOf(m[1] ?? ''));
    const rels = new Map([...strip(get('xl/_rels/workbook.xml.rels') ?? '').matchAll(/<Relationship\b([^>]*)\/?>/g)]
        .map(m => [attr(m[1], 'Id'), attr(m[1], 'Target')]));
    const wb = strip(workbook);
    const date1904 = /<workbookPr\b[^>]*date1904="(1|true)"/.test(wb);
    const sheets = [];
    for (const m of wb.matchAll(/<sheet\b([^>]*?)\/?>/g)) {
        const name = decodeXml(attr(m[1], 'name') ?? '');
        const target = rels.get(attr(m[1], 'r:id') ?? attr(m[1], 'id'));
        if (!target) continue;
        const path = target.startsWith('/') ? target.slice(1) : `xl/${target.replace(/^\.\//, '')}`;
        const xml = get(path);
        if (xml === undefined) continue; // chart sheets and the like
        sheets.push({ name, rows: parseSheet(xml, shared) });
    }
    return { sheets, date1904 };
}

// --------------------------------------------------------- values by type

const isBlank = v => v === null || v === undefined || (typeof v === 'string' && v.trim() === '');

function toNumber(v) {
    if (typeof v === 'number') return v;
    if (typeof v === 'boolean') return NaN;
    const s = String(v).trim().replace(/−/g, '-');
    // 1,5 (decimal comma) is read as 1.5; 1,234.5 (thousands) as 1234.5
    const t = /^-?\d+,\d+$/.test(s) ? s.replace(',', '.') : s.replace(/,(?=\d{3}(\D|$))/g, '');
    return /^[-+]?(\d+\.?\d*|\.\d+)(e[-+]?\d+)?$/i.test(t) ? Number(t) : NaN;
}

// Excel stores dates as days since 1899-12-30 (or 1904-01-01).
function excelDate(serial, date1904) {
    const ms = Math.round((serial + (date1904 ? 1462 : 0) - 25569) * 86400000);
    const iso = new Date(ms).toISOString();
    return iso.endsWith('T00:00:00.000Z') ? iso.slice(0, 10) : iso.slice(0, 16).replace('T', ' ');
}

const round = n => Number(n.toPrecision(12)); // 0.30000000000000004 -> 0.3

function convert(field, raw, ctx, where) {
    const bad = what => {
        ctx.warn(`${where}: "${raw}" is not ${what}, so it was left out`);
        return undefined;
    };
    switch (field.type) {
        case 'number':
        case 'integer': {
            const n = toNumber(raw);
            if (!Number.isFinite(n)) return bad(field.type === 'integer' ? 'a whole number' : 'a number');
            if (field.type === 'integer' && !Number.isInteger(n)) return bad('a whole number');
            return round(n);
        }
        case 'count': {
            const n = toNumber(raw);
            return Number.isFinite(n) ? round(n) : String(raw).trim();
        }
        case 'blows': {
            if (typeof raw === 'number') return [raw];
            const parts = String(raw).split(/[,;/\s-]+/).filter(Boolean).map(toNumber);
            return parts.length && parts.every(Number.isFinite) ? parts : bad('a list of numbers such as 6, 8, 10');
        }
        case 'boolean': {
            if (typeof raw === 'boolean') return raw;
            if (typeof raw === 'number') return raw !== 0;
            const s = String(raw).trim().toLowerCase();
            if (['true', 'yes', 'y', 'x', 'np', 'non-plastic', 'nonplastic', '1'].includes(s)) return true;
            if (['false', 'no', 'n', '0', '-'].includes(s)) return false;
            return bad('TRUE or FALSE');
        }
        case 'date':
            return typeof raw === 'number' ? excelDate(raw, ctx.date1904) : String(raw).trim();
        case 'choice': {
            const s = String(raw).trim().replace(/³/g, '3');
            const hit = field.choices.find(c => c.toLowerCase() === s.toLowerCase())
                ?? { meters: 'm', meter: 'm', metres: 'm', metre: 'm', feet: 'ft', foot: 'ft', inch: 'in', inches: 'in', 'kn/m^3': 'kN/m3', knm3: 'kN/m3', 'lb/ft3': 'pcf', 'lb/ft^3': 'pcf', 'lbs/ft3': 'pcf' }[s.toLowerCase()];
            return hit && field.choices.includes(hit) ? hit : bad(`one of ${field.choices.join(', ')}`);
        }
        default:
            return typeof raw === 'number' ? String(round(raw)) : String(raw).trim();
    }
}

// ------------------------------------------------------ sheets to objects

function readFields(spec, rows, ctx) {
    const out = {};
    rows.forEach((row, r) => {
        const c = row.findIndex(v => !isBlank(v));
        if (c < 0 || typeof row[c] !== 'string') return;
        const name = fieldName(spec, row[c]);
        if (!name || isBlank(row[c + 1])) return;
        const field = spec.fields.find(f => f.name === name);
        const value = convert(field, row[c + 1], ctx, `${ctx.sheet}!${columnLetter(c + 1)}${r + 1} (${name})`);
        if (value !== undefined) out[name] = value;
    });
    return out;
}

function findHeader(spec, rows) {
    const anchors = spec.anchors ?? [spec.fields.filter(f => f.required).map(f => f.name)];
    for (let r = 0; r < rows.length; r++) {
        const names = rows[r].map(v => (typeof v === 'string' ? fieldName(spec, v) : null));
        const known = names.filter(Boolean);
        if (!known.length) continue;
        const filled = rows[r].filter(v => !isBlank(v)).length;
        if (anchors.some(set => set.every(a => names.includes(a))) && (known.length >= 2 || filled === 1)) {
            return { index: r, names };
        }
    }
    return null;
}

const CUSTOM_KEY = /^[A-Za-z][A-Za-z0-9_]{0,31}$/;

function readTable(spec, rows, ctx) {
    const header = findHeader(spec, rows);
    if (!header) {
        if (rows.some(row => row.some(v => !isBlank(v)))) {
            const need = (spec.anchors ?? [spec.fields.filter(f => f.required).map(f => f.name)]).map(a => a.join(' and ')).join(', or ');
            ctx.warn(`${ctx.sheet}: no header row found (it needs a row with the column names ${need}), so the sheet was skipped`);
        }
        return [];
    }
    const custom = new Map();
    rows[header.index].forEach((h, c) => {
        if (header.names[c] || isBlank(h)) return;
        if (!spec.custom) {
            ctx.warn(`${ctx.sheet}: column "${h}" is not one of this sheet's fields, so it was left out`);
            return;
        }
        const key = String(h).replace(/\([^)]*\)|\[[^\]]*\]/g, ' ').trim().replace(/^custom[.:]\s*/i, '').replace(/\s+/g, '_');
        if (CUSTOM_KEY.test(key)) custom.set(c, key);
        else ctx.warn(`${ctx.sheet}: column "${h}" was left out (a custom column's header must start with a letter and use only letters, digits and _)`);
    });
    const out = [];
    for (let r = header.index + 1; r < rows.length; r++) {
        const row = rows[r];
        if (!row.some(v => !isBlank(v))) continue;
        const item = {};
        header.names.forEach((name, c) => {
            if (!name || isBlank(row[c])) return;
            const field = spec.fields.find(f => f.name === name);
            const value = convert(field, row[c], ctx, `${ctx.sheet}!${columnLetter(c)}${r + 1} (${name})`);
            if (value !== undefined && item[name] === undefined) item[name] = value;
        });
        for (const [c, key] of custom) {
            if (isBlank(row[c])) continue;
            const n = typeof row[c] === 'number' ? round(row[c]) : String(row[c]).trim();
            (item.custom ??= {})[key] = n;
        }
        const missing = spec.fields.filter(f => f.required && item[f.name] === undefined).map(f => f.name);
        if (missing.length) {
            ctx.warn(`${ctx.sheet} row ${r + 1}: no ${missing.join(' or ')}, so the row was left out`);
            continue;
        }
        item._row = r + 1;
        out.push(item);
    }
    return out;
}

const omitRow = ({ _row, ...rest }) => rest;
const ORDER = { samples: ['top', 'bottom', 'name', 'type'], specimens: ['name', 'top', 'bottom'] };
function ordered(item, key) {
    const out = {};
    for (const k of ORDER[key] ?? []) if (item[k] !== undefined) out[k] = item[k];
    for (const [k, v] of Object.entries(item)) if (!(k in out) && k !== 'custom') out[k] = v;
    if (item.custom) out.custom = item.custom;
    return out;
}

/**
 * Builds one boring log document from sheets read by readXlsx.
 * @returns {{ document: object, warnings: string[] }}
 */
export function workbookToBoringLog({ sheets, date1904 = false }) {
    const warnings = [];
    const ctx = { date1904, sheet: '', warn: w => warnings.push(w) };
    const parts = {};
    const names = {};
    for (const { name, rows } of sheets) {
        const spec = sheetSpec(name);
        if (!spec) {
            if (!IGNORED_SHEETS.has(normalizeName(name)) && rows.some(r => r.some(v => !isBlank(v)))) warnings.push(`sheet "${name}" is not one of the template's sheets, so it was ignored`);
            continue;
        }
        if (parts[spec.key]) {
            warnings.push(`there are two ${spec.title} sheets; only the first was read`);
            continue;
        }
        ctx.sheet = name;
        parts[spec.key] = spec.form === 'fields' ? readFields(spec, rows, ctx) : readTable(spec, rows, ctx);
        names[spec.key] = name;
    }

    const doc = { schema_version: '1.0' };
    if (parts.units && Object.keys(parts.units).length) doc.units = parts.units;
    if (parts.metadata && Object.keys(parts.metadata).length) doc.metadata = parts.metadata;
    if (parts.references?.length) doc.references = parts.references.map(omitRow);
    if (parts.groundwater?.length) doc.groundwater = parts.groundwater.map(omitRow);

    const layout = { ...(parts.layout ?? {}) };
    if (parts.columns?.length) {
        layout.columns = parts.columns.map(omitRow).map(c => (Object.keys(c).length === 1 ? c.id : c));
    }
    if (Object.keys(layout).length) doc.layout = layout;
    if (parts.depth_notes?.length) doc.depth_notes = parts.depth_notes.map(omitRow);

    doc.layers = (parts.layers ?? []).map(omitRow);
    if (!parts.layers) warnings.push('the workbook has no Layers sheet; a log needs at least one layer');
    else if (!doc.layers.length) warnings.push('the Layers sheet has no layers; a log needs at least one');

    const samples = (parts.samples ?? []).map(s => ({ ...s }));
    for (const spec of parts.specimens ?? []) {
        const { _row, sample_name: link, ...rest } = spec;
        let owner;
        if (link !== undefined) {
            const named = samples.filter(s => s.name === link);
            owner = named[0];
            if (named.length > 1) warnings.push(`${names.specimens} row ${_row}: more than one sample is named "${link}"; it was put with the first`);
            if (!owner) {
                warnings.push(`${names.specimens} row ${_row}: there is no sample named "${link}" on the Samples sheet, so the specimen was left out`);
                continue;
            }
        } else if (rest.top !== undefined) {
            owner = samples.find(s => rest.top >= s.top - 1e-9 && rest.top <= s.bottom + 1e-9);
            if (!owner) {
                warnings.push(`${names.specimens} row ${_row}: no sample_name, and no sample contains depth ${rest.top}, so the specimen was left out`);
                continue;
            }
        } else {
            warnings.push(`${names.specimens} row ${_row}: give the sample_name (or the specimen's top depth) so it can be put with its sample; the row was left out`);
            continue;
        }
        (owner.specimens ??= []).push(ordered(rest, 'specimens'));
    }
    if (samples.length) doc.samples = samples.map(s => ordered(omitRow(s), 'samples'));
    return { document: doc, warnings };
}

/**
 * Converts an .xlsx workbook (bytes) into one boring log document.
 * @param {ArrayBuffer|Uint8Array} data
 * @returns {Promise<{ document: object, warnings: string[] }>}
 * @throws XlsxError for files that aren't readable .xlsx workbooks
 */
export async function xlsxToBoringLog(data) {
    return workbookToBoringLog(await readXlsx(data));
}
