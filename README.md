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
  symbol inferred from the description (e.g. "silty SAND" gives SM). The USCS hatches follow the Caltrans *Soil and Rock Logging,
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
- **`samples`**: `{ top, bottom, name, type, blow_count, blows, water_content,
  dry_unit_weight, specific_gravity, fines_content, liquid_limit, plastic_limit,
  nonplastic, description, remarks, ... }`. `type` picks the symbol in the
  sample column, one of: drive samplers `SPT`, `ModCal`, `DamesMoore`;
  push samplers `Shelby`, `Piston`, `Osterberg`, `Pitcher`, `Denison`,
  `LargeDiameter`, `DirectPush`, `GelPush`; `Block`; cores `Sonic`, `Core`,
  `TripleTube`; disturbed samples `Bulk`, `Grab`, `Composite`, `Auger`,
  `Trench`, `Disturbed`; `NoRecovery`; and `Other` (the default). The list and
  legend names are in `src/samplers.js`.
- **`groundwater`**: a list of `{ depth, date, note }`.
- **`depth_notes`**: a list of `{ depth, description }` for observations at one
  depth within a layer ("thin sand lens"). They are drawn in italics in the
  material description column, with a tick at their depth.
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
| `columns` | see `DEFAULT_COLUMNS` | Column ids, in order |
| `hide_empty_columns` | true | Drop columns with no data |
| `header`, `legend` | true | Metadata block above, legend below |
| `title` | `metadata.boring_name` | Title text |
| `depth_range` | `[0, deepest]` | `[top, bottom]` in display units |
| `font_size` | 10 | px |
| `infer_uscs` | true | For layers without `uscs`, show a USCS symbol inferred from the description, in parentheses (see below) |
| `infer_materials` | true | For layers without `hatch`, draw a material or rock hatch named in the description (fill, asphalt, topsoil, shale...), ahead of `uscs` |
| `id_prefix` | hash of the data | Prefix for `<pattern>` ids. Logs with different data get different ids, so several can share a page. |

Column ids: `depth`, `elevation`, `groundwater`, `graphic`, `uscs`,
`description`, `sample_type`, `sample_name`, `sampler_diameter`, `recovery`,
`blow_count`, `energy_ratio`, `sample_description`, `water_content`,
`dry_unit_weight`, `specific_gravity`, `fines_content`, `liquid_limit`,
`plastic_limit`, `remarks`.

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
sample, and long text (e.g. a wrapped remark) extends below it. With
`fit_text`, the depth scale first stretches until no row runs into the next,
so every row lines up with its sampler symbol, and then until all descriptions
end within the depth of the boring. The first stretch is capped at an 8,000 px
log body; past that, rows that would collide are pushed down instead.

## Website

The paste page is in `site/`. `npm run build` bundles it, with the renderer and
validator, into `public/`, which is the folder Apache serves. The page runs
entirely in the browser:

- Paste JSON, open a `.json` file, drag one onto the editor, or load an example.
- Open an AGS4 (`.ags`) or DIGGS (`.xml`) file: it is converted to JSON in the
  browser, with a borehole picker when the file has more than one (see
  [AGS4 import](#ags4-import) and [DIGGS import](#diggs-import)).
- Syntax and schema errors are listed with their location. Clicking one selects
  the offending text in the editor.
- The preview updates as you type.
- Download as SVG or PNG (1×, 2× or 3×), or print to PDF (the print style shows
  only the log).
- The last JSON and option settings are kept in the browser's local storage.

The four examples are the synthetic test fixtures.

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
| `SAMP` | samples; `SAMP_TYPE` B/LB = Bulk, BLK = Block, D = Disturbed, U/UT/TW = Shelby, P = Piston, SPT, C = Core, WS = DirectPush; other types (ES, W...) are drawn as Other with the code in the sample number ("3 ES"). A sample with only a top is drawn 0.15 m long (0.45 m for an SPT) |
| `ISPT` | SPT blow counts (`ISPT_NVAL`, or the main drive of a refusal such as "50/150mm"), blows per 150 mm from `ISPT_INC1`–`6`, energy ratio |
| `LNMC`, `LLPL`, `GRAG`, `LDEN`, `LPDN` | water content, liquid and plastic limits (NP = nonplastic), fines content, dry unit weight (from dry density), specific gravity; matched to their sample |
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
| `GET /api/schema` | The JSON Schema |
| `GET /api/health` | `{ status, version, endpoints }` |

```sh
curl -X POST -H "Content-Type: application/json" --data-binary @boring.json      "https://uclageo.com/boring-log-viewer/api/render?format=png&units=ft" -o boring.png
curl -X POST -H "Content-Type: text/plain" --data-binary @site.ags "https://uclageo.com/boring-log-viewer/api/render?loca_id=BH01&format=png" -o BH01.png
```

- **Format:** `?format=svg|png|html`. Without it, the `Accept` header decides
  (with q-values). An unknown format gets 406.
- **Query parameters:** the render options (`units`, `width`, `height`, `scale`,
  `font_size`, `columns` as a comma list, `header`, `legend`, `fit_text`,
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
  - 413: a JSON body over 1 MB, or an AGS4/DIGGS file over 10 MB.
  - 422: an invalid log, more than 2,000 layers or 5,000 samples, or a PNG over
    40 megapixels.
  - 429: over the rate limit (60 requests per minute per client by default).
- **Warnings** such as layer gaps don't block rendering. They are returned in
  the `X-Boring-Log-Warnings` header.
- **CORS** is open (`Access-Control-Allow-Origin: *`), since the API takes no
  credentials. Request bodies are not stored or logged.
- **PNGs** are drawn with resvg using the bundled Arimo font (`server/fonts.js`),
  never the server's own fonts, so the text matches the measured layout.

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
