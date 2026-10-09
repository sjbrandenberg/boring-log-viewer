# Boring log viewer

Renders a geotechnical boring log from JSON as a standalone SVG. The same
module is used by the paste-and-preview page at
`uclageo.com/boring-log-viewer` (see [Website](#website)) and by the
[render API](#render-api). The viewers in coastal_database and vspdb will use
it too.

```js
import { renderBoringLog, validateBoringLog } from 'boring-log-viewer';

const { valid, errors, warnings } = validateBoringLog(json);
const svg = renderBoringLog(json, { units: 'ft', width: 900 });
```

`src/render.js` has no dependencies and no DOM or Node APIs, so it can be
imported directly in a browser. `validateBoringLog` uses Ajv and needs a bundler
for browser use.

## Input format

The input format is defined in [`schema/boring-log.schema.json`](schema/boring-log.schema.json)
(JSON Schema 2020-12). A minimal log:

```json
{
  "schema_version": "1.0",
  "layers": [ { "top": 0, "bottom": 5, "description": "Brown silty SAND" } ]
}
```

Full examples are in [`tests/fixtures/`](tests/fixtures/). Main points:

- **Depths** are measured down from the ground surface in `units.length` (`m` or
  `ft`). `units.unit_weight` is `kN/m3` or `pcf`, and `units.diameter` is `mm`,
  `cm`, `m`, `in` or `ft`. SI is the default.
- **`layers`**: one object per stratum, `{ top, bottom, description, uscs, hatch }`.
  The graphic log uses `hatch` if given (use `"none"` to leave it blank), then
  a material or rock named in the description (see below), then `uscs`, then a
  the USCS symbol inferred from the description and shown in the USCS column
  (e.g. "silty SAND" gives SM). A layer with none of these has no USCS
  symbol, so its graphic log is left blank (a "clayey SILT", for example, is
  not drawn as ML or MH). The USCS hatches follow the Caltrans *Soil and Rock Logging,
  Classification, and Presentation Manual* (2010) legend. Coarse dual symbols
  (`GW-GM`, `SP-SM`, `SC-SM`...) are drawn as one Caltrans-style tile: the
  coarse soil's grain with a lighter silt or clay overlay. Other pairs, such as
  `CL-ML` or `SP-FILL`, or a dual whose half has a custom pattern, split the
  column in half.
  A layer without `uscs` gets a symbol inferred from its description, shown in
  parentheses as "(CH)", only when the description determines it: a symbol
  written in the text ("(SP-SM)"), an ASTM D2487 group name ("fat CLAY",
  "silty SAND", "poorly graded SAND with silt"), CLAY or SILT with a plasticity
  descriptor, "silty clay" (CL-ML), SILT group names (ML), and organic SILT/CLAY
  with low (OL) or high (OH) plasticity. Mixed layers, ranges ("lean to fat"),
  bare SAND or GRAVEL, and "clayey SILT" get none. The rules are in
  `inferUscs()` in `src/classify.js`; they were reviewed against 655 layer
  descriptions from the NGL database.
  A recorded `uscs` is checked too (`checkUscs()` in `src/classify.js`). When
  it isn't a possible symbol (a dual such as `GW-GP`; the ASTM D2487 duals are
  listed in `DUAL_NAMES`, and borderline soils use "/", e.g. `CL/CH`), or when
  the description determines a different symbol (also from the text after a
  heading such as "GRAVEL AND SAND:"), both are shown: the recorded one, with
  ours below it in parentheses, e.g. "SP-SM" over "(SW)" for a "well graded
  SAND". A recorded symbol that includes ours counts as agreeing: a dual
  (SP-SM for "silty SAND" or "poorly graded SAND"), a dual written in the
  other order (ML-CL), or a borderline symbol (CL/CH for "lean CLAY"). The
  validator returns a warning for each, and `infer_uscs=false` turns it off.
  A value with at least one real group symbol, like `SM-G`, is accepted the
  same way and drawn from its real symbols (SM); one with none (`XX`) is an
  error.
- **Built-in hatches besides USCS**: 67 materials a layer can use through
  `hatch`, e.g. `"hatch": "FILL"` or `"hatch": "SANDSTONE"`, also in dual
  patterns such as `SP-FILL`. Their names and groups are in `src/lithology.js`;
  the artwork is drawn by `scripts/lithology-art.js`, with rock patterns after
  the FGDC Digital Cartographic Standard for Geologic Map Symbolization
  (FGDC-STD-013-2006, section 37) at a density that reads in a 40 px column
  (run `npm run build:hatches` after changing it or `scripts/uscs-art.js`, and
  `node scripts/hatch-catalog.js catalog.png --all` to see them all). A code without its own tile falls back along its chain, e.g. SANDSTONE
  to ROCK_SED to ROCK.
  They are also inferred from the description when it names the principal
  material (`inferMaterial()` in `src/materials.js`, reviewed against 802 NGL
  layer descriptions): fill as the principal material, a leading label
  ("FILL: silty sand") or an origin tag ("(HYDRAULIC FILL)"); asphalt, concrete
  and base course; topsoil, shells, cobbles, wood, ash, pumice, loam; no
  recovery or core loss; and rock names ("SHALE, black, hard"; "rock, clay" is
  CLAYSTONE). A minor constituent ("with trace shells") never counts, and a
  soil named in capitals outranks a material that isn't ("coarse pumice SAND"
  is sand). Bentonite is drawn as CH. An inferred material wins over `uscs`
  (a fill layer is drawn as FILL, with its USCS symbol still in the USCS
  column); `infer_materials=false` turns this off.
  - Fill and man-made: `FILL`, `FILL_HYD`, `FILL_ENG`, `FILL_UNDOC`, `DEBRIS`, `ASPHALT`, `CONCRETE`, `BASE_COURSE`
  - Natural materials: `TOPSOIL`, `SHELL`, `COBBLES`, `WOOD`, `ASH`, `CEMENTED`, `LOESS`, `MARL`, `DIATOMITE`, `BENTONITE`, `LOAM`, `QUICK_CLAY`
  - Non-material intervals: `WATER`, `NO_RECOVERY`, `VOID`
  - Rock: category: `ROCK`, `ROCK_SED`, `ROCK_IGN`, `ROCK_MET`
  - Rock: transitional: `WEATHERED`, `IGM`
  - Rock: sedimentary (clastic): `SANDSTONE`, `SHALE`, `SILTSTONE`, `MUDSTONE`, `CLAYSTONE`, `CONGLOMERATE`, `BRECCIA`
  - Rock: sedimentary (chemical/organic): `LIMESTONE`, `DOLOMITE`, `CHALK`, `CHERT`, `COAL`, `EVAPORITE`
  - Rock: igneous (intrusive): `GRANITE`, `GRANODIORITE`, `DIORITE`, `GABBRO`, `PERIDOTITE`
  - Rock: igneous (extrusive): `BASALT`, `ANDESITE`, `DACITE`, `RHYOLITE`
  - Rock: igneous (pyroclastic): `TUFF`, `VOLC_BRECCIA`, `SCORIA`, `PUMICE`
  - Rock: metamorphic (foliated): `SLATE`, `PHYLLITE`, `SCHIST`, `GNEISS`
  - Rock: metamorphic (non-foliated): `QUARTZITE`, `MARBLE`, `HORNFELS`, `SERPENTINITE`, `GREENSTONE`
  - Rock: fault rock: `FAULT_GOUGE`, `FAULT_BRECCIA`, `MYLONITE`
- **`samples`**: `{ top, bottom, name, type, blow_count, blows, energy_ratio,
  sampler_diameter, recovery, remarks, specimens }`. A sample's text is its
  `remarks` (NGL `SAMP_REM`); a `description` from older documents is accepted,
  with a warning, and shown at the start of the remarks. Lab results
  go on the sample's specimens (below). `type` picks the symbol in the
  sample column, one of: drive samplers `SPT`, `ModCal`, `DamesMoore`;
  push samplers `Shelby`, `Piston`, `Osterberg`, `Pitcher`, `Denison`,
  `LargeDiameter`, `DirectPush`, `GelPush`; `Block`; cores `Sonic`, `Core`,
  `TripleTube`; disturbed samples `Bulk`, `Grab`, `Composite`, `Auger`,
  `Trench`, `Disturbed`; and `Other` (the default). `NoRecovery` is also
  accepted, with a warning (see below). The list and
  legend names are in `src/samplers.js`. `recovery` is the recovered length;
  it is shown as a note at the start of the sample's remarks, "Recovery 0.36 m
  (80%)", or "No recovery" when it is 0. No recovery is an outcome, not a
  sampler type: give the sampler that was tried as `type`. A sample whose
  `type` or `name` is "NoRecovery", "No recovery" or "NR" is read as
  `recovery: 0` (with a warning), drawn as `Other` or its given type.
- **`specimens`** (in a sample): the specimens cut from the sample for
  laboratory tests. As in NGL, lab results belong to a specimen (`SPEC`:
  `SPEC_REF`, `SPEC_TOP`, `SPEC_BASE`, `SPEC_REM`), with its index tests
  (`INDX`) and Atterberg limits (`PLAS`), not to the sample: `{ name, top,
  bottom, water_content, total_unit_weight, dry_unit_weight, specific_gravity,
  fines_content, liquid_limit, plastic_limit, nonplastic, remarks }`. A
  specimen without `top` gets no box (none is made up from the sample's
  depths) and its results are shown level with the sample; one with `top` and
  no `bottom` is drawn at that depth. Each is drawn as a grey box over its depth range in the
  **Specimen** column (side by side when they overlap), with its name in
  **Specimen no.** and its results on a row level with it, so one sample can
  show several specimens' results. A specimen outside its sample gets a
  warning; a `bottom` above the `top` is an error. Lab results given on the
  sample itself (`water_content`, `liquid_limit`..., as in older documents)
  are still accepted, with a warning, and shown the same way, without a box. AGS4 lab rows go on the specimen given by `SPEC_REF` and
  `SPEC_DPTH`; DIGGS results on their `specimenRef` (else one specimen per
  tested interval).
- **`groundwater`**: a list of `{ depth, date, note }`.
- **`depth_notes`**: a list of `{ depth, description }` for observations at one
  depth within a layer ("thin sand lens"). They are drawn in italics in the
  material description column, with a tick at their depth.
- **`references`**: a list of `{ text, url }` for the sources of the data (the
  report or paper the boring comes from), listed in the header, after the
  metadata, so they're seen before a tall log (below the legend when the header
  is turned off). An http(s)
  `url` is shown after the text, unless the text already contains it, and is a
  link in SVG output; other values (e.g. "Personal communication") aren't
  linked. `references=false` leaves them off.
- **`patterns`**: your own graphic log patterns and sampler symbols, by code:
  `{ "FILL": { "name": "Fill", "svg": "<svg viewBox='0 0 40 20'><line x1='0' y1='20' x2='40' y2='0' stroke='black'/></svg>" } }`.
  Each entry has either `svg`, SVG markup whose size comes from its `viewBox`
  (or `width`/`height` in px), or `image`, a base64 data URI of a PNG, JPEG or
  SVG with `width` and `height` giving its pixel size (either at most 350,000
  characters). SVG markup is parsed and rebuilt by `src/svg-pattern.js` from
  an allowlist: `path`, `rect`, `circle`, `ellipse`, `line`, `polyline`,
  `polygon` and `g`, with geometry and fill/stroke attributes (`style="..."`
  is read into attributes). Titles, metadata and editor namespaces (Inkscape,
  Illustrator) are dropped; text, images, `<use>`, `<style>`, scripts,
  `url(...)` values and DOCTYPEs are rejected with a message. The rebuilt SVG
  is drawn as a data URI in an `<image>`, like a picture, so no user markup
  goes into the log itself. Add `"kind": "sampler"`
  for a sampler symbol (stretched to fill the sample's box), and `tile_width`
  (px on the log) to change how large a soil tile is drawn; by default one tile
  spans the graphic log column. A code equal to a USCS symbol (`SM`) or a
  built-in sampler (`SPT`) replaces the built-in pattern everywhere in the log.
  Any other code (letters, digits and `_`, up to 16 characters, starting with a
  letter) adds a new one: set a layer's `hatch`, or a sample's `type`, to it.
  Custom codes also work in dual patterns such as `"hatch": "SP-FILL"`. Images
  are embedded in the SVG, so logs stay self-contained. The web page's
  **Hatches…** button builds these entries from an image file: SVG files and
  raster images traced to vector shapes (with imagetracerjs, the default) are
  stored as `svg`; a raster kept as a picture (for photos or shading) is
  stored as `image`, scaled down to 512 px. It sets `hatch` or `type` on the layers
  or samples the user ticks, so no JSON editing is needed. It also lists the
  built-in hatches and sampler symbols, each with a Replace button.
- **`layout`**: how the log is laid out, kept with the data. Without it the
  built-in layout is used.
  ```json
  "layout": {
    "width": 1000, "font_size": 10,
    "columns": [
      "depth", { "id": "graphic", "width": 5 },
      { "id": "description", "width": 25, "label": "Soil description" },
      "sample_type", "sample_name", "blow_count",
      { "id": "pp", "source": "sample", "field": "pocket_pen", "label": "PP (tsf)", "width": 3 },
      "specimen", "specimen_name", "water_content",
      { "id": "cu", "source": "specimen", "label": "cu (kPa)", "decimals": 0 },
      { "id": "remarks", "width": 12 },
      { "id": "notes", "source": "blank", "label": "Field notes", "width": 10 }
    ]
  }
  ```
  `columns` lists the columns in order, each a column id or an object. Widths
  are relative: the columns share the log's width in proportion to them. A
  built-in column without a width gets its usual width in px / 10 (depth 3.8,
  graphic log 4, values about 3; description 30 and remarks 15). `label`
  replaces the heading. A new id with a `source` adds a custom column:
  `"sample"` shows each sample's `custom[field]`, `"specimen"` each specimen's
  (on the specimen rows, like LL and PL), `"blank"` an empty column for notes
  by hand; `field` defaults to the id, and `decimals` rounds numbers (without
  it they are shown as given). The values go in the sample or specimen:
  `"custom": { "pocket_pen": 1.5 }`. Depth, graphic log and description are
  always drawn, empty columns are hidden as usual (not blank ones), and an
  unknown id without a source, a custom column with a built-in id, or an id
  listed twice is an error. `width` and `font_size` set the log's; render
  options given by the caller (the API's query, the page's settings) take
  precedence, except that the web page keeps a layout's width.
  `defaultLayout(doc)` returns the layout the log is drawn with now, with
  relative widths that reproduce it, and `layoutColumns(doc)` lists every
  built-in column with its heading and default width.
  On the web page, nobody needs to write this by hand: the **Layout…** window
  lists the columns with a tick box, heading, relative width and up/down
  buttons, shows the widths as a bar, adds custom columns (with a box for each
  sample's or specimen's value) and writes `layout` and the `custom` values as
  you go, so the preview follows. **Use built-in layout** removes it, and
  **Undo changes** goes back to how the log was when the window opened. Its
  logic is in `site/layout-state.js`.
- **`null` means "not given"**, so database exports can be passed through
  without cleaning. Unknown property names are errors, which catches typos.

## Render options

| option | default | meaning |
|---|---|---|
| `width` | 800 | SVG width in px. It widens if the text columns would go below 60 px per flex unit. |
| `height` | 500 | Starting height of the log body in px |
| `scale` | – | px per display length unit; overrides `height` |
| `fit_text` | true | Stretch the depth scale so sample rows line up with their samplers (up to an 8,000 px body) and stacked descriptions fit within it |
| `units` | data's units | Display length units, `m` or `ft`; unit weight and diameter follow unless set below |
| `unit_weight`, `diameter_units` | – | Override display units |
| `columns` | the layout's, else `DEFAULT_COLUMNS` | Column ids, in order (a layout's custom columns can be used) |
| `hide_empty_columns` | true | Drop columns with no data |
| `header`, `legend` | true | Metadata block above, legend below |
| `references` | true | The document's references, in the header (below the legend without one) |
| `title` | `metadata.boring_name` | Title text |
| `depth_range` | `[0, deepest]` | `[top, bottom]` in display units |
| `font_size` | 10 | px |
| `infer_uscs` | true | For layers without `uscs`, show a USCS symbol inferred from the description, in parentheses (see below) |
| `infer_materials` | true | For layers without `hatch`, draw a material or rock hatch named in the description (fill, asphalt, topsoil, shale...), ahead of `uscs` |
| `id_prefix` | hash of the data | Prefix for `<pattern>` ids. Logs with different data get different ids, so several can share a page. |

Column ids: `depth`, `elevation`, `groundwater`, `graphic`, `uscs`,
`description`, `sample_type`, `sample_name`, `sampler_diameter`,
`blow_count`, `energy_ratio`, the specimen columns `specimen` (the boxes), `specimen_name`,
`water_content`, `total_unit_weight`, `dry_unit_weight`, `specific_gravity`,
`fines_content`, `liquid_limit`, `plastic_limit`, and `remarks`: one column
with every sample's remarks, level with the sample, and every specimen's,
level with the specimen.

## Layout

Text is measured with a built-in table of character widths
(`src/font-metrics.js`). The table was built from Arimo, which has the same
widths as Arial and Liberation Sans, so line breaks come out the same in every
browser and on the server. The DOM is never used for measuring. The SVG asks for
Arial first, then those substitutes. When the server renders PNGs with resvg, it
must have Liberation Sans or Arimo installed, or be given the font file.

Descriptions start at the top of their layer. If the previous description ran
long, the next one starts below it, and a leader line connects the layer
boundary to the text. A layer's depth notes follow its description, each with
its first line level with its depth when there is room, or pushed down with a
leader from its depth when there isn't.

Each sample's row starts with its first line level with the middle of the
sample, and long text (e.g. a wrapped remark) extends below it. Specimen rows
are laid out the same way, on their own, each level with its specimen. With
`fit_text`, the depth scale first stretches until no row runs into the next,
so every row lines up with its sampler symbol, and then until all descriptions
end within the depth of the boring. The first stretch is capped at an 8,000 px
log body; past that, rows that would collide are pushed down instead.

## Website

The paste page is in `site/`. `npm run build` bundles it, with the renderer and
validator, into `public/`, which is the folder Apache serves. The page runs
entirely in the browser:

- Paste JSON, open `.json` files, drag them onto the editor, or load an example.
- Several logs can be open at once, each in its own tab above the editor
  (‹ › step through them). Each opened file, example or borehole of an AGS4 or
  DIGGS file becomes a tab; **+ New** starts an empty one. The open logs are kept
  in the browser between visits, and **All logs (ZIP)** downloads every one as
  SVG and PNG.
- Open an AGS4 (`.ags`) or DIGGS (`.xml`) file: it is converted to JSON in the
  browser, one tab per borehole with strata (see
  [AGS4 import](#ags4-import) and [DIGGS import](#diggs-import)).
- A map below the editor shows every open log that has `metadata.latitude` and
  `longitude`, with a street (OpenStreetMap) or satellite (Esri) background;
  clicking a marker opens that log. It zooms to the logs within 50 km of the
  one being edited. The map tiles are the only thing the page loads from
  elsewhere. Leaflet draws the map and is bundled into the page.
- **Cross-sections:** press **Draw section line** under the map, click points
  along the section (a click on a boring puts a point on it), and double-click
  or press **Finish line**. The borings within a set distance of the line
  (100 m by default) are projected onto it, and the **Cross-section** view
  beside **Boring log** shows them at their distances along the line, with
  layers connected between neighbouring borings. It downloads as SVG or PNG
  like a log. See [Cross-sections](#cross-sections).
- The view switch (**Boring log**, **Cross-section**, **3D**) is at the top of
  the preview, with only the options that apply to that view below it: legend,
  header, references and column options for a log; "Layers between borings"
  (colours or USCS hatches) for a section; vertical exaggeration and opacity
  for the 3D model.
- Syntax and schema errors are listed with their location. Clicking one selects
  the offending text in the editor.
- The preview updates as you type.
- Download as SVG or PNG (1×, 2× or 3×), or print to PDF (the print style shows
  only the log).
- The open logs and option settings are kept in the browser's local storage.

Four examples are the synthetic test fixtures. The others are real borings
from one site in Nantou, Taiwan (`examples/NAS-1.json` to `NAS-4.json`, from the
PEER Taiwan Ground Failure Database via the NGL database): NAS-3 alone, or all
four at once in four tabs. They show no-recovery samples and USCS symbols that
don't match their descriptions.

## Cross-sections

`renderSection(entries, options)` and `placeAlongLine(points, line, corridor)`
in `src/section.js` draw a section from several borings; the web page uses
them with a line drawn on the map. How the layers are connected:

1. Each boring's layers are grouped into units: consecutive layers of the same
   main soil (gravel, sand, silt, clay, organic soils and peat) or material
   (fill, pavement, rock, or another built-in material such as topsoil). The
   class comes from the hatch the log draws, so a dual symbol such as SP-SM is
   sand and an inferred symbol counts too. No recovery, water and voids never
   connect. A recorded value that is not a USCS symbol (GP-GW, SM-ML) is
   replaced by our guess, the symbol read from the description or else its
   first group symbol, marked with * in the labels and listed under the figure.
2. The units of each pair of neighbouring borings are matched top to bottom by
   sequence alignment (as for DNA): matches never cross, connect only units of
   the same main soil (SP, SP-SM and SW connect; CL and CH connect; ML and MH
   connect; CL-ML (or ML-CL), ASTM's silty clay, is a clay that connects
   both to clay and to silt, so ML joins CL-ML, which joins CL, but ML never
   connects directly to a plain CL; sand never connects to either), and
   prefer units at similar depths (or elevations).
3. Matched units are drawn as bands between the borings, each half showing
   its own boring's layers (a unit of SC over SM keeps both, at their share of
   the unit's thickness, with dotted lines between them); where a silt joins
   a silty clay, the colour blends from one to the other across the middle.
   They are bounded by smooth curves (a layer's bottom and the next layer's
   top share their slopes, so no sliver opens between them): where a boundary continues across
   several borings its slope at each boring blends the slopes on either side
   (level where they differ in sign, so the curve never overshoots), and it
   meets a boring level where it ends. Units with no match fill the space
   between the connections above and below them with no gaps (dashed
   outlines): one boring's units thin out towards the other boring while the
   other's thicken, the shallower group on top; a group with no counterpart
   tapers to the other boring. Below the last connection, where the shallower
   boring has ended, the deeper boring's units continue level to it, the top
   one reaching up to the connection above (and on to the end of the section
   when the shallower boring is the outermost one). Beyond the outer
   borings, their layers are carried on level to the ends of the section (A
   and A′, or B and B′ and so on for the site's suggested sections), with
   dashed ends. Above each end is the compass direction it points to (e.g.
   "← WSW" over A and "ENE →" over A′), and the note under the figure gives
   the line's bearing.
4. A red "?" marks where an end or a connection is uncertain: at the point
   where a layer that pinches out runs out, at the end of a layer carried past
   a boring or to the end of the section, and on the upper boundary of a
   connection between units that share no depth (or elevation) range.
5. When the borings have no ground elevations (as in NGL), they are aligned
   at the ground surface, and a disclaimer under the figure (and in the 3D
   legend) says that the layer boundaries between borings are therefore not
   known with certainty.
6. The first groundwater reading of each boring is joined to its neighbours'
   by a smooth dashed blue curve.
7. By default (`style: 'colour'`) the layers between borings are coloured by
   main soil (gravel orange, sand yellow, silt light green, clay green, organic
   brown, fill grey, pavement dark grey, rock purple-grey) and each connected
   layer is labelled once, where it has the most room, e.g. "Clayey and silty
   SAND (SC, SM)" (just the symbols when the name doesn't fit); the boring
   columns keep their hatches. `style: 'hatch'` draws the USCS hatches between
   borings instead. The web page has a switch for it in the Cross-section view.

A section line can be at most 10 km long (`MAX_SECTION_LENGTH` in
`src/section.js`): on the map, a click that would make it longer is refused
with a message, and the API answers 400 for a longer `?line=`. The suggested
sections of a site are not limited.

The vertical axis is elevation when every boring has `metadata.elevation`,
otherwise depth below ground. Borings closer together than a column width are
spread apart and labelled with their own distances. The result is an
automatic interpretation and the figure says so.

## 3D view

The **3D** view (beside **Boring log** and **Cross-section**) draws the open
logs that have coordinates (within 50 km of the one being edited) as a block
model with three.js, in the style of Rocscience Settle3's soil profile: a box
around the borings (12 % margin) with the layers as coloured solids, the
borings as columns coloured by their layers (always drawn on top), the water
table as a dashed blue line around the sides (and a surface inside when the
layers are made see-through with the Opacity slider), distance and depth axes
with tick marks on the edges of the box that face you (they move to the other
edges when the view is turned round, so they are never behind the block), and a legend listing the layers from the top by name
("Silty and lean CLAY (ML-CL, CL-ML, CL)"); no text on the model itself.
Layers with the same name share a colour and one legend entry (marked "more
than one layer" when it occurs at several depths); different layers of one
main soil, such as several sands, get different shades of that soil's colour,
and the boring columns use the same colours as the block.

How the model is built (`src/model3d.js`, with `src/geometry.js`):

1. Neighbouring borings are found by a Delaunay triangulation of their
   positions, leaving out edges more than 2.5 times longer than the
   nearest-neighbour distance at either end (borings in a line are joined in
   order).
2. Between each pair of neighbours, the borings' units are matched by the same
   rules as the cross-sections (same main soil, silt joined to clay only
   through a silty clay, no crossing, similar depths). Units joined directly or through other borings
   form one model layer.
3. The layers are put in order from the top: each boring's order where they
   agree, and by mean depth where they conflict.
4. Each layer's thickness at each boring is its thickness there, or 0 where
   the boring doesn't have it. Over a 48 × 48 grid, every thickness is
   interpolated by inverse distance (power 2, exact at the borings) and the
   layers are stacked down from the ground (level, or the interpolated ground
   elevation when every boring has one). Layers missing in a boring thin out
   towards it.
5. Below the layers, down to the deepest boring, is "Not explored". The water
   table is the first reading of each boring, interpolated the same way.
6. The vertical exaggeration starts so the deepest boring is about 0.3 of the
   box's width, and can be changed with a slider.

**Slice:** press **Slice** and click two points on the model, A and A′. The
block is cut along the vertical plane through them: the side nearer the
camera is cut away (**Flip side** cuts the other), and the cut face shows the
layers. Below the view, the slice from A to A′ is drawn as a 2D section of the
model (`renderSlice()` in `src/slice.js`): the interpolated layers, ground,
water table and the part not explored, the borings within 5 % of the box's
size of the line at their distances along it, distance and depth (or
elevation) axes, A and A′ with the directions they point to, a legend of the
layers it cuts and the vertical exaggeration. It downloads as SVG or PNG. A
slice can be at most 10 km long. The 3D **PNG** includes the cut; the 3D
**SVG** shows the whole block.

Drag to turn, right-drag to move, scroll to zoom. **SVG** and **PNG** save the
current view (angle, exaggeration, opacity), cropped to the model, with the
legend below it:

- **PNG** is drawn again by WebGL at 1–4× the size on screen (the PNG menu),
  up to 8192 px a side (less if the graphics card can't draw that much); the
  labels, axes and legend are added as vector text, so they stay sharp.
- **SVG** is vector throughout: the faces of the block that face the camera
  (the ground and two or three sides, with each layer's band), shaded like the
  view, the layer boundaries, water table, borings, labels and legend, so it
  scales to any size and opens in Illustrator or Inkscape. With opacity below 1
  the faces are see-through, but the layers' surfaces inside the block are not
  drawn.
The model is an automatic interpretation and the legend says so.

## AGS4 import

AGS4 files (the UK and international geotechnical data transfer format) can be
drawn directly: open one on the web page, or send it to the API (below). The
conversion is `agsToBoringLogs()` in `src/ags.js`, shared by both, and makes one
document per borehole (`LOCA_ID`):

| AGS4 group | becomes |
|---|---|
| `PROJ`, `LOCA`, `HDIA` | metadata: project, site (`PROJ_LOC`), ground level, dates, hole type (expanded with `ABBR`, e.g. CP = Cable percussion), driller (`PROJ_CONT`), latitude/longitude when given, remarks, hole diameter |
| `GEOL` | layers (`GEOL_DESC`); rows without a base are left out with a warning |
| `DETL` | depth notes |
| `SAMP` | samples; `SAMP_TYPE` B/LB = Bulk, BLK = Block, D = Disturbed, U/UT/TW = Shelby, P = Piston, SPT, C = Core, WS = DirectPush; other types (ES, W...) are drawn as Other with the code in the sample number ("3 ES"). A sample with only a top is drawn 0.15 m long (0.45 m for an SPT). `SAMP_DESC` and `SAMP_REM` together are its remarks |
| `ISPT` | SPT blow counts (`ISPT_NVAL`, or the main drive of a refusal such as "50/150mm"), blows per 150 mm from `ISPT_INC1`–`6`, energy ratio |
| `LNMC`, `LLPL`, `GRAG`, `LDEN`, `LPDN` | water content, liquid and plastic limits (NP = nonplastic), fines content, dry unit weight (from dry density), specific gravity; matched to their sample, on one specimen per `SPEC_REF` and `SPEC_DPTH` |
| `WSTG` (and AGS3-style `WSTK`) | groundwater: water strikes |

AGS depths are metres, so documents are in SI units. "MADE GROUND", the British
term for fill, is drawn with the fill hatch. Tested on the synthetic
`tests/fixtures/example.ags` and on 48 real boreholes exported from the BGS
National Geoscience Data Centre. AGS3 files are rejected with a message.

## DIGGS import

DIGGS XML files (versions 2.5, 2.6 and 3.x, https://diggsml.org) are read the
same way, by `diggsToBoringLogs()` in `src/diggs.js`, which has its own small
XML reader (no DTDs or external entities) so it runs in the browser too. One
document per `Borehole` (also `TestPit`, `Trench`; CPT soundings are skipped):

| DIGGS | becomes |
|---|---|
| `Project`, `Borehole` | metadata: project, name, latitude/longitude/elevation from `referencePoint` (x y z, i.e. longitude first), dates, construction method and rig, logger and drilling contractor from the roles, remarks |
| linear referencing | the document's length unit (ft or m), from each borehole's `LinearReferencingMethod` |
| `LithologyObservation` | layers: `lithDescription`, or one composed from consistency, color, major and minor constituents and moisture; USCS from `classificationCode`/`legendCode`. An observation at a single depth inside a stratum becomes a depth note ("@ 4.5'; reddish brown"); outside one it starts a stratum |
| `SamplingActivity` | samples: method codes such as SS/SPT, ST/SH (Shelby), core sizes, bulk; recovery converted to the log's units |
| `Test` results | SPT N-value and drive-set blows; water content, liquid and plastic limits, nonplastic, fines, dry density (as unit weight, pcf for logs in feet), specific gravity, USCS symbol. Matched to samples by `sampleRef`, else by depth |
| `WaterStrike` | groundwater |

Property names vary between files (`n_value`, "N-Value"), so results are
matched on their class and name. Tested on a synthetic
`tests/fixtures/example.diggs.xml` and the official DIGGS examples
(github.com/DIGGSml/diggs-examples): the Ohio DOT projects (13 borings), the
annotated DIGGS 3 borehole, and the Bolivian grading example.

## Render API

`server/` is a Fastify service (`npm start`, which listens on
`127.0.0.1:3000`). Apache forwards `/boring-log-viewer/api/` to it.

| endpoint | returns |
|---|---|
| `POST /api/render` | The log as SVG (default), PNG or HTML. The body is the boring log JSON, an AGS4 file sent as `text/plain`, or a DIGGS file sent as `application/xml` (`?loca_id=` picks the borehole; required when the file has several). |
| `POST /api/ags` | An AGS4 file (`text/plain`) converted to `{ documents: [{ loca_id, document }], warnings }` |
| `POST /api/diggs` | A DIGGS file (`application/xml`) converted the same way |
| `POST /api/validate` | `{ valid, errors, warnings }` |
| `POST /api/site` | A whole site: the [site page](#site-api-for-ngl) (HTML, default) or, with `?format=json`, its borings, suggested cross-sections and 3D model as data |
| `POST /api/site/section` | One cross-section of a site (`?id=A` or `?line=lat,lon;lat,lon`) as SVG, PNG, HTML or JSON |
| `GET /api/schema` | The JSON Schema |
| `GET /api/health` | `{ status, version, endpoints }` |

```sh
curl -X POST -H "Content-Type: application/json" --data-binary @boring.json      "https://uclageo.com/boring-log-viewer/api/render?format=png&units=ft" -o boring.png
curl -X POST -H "Content-Type: text/plain" --data-binary @site.ags "https://uclageo.com/boring-log-viewer/api/render?loca_id=BH01&format=png" -o BH01.png
```

- **Format:** `?format=svg|png|html`. Without it, the `Accept` header decides
  (with q-values). An unknown format gets 406.
- **Query parameters:** the render options (`units`, `width`, `height`, `scale`,
  `font_size`, `columns` as a comma list, `header`, `legend`, `references`, `fit_text`,
  `hide_empty_columns`, `title`, `id_prefix`, `unit_weight`, `diameter_units`),
  plus `png_scale` (0.5–4, default 2) and `download=true`, which sets
  `Content-Disposition: attachment`. Unknown or invalid parameters get 400,
  so a typo is reported instead of ignored.
- **Errors** use one shape, `{ error, errors: [{ path, message }] }`:
  - 400: malformed JSON (with the parser's position) or a bad query parameter.
  - 415: a body that isn't `application/json` (or `text/plain` for AGS4, `application/xml` for DIGGS).
  - 422 for AGS4 and DIGGS: not AGS4 (e.g. AGS3) or malformed XML, no
    `LOCA` group or `Borehole`, no borehole chosen from several, or a borehole
    with no strata.
  - 413: a JSON body over 1 MB (10 MB for `/api/site`), or an AGS4/DIGGS file over 10 MB.
  - 422: an invalid log, more than 2,000 layers or 5,000 samples, or a PNG over
    40 megapixels.
  - 429: over the rate limit (60 requests per minute per client by default).
- **Warnings** such as layer gaps don't block rendering. They are returned in
  the `X-Boring-Log-Warnings` header.
- **CORS** is open (`Access-Control-Allow-Origin: *`), since the API takes no
  credentials. Request bodies are not stored or logged.
- **PNGs** are drawn with resvg using the bundled Arimo font (`server/fonts.js`),
  never the server's own fonts, so the text matches the measured layout.

### Site API (for NGL)

NGL's **Plot** button sends one boring to `/api/render`. For a site, send all
of its borings at once to `/api/site`:

```sh
# The site page: 3D model, suggested cross-sections, every log and a map
curl -X POST -H "Content-Type: application/json" --data-binary @site.json \
     "https://uclageo.com/boring-log-viewer/api/site" -o site.html
# The same as data
curl -X POST -H "Content-Type: application/json" --data-binary @site.json \
     "https://uclageo.com/boring-log-viewer/api/site?format=json&grid=40" -o site-model.json
# One section as PNG
curl -X POST -H "Content-Type: application/json" --data-binary @site.json \
     "https://uclageo.com/boring-log-viewer/api/site/section?id=A&format=png" -o A.png
```

**Body:** `{ "name": "Nantou", "borings": [boring log, ...] }`, a bare array
of boring logs, or an AGS4 / DIGGS file (every borehole with strata). At most
200 borings and 10 MB. Each boring is validated as for `/api/render`; errors
point at the boring (`/borings/2/layers/0/bottom`). Borings without
`metadata.latitude` and `longitude` are still shown as logs, but are left out
of the map, sections and 3D model (a warning says so).

**`POST /api/site`** — query: `format=html|json` (HTML by default, or JSON when
`Accept` asks only for it), `name`, `units`, `style=colour|hatch` and `width`
for the sections, `svg=false` to leave the section SVGs out of the JSON,
`grid=2..100` to add the model's surfaces on a grid, `download=true`.

- **HTML** is one self-contained page (script, styles and data inlined; only
  map tiles come from elsewhere), so NGL can open it in a new tab, an iframe or
  save it. It has three tabs, each with only its own options at the top:
  **3D model** (exaggeration, opacity, SVG, PNG at 1–4×), **Cross-sections** (pick a
  suggested section, colours or hatches, units, SVG/PNG) and **Boring logs**
  (pick a boring, units, SVG/PNG). Clicking a line on the map opens that
  section; clicking a boring opens its log. The server must have been built
  (`npm run build`) for this; otherwise it answers 503 and JSON still works.
- **JSON:** `{ name, borings: [{ index, name, latitude, longitude, depth,
  units }], sections: [...], model, warnings }`. Each section is `{ id, name,
  kind, description, line: [{ lat, lon }], corridor, length, borings: [{ name,
  index, chainage, offset, side }], svg, warnings }`. With `svg=true`, each section's own drawing warnings are in its `warnings`, not in the top-level `warnings`, so check both. `model` (null with fewer
  than two located borings) is `{ levels: 'elevation'|'depth', box,
  layers: [{ id, label, uscs, guessed, colour, soil, borings }], borings: [{
  index, name, x, y, ground, depth, groundwater, units: [{ top, bottom, layer
  }] }] }`, positions in metres east and north of the site's centre, layers
  from the top. With `grid=n`, `model.grid` adds `{ nx, ny, x, y, ground,
  tops: [one array per layer], base, water }`, levels in metres at the
  (n + 1)² grid points, row by row from the south.

**Suggested cross-sections** (`src/site.js`, `autoSections`), from the layout
of the borings:

| id | section | when |
|---|---|---|
| A | Along the site: the direction the borings spread most (principal axis), through their centre; borings within 15 % of its length (25 m at least) | always (two or more located borings) |
| B | Across the site, at right angles to A through the boring nearest the centre | the site is at least 20 % as wide as it is long |
| next | Through every boring, a bent line from boring to boring in order along the site | A and B leave borings out, or project one from more than 10 m away |
| next | Across at 25 % and 75 % along | more than six borings on a site at least twice as long as wide |

A section that would show the same borings as an earlier one is left out, and
letters follow on (A, B, C, ...).

**`POST /api/site/section`** — query: `id=A` (a suggested section) or
`line=lat,lon;lat,lon[;...]` with `corridor` (m, default 100), plus `format=svg|png|html|json`,
`style`, `units`, `width`, `title`, `png_scale`, `download`. 404 for an
unknown id (the message lists the ids); 422 when no boring is near the line.

Deployment (Rocky Linux 9, Apache, systemd) is described in
[`deploy/README.md`](deploy/README.md).

## Development

```sh
npm install
npm test                     # unit tests + snapshot comparison + resvg parse check
npm run dev                  # build the site, rebuild on change, serve at http://localhost:8080/
npm start                    # run the render API on http://127.0.0.1:3000/
npm run build                # production build into public/
npm run test:update          # re-render tests/snapshots/*.svg after an intended layout change
npm run render -- tests/fixtures/coastal-style.json out.png [--units=ft] [--width=900]
npm run build:hatches        # regenerate src/hatches.js from scripts/uscs-art.js and lithology-art.js
npm run build:metrics        # regenerate src/font-metrics.js (only if changing the font)
```

After changing the layout, render the fixtures to PNG and look at them before
running `test:update`. The snapshot test only shows that the output changed, not
that the new output is right.

The fixtures are **synthetic**. They follow the shape of coastal_database and
vspdb records, but they aren't real borings. Before switching either app to this
renderer, replace them with exports of real borings.

## Notes for the coastal_database / vspdb adapters

These were found while porting the old viewer (`coastal_database/templates/Boreholes/view.php`):

- In coastal_database, blow counts are stored in `samples.N`, but the old viewer
  read `blow_count`, so blow counts never displayed. The adapter should map `N`
  to `blow_count`.
- In coastal_database, the sampler type comes from `sampler_id`, which the old
  viewer mapped by list position to
  `['Other','SPT','Shelby','ModCal','Piston','Piston','Bulk','Shelby','Other','ModCal']`.
  Check that mapping against the `samplers` table.
- The old `get_hatch_code.js` returned early whenever the description didn't
  contain a USCS symbol, so its keyword matching never ran. `src/classify.js`
  ports it with that fixed and a few keywords added (elastic, organic, peat).
- In vspdb, lab values live in `index_properties` (under samples) and blow counts
  in `spt_data` (under `spt_metadata`, matched by depth). The adapter needs to
  join them onto samples.
