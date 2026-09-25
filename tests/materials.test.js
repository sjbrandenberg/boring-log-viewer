import { test } from 'node:test';
import assert from 'node:assert/strict';
import { inferMaterial, layerHatch, renderBoringLog, LITHOLOGY } from '../src/index.js';

// Descriptions from the review of NGL layers (Sep. 2026), with the owner's verdicts.
const cases = [
    // fill: principal, leading label, origin tag, synonyms; wins over a soil name
    ['Silty sand fill (Translated from Japanese)', 'FILL'],
    ['FILL: Brown, moist, silty sand with concrete debris and cobbles', 'FILL'],
    ['POORLY GRADED SAND, dark gray, dense, wet, fine-grained sand, trace mica (HYDRAULIC FILL)', 'FILL_HYD'],
    ['Gravelly sand (Artificial fill)', 'FILL'],
    ['Non - engineered FILL. Sandy fine to coarse GRAVEL with minor cobbles;brown.', 'FILL'],
    ['Embankment', 'FILL'],
    ['HARDFILL', 'FILL'],
    ['Banking soil, coarse gravel and clayey silt with chips of wood', 'FILL'],
    ['Filled land', 'FILL'],
    // British "made ground" (BGS TP23, West Bridgford)
    ['MADE GROUND: grass over dark brown sandy gravelly SILT. Gravel is angular to rounded fine to coarse slag, brick, coal, ash and quartz.', 'FILL'],
    ['Made Ground (brick rubble)', 'FILL'],
    // man-made
    ['Asphalt 3"', 'ASPHALT'],
    ['Paved Driveway', 'ASPHALT'],
    ['Tarmacadam', 'ASPHALT'],
    ['SLAB: 10 cm thick old slab', 'CONCRETE'],
    ['Reinforced concrete (Translated from Japanese)', 'CONCRETE'],
    ['Roading aggregate; fine to coarse.', 'BASE_COURSE'],
    // natural materials
    ['TOPSOIL: SILT, trace fine sand; dark brown. Moist to wet, rootlets.', 'TOPSOIL'],
    ['Surface soil', 'TOPSOIL'],
    ['Silty fine sand; dark brown (TOPSOIL)', 'TOPSOIL'],
    ['Shells, with 10-50% dk. greenish gray sand', 'SHELL'],
    ['COBBLES with sand and minor gravel, grey. Loose, moist.', 'COBBLES'],
    ['Volcanic Ash Clay', 'ASH'],
    ['CLAY OF BLACK ASH IN PARTIALLY BLOCKED FORM', 'ASH'],
    ['Pumice, dark milky green', 'PUMICE'],
    ['Brown wood chips in grey brown CLAY matrix', 'WOOD'],
    ['Trace fragments of rotten wood present from 8.8- 9.4m', 'WOOD'],
    ['Bentonite', 'CH'],
    ['FINE SANDY LOAM, dk. greenish gray', 'LOAM'],
    ['CLAY LOAM, grayish brown', 'LOAM'],
    // no recovery, including after a drilling note; not partial recovery
    ['no recovery', 'NO_RECOVERY'],
    ['No Sample.', 'NO_RECOVERY'],
    ['CORE LOSS. (Inferred SILT)', 'NO_RECOVERY'],
    ['HQ wash drill, No recovery', 'NO_RECOVERY'],
    ['Silty, fine to medium SAND, dark grey. Very loose, moist.  17.6 to 18.5m no recovery', null],
    // rock
    ['SHALE, black, hard (FRANCISCAN ASSEMBLAGE)', 'SHALE'],
    ['Weathered limestone', 'LIMESTONE'],
    ['CLAYSTONE greenish gray, extremely weak (R0)', 'CLAYSTONE'],
    ['Bedrock', 'ROCK'],
    ['rock,clay', 'CLAYSTONE'],
    ['rock,sand', 'SANDSTONE'],
    // a soil is the principal material: no material hatch
    ['moderately graded coarse pumice SAND', null],
    ['Pumice Sand, dark bluish grey', null],
    ['Gravel and cobbles (Translated from Japanese)', null],
    ['Sandy fine to coarse GRAVELwith occasional small cobbles and trace silt', null],
    ['Silty fine to medium SAND with trace broken shells, grey, medium dense', null],
    ['SILT with some friable wood pieces and minor sand; grey.', null],
    ['LOAMY FINE SAND, v. dk. greenish gray to olive gray', null],
    ['Minimal amount of mica mixed in water.', null],
    ['Dense and no wood below 8 m.', null],
    ['CLAYEY SAND: Brown, moist to wet, very dense clayey sand with small fragment of sandstone', null],
    ['Shell Mixed Fine Sand; Dark Ash; It contains a lot of water.', null],
    ['Humus mixed sand; black gray; medium dense', null],
    ['channel fill, Fraser River silt', null],
    ['Decomposed Bedrock', 'WEATHERED'],
    ['Serpentine bedrock', 'SERPENTINITE'],
    ['END of borehole at 31.15m vibrating wire piezeometer installed, with sand backfill 28.0m to 25.2m.', null],
];

test('materials and rock are inferred from the principal material only', () => {
    for (const [description, expected] of cases) assert.equal(inferMaterial(description), expected, description);
});

test('every inferred code is a built-in hatch', () => {
    for (const [, expected] of cases) if (expected && expected !== 'CH') assert.ok(LITHOLOGY[expected], expected);
});

test('an inferred material wins over the USCS symbol; an explicit hatch wins over both', () => {
    assert.deepEqual(layerHatch({ description: 'Silty sand fill', uscs: 'SM', material_inferred: 'FILL' }), ['FILL']);
    assert.deepEqual(layerHatch({ description: 'Silty sand fill', uscs: 'SM', hatch: 'SP', material_inferred: 'FILL' }), ['SP']);
    const doc = { schema_version: '1.0', layers: [{ top: 0, bottom: 2, description: 'Silty sand fill', uscs: 'SM' }] };
    assert.match(renderBoringLog(doc, { id_prefix: 't' }), /fill="url\(#t-FILL\)"/);
    assert.match(renderBoringLog(doc, { id_prefix: 't', infer_materials: false }), /fill="url\(#t-SM\)"/);
});
