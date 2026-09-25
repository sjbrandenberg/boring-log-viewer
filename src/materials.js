// Built-in material and rock hatches (src/lithology.js) inferred from a layer's
// material description. The rules were reviewed against 802 NGL layer
// descriptions (Sep. 2026; representative cases, with the owner's verdicts, are
// in tests/materials.test.js) and checked on all 10,945 layers of the 1,407
// drawable NGL borings. Only the principal material
// counts: a minor constituent ("with shells", "trace wood") never does, and a
// soil named in capitals ("coarse pumice SAND") outranks a material that isn't.
//   F  fill, as the principal material, a leading label ("FILL: silty sand"), an
//      origin tag ("(HYDRAULIC FILL)") or anywhere else; fill wins over a USCS symbol
//   M  man-made materials: asphalt, concrete or slab, base course, debris
//   N  natural materials: topsoil (also as a tag), shells, cobbles, wood, ash,
//      pumice, caliche, loess, marl, diatomite, loam; bentonite is drawn as CH
//   X  no recovery, core loss, water, voids; "no recovery" within a soil
//      description (partial recovery) doesn't count
//   R  rock names; "rock" alone is ROCK, and "rock, clay" / "rock, sand" name
//      the rock (CLAYSTONE, SANDSTONE)
// The "lead" of a description is its text up to the first , ; : . ( [ or line
// break: "FILL" in "FILL: Brown silty sand".

const SOIL_NOUNS = new Set(['sand', 'sands', 'silt', 'silts', 'clay', 'clays', 'gravel', 'gravels', 'peat']);
// Words after which a material is a minor constituent.
const MINOR = new Set(['no', 'with', 'w/', 'some', 'trace', 'traces', 'minor', 'few', 'occasional', 'little', 'scattered',
    'containing', 'contains', 'rare', 'including', 'and/or']);

// [code, phrases], checked as the principal material of the lead. Longer
// phrases win ("asphalt concrete" over "concrete").
const MATERIALS = [
    ['ASPHALT', ['asphalt', 'asphalt concrete', 'asphaltic concrete', 'ac pavement', 'pavement', 'paved', 'blacktop', 'tarmac', 'tarmacadam', 'macadam']],
    ['CONCRETE', ['concrete', 'reinforced concrete', 'slab', 'concrete slab', 'pcc']],
    ['BASE_COURSE', ['base course', 'aggregate base', 'road base', 'baserock', 'base rock', 'roading aggregate']],
    ['DEBRIS', ['debris', 'rubble', 'refuse', 'landfill', 'waste']],
    ['TOPSOIL', ['topsoil', 'top soil', 'humus', 'humus soil', 'surface soil']],
    ['SHELL', ['shell', 'shells', 'shell hash', 'coquina']],
    ['COBBLES', ['cobble', 'cobbles', 'boulder', 'boulders']],
    ['WOOD', ['wood', 'timber', 'organic debris']],
    ['ASH', ['ash', 'volcanic ash', 'tephra']],
    ['PUMICE', ['pumice']],
    ['CEMENTED', ['caliche', 'hardpan', 'duripan']],
    ['LOESS', ['loess']],
    ['MARL', ['marl']],
    ['DIATOMITE', ['diatomaceous earth', 'diatomite']],
    ['CH', ['bentonite']],
    ['QUICK_CLAY', ['quick clay', 'sensitive clay']],
    ['LOAM', ['loam', 'sandy loam', 'silt loam', 'silty loam', 'clay loam', 'clayey loam', 'sandy clay loam', 'silty clay loam', 'fine sandy loam']],
    ['NO_RECOVERY', ['no recovery', 'not recovered', 'no sample recovery', 'core loss', 'core lost', 'zero core recovery', 'no core recovery', 'no sample']],
    ['WATER', ['water']],
    ['VOID', ['void', 'cavity']],
    ['ROCK', ['rock', 'bedrock']],
    ['WEATHERED', ['weathered rock', 'saprolite', 'residual soil', 'decomposed rock', 'decomposed bedrock', 'weathered bedrock']],
    ['SANDSTONE', ['sandstone', 'greywacke', 'graywacke', 'arkose']],
    ['SILTSTONE', ['siltstone']],
    ['SHALE', ['shale']],
    ['CLAYSTONE', ['claystone']],
    ['MUDSTONE', ['mudstone']],
    ['CONGLOMERATE', ['conglomerate']],
    ['BRECCIA', ['breccia']],
    ['LIMESTONE', ['limestone', 'marly limestone']],
    ['DOLOMITE', ['dolomite', 'dolostone']],
    ['CHALK', ['chalk']],
    ['CHERT', ['chert']],
    ['COAL', ['coal', 'lignite']],
    ['EVAPORITE', ['gypsum', 'anhydrite', 'halite', 'evaporite']],
    ['GRANITE', ['granite']],
    ['GRANODIORITE', ['granodiorite']],
    ['DIORITE', ['diorite']],
    ['GABBRO', ['gabbro']],
    ['PERIDOTITE', ['peridotite']],
    ['BASALT', ['basalt']],
    ['ANDESITE', ['andesite']],
    ['DACITE', ['dacite']],
    ['RHYOLITE', ['rhyolite']],
    ['TUFF', ['tuff']],
    ['SCORIA', ['scoria']],
    ['SLATE', ['slate']],
    ['PHYLLITE', ['phyllite']],
    ['SCHIST', ['schist']],
    ['GNEISS', ['gneiss']],
    ['QUARTZITE', ['quartzite']],
    ['MARBLE', ['marble']],
    ['HORNFELS', ['hornfels']],
    ['SERPENTINITE', ['serpentinite', 'serpentine']],
    ['GREENSTONE', ['greenstone', 'amphibolite']],
    ['FAULT_GOUGE', ['fault gouge', 'gouge']],
    ['MYLONITE', ['mylonite']],
];
const PHRASES = MATERIALS.flatMap(([code, phrases]) => phrases.map(p => ({ code, words: p.split(' ') })))
    .sort((a, b) => b.words.length - a.words.length);
// Only water and voids at the very start count ("Water", not "mica mixed in water").
const LEADING_ONLY = new Set(['WATER', 'VOID']);
// Materials that stay the principal material in front of a soil noun ("Volcanic Ash
// Clay"); others are then describing the soil ("pumice SAND" is sand).
const MODIFIER_OK = new Set(['ASH']);

// Fill; NZ "hardfill"; "banking" (translated from Japanese); British "made ground".
const FILL_WORD = /\b((back|hard)?fill|embankment|banking|made[\s-]+ground)\b/i;
const NATURAL_FILL = /\b(channel|valley|crevasse|trench)[\s-]+fill\b/gi;       // geologic deposits, not placed fill
const FILL_KIND = [
    [/\bnon[\s-]*engineered\s+fill\b/i, 'FILL'],
    [/\bhydraulic(ally)?\s+(placed\s+)?fill\b/i, 'FILL_HYD'],
    [/\b(engineered|compacted|structural)\s+fill\b/i, 'FILL_ENG'],
    [/\b(undocumented|uncontrolled)\s+fill\b/i, 'FILL_UNDOC'],
];
const NO_RECOVERY = /\b(no (core |sample )?recovery|not recovered|core los[st])\b/i;

const fillCode = text => FILL_KIND.find(([re]) => re.test(text))?.[1] ?? 'FILL';

// Tokens of a text as { word (lower case), upper }, splitting run-together
// words such as "GRAVELwith".
function tokens(text) {
    return (text.replace(/([A-Z]{2,})([a-z])/g, '$1 $2').match(/[A-Za-z]+(?:\/[A-Za-z]*)?/g) ?? [])
        .map(t => ({ word: t.toLowerCase(), upper: t.length > 1 && t === t.toUpperCase() }));
}

/**
 * The built-in material or rock hatch a description names, or null.
 * @param {string} description
 * @returns {string|null} a code from src/lithology.js (or CH, for bentonite)
 */
export function inferMaterial(description) {
    if (!description || !String(description).trim()) return null;
    const text = String(description).replace(/\s+/g, ' ').replace(NATURAL_FILL, '$1 deposit').trim();
    const lead = text.replace(/\bnon\s+-\s+/gi, 'non-').split(/[,;:.([]| - /)[0].trim();
    const tags = [...text.matchAll(/[([]([^)\]]+)[)\]]/g)].map(m => m[1]);

    // Fill describes origin, so it's normal alongside a soil name, and wins over it.
    if ((FILL_WORD.test(lead) && !/\bfilled\b/i.test(lead)) || /\b(filled|reclaimed) (land|ground)\b/i.test(lead)) return fillCode(text);
    const fillTag = tags.find(tag => /\b(fill|embankment)\b/i.test(tag));
    if (fillTag) return fillCode(fillTag);

    // The principal material of the lead: the first material or soil noun, among
    // those in capitals if any are, and not after a minor-constituent word.
    const toks = tokens(lead);
    const noSoil = !tokens(text.replace(/\(inferred[^)]*\)/gi, '')).some(t => SOIL_NOUNS.has(t.word));
    const found = [];
    for (let i = 0; i < toks.length; i++) {
        const hit = PHRASES.find(p => p.words.every((w, k) => toks[i + k]?.word === w));
        if (hit && !(LEADING_ONLY.has(hit.code) && i > 0)) {
            found.push({ code: hit.code, i, upper: toks[i].upper, next: toks[i + hit.words.length] });
            i += hit.words.length - 1;
        } else if (SOIL_NOUNS.has(toks[i].word)) {
            // Not the principal soil in "CLAY OF BLACK ASH" or "wood chips in CLAY matrix".
            if (toks[i + 1]?.word !== 'of' && toks[i + 1]?.word !== 'matrix') found.push({ code: null, i, upper: toks[i].upper });
        } else if (toks[i].word === 'no' || (MINOR.has(toks[i].word) && !noSoil)) {
            // "no wood below 8 m"; or a minor constituent, unless the description
            // names no soil at all ("Trace fragments of rotten wood present").
            break;
        }
    }
    const pool = found.some(f => f.upper) ? found.filter(f => f.upper) : found;
    const first = pool[0];
    if (first?.code) {
        // "pumice SAND" is sand; so is "Shell mixed Fine Sand" (translated: sand mixed with shells).
        const describesSoil = first.next && ((SOIL_NOUNS.has(first.next.word) && !MODIFIER_OK.has(first.code) && first.code !== 'LOAM')
            || first.next.word === 'mixed');
        if (!describesSoil) {
            // "rock, clay": the rock named by the soil after it
            if (first.code === 'ROCK') {
                const soil = text.match(/^\s*rock\s*,\s*(clay|sand|silt)\b/i)?.[1].toLowerCase();
                if (soil) return { clay: 'CLAYSTONE', sand: 'SANDSTONE', silt: 'SILTSTONE' }[soil];
            }
            // No recovery within a soil description is partial recovery: the soil wins.
            if (first.code !== 'NO_RECOVERY' || noSoil) return first.code;
        }
    }

    // No recovery after a drilling note ("HQ wash drill, No recovery"), when the
    // description names no soil.
    if (NO_RECOVERY.test(text) && noSoil) return 'NO_RECOVERY';

    // Topsoil as an origin tag: "SILT with rootlets; dark brown [buried topsoil]".
    if (tags.some(tag => /\b(topsoil|top soil)\b/i.test(tag))) return 'TOPSOIL';

    // Fill mentioned elsewhere (not "backfill": away from the lead that's the borehole's).
    if (/\bfill\b/i.test(text) && !/\b(infill|fill(ed)?\s+with)\b/i.test(text)) return fillCode(text);
    return null;
}
