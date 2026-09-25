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
  `uscs`, then a symbol inferred from the description (e.g. "silty SAND" gives
  SM). Dual symbols such as `SP-SM` split the column in half.
  A layer without `uscs` gets a symbol inferred from its description, shown in
  parentheses as "(CH)", only when the description determines it: a symbol
  written in the text ("(SP-SM)"), an ASTM D2487 group name ("fat CLAY",
  "silty SAND", "poorly graded SAND with silt"), CLAY or SILT with a plasticity
  descriptor, "silty clay" (CL-ML), SILT group names (ML), and organic SILT/CLAY
  with low (OL) or high (OH) plasticity. Mixed layers, ranges ("lean to fat"),
  bare SAND or GRAVEL, and "clayey SILT" get none. The rules are in
  `inferUscs()` in `src/classify.js`; they were reviewed against 655 layer
  descriptions from the NGL database.
- **`samples`**: `{ top, bottom, name, type, blow_count, blows, water_content,
  dry_unit_weight, specific_gravity, fines_content, liquid_limit, plastic_limit,
  nonplastic, description, remarks, ... }`. `type` is one of SPT, ModCal,
  Shelby, Piston, Bulk, Core, Other.
- **`groundwater`**: a list of `{ depth, date, note }`.
- **`depth_notes`**: a list of `{ depth, description }` for observations at one
  depth within a layer ("thin sand lens"). They are drawn in italics in the
  material description column, with a tick at their depth.
- **`patterns`**: your own graphic log patterns and sampler symbols, by code:
  `{ "FILL": { "name": "Fill", "image": "data:image/png;base64,...", "width": 96, "height": 96 } }`.
  `image` is a base64 data URI of a PNG, JPEG or SVG (at most 350,000
  characters); `width` and `height` are its pixel size. Add `"kind": "sampler"`
  for a sampler symbol (stretched to fill the sample's box), and `tile_width`
  (px on the log) to change how large a soil tile is drawn; by default one tile
  spans the graphic log column. A code equal to a USCS symbol (`SM`) or a
  built-in sampler (`SPT`) replaces the built-in pattern everywhere in the log.
  Any other code (letters, digits and `_`, up to 16 characters, starting with a
  letter) adds a new one: set a layer's `hatch`, or a sample's `type`, to it.
  Custom codes also work in dual patterns such as `"hatch": "SP-FILL"`. Images
  are embedded in the SVG, so logs stay self-contained. The web page's
  **Patterns…** button builds these entries from an image file, scaling large
  images down to 512 px and optionally tracing black-and-white patterns to
  vector shapes (with imagetracerjs).
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
- Syntax and schema errors are listed with their location. Clicking one selects
  the offending text in the editor.
- The preview updates as you type.
- Download as SVG or PNG (1×, 2× or 3×), or print to PDF (the print style shows
  only the log).
- The last JSON and option settings are kept in the browser's local storage.

The four examples are the synthetic test fixtures.

## Render API

`server/` is a Fastify service (`npm start`, which listens on
`127.0.0.1:3000`). Apache forwards `/boring-log-viewer/api/` to it.

| endpoint | returns |
|---|---|
| `POST /api/render` | The log as SVG (default), PNG or HTML. The body is the boring log JSON. |
| `POST /api/validate` | `{ valid, errors, warnings }` |
| `GET /api/schema` | The JSON Schema |
| `GET /api/health` | `{ status, version, endpoints }` |

```sh
curl -X POST -H "Content-Type: application/json" --data-binary @boring.json      "https://uclageo.com/boring-log-viewer/api/render?format=png&units=ft" -o boring.png
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
  - 415: a body that isn't `application/json`.
  - 413: a body over 1 MB.
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
npm run build:hatches        # regenerate src/hatches.js from assets/hatches/*.svg
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
