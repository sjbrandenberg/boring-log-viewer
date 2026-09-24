# Boring log viewer

Renders a geotechnical boring log from JSON as a standalone SVG. The same
module serves the paste-and-preview page at
`www.uclageo.com/boring-log-viewer` (see [Website](#website)) and will serve the render API and the viewers in
coastal_database and vspdb.

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
- **`samples`**: `{ top, bottom, name, type, blow_count, blows, water_content,
  dry_unit_weight, specific_gravity, fines_content, liquid_limit, plastic_limit,
  nonplastic, description, remarks, ... }`. `type` is one of SPT, ModCal,
  Shelby, Piston, Bulk, Core, Other.
- **`groundwater`**: a list of `{ depth, date, note }`.
- **`null` means "not given"**, so database exports can be passed through
  without cleaning. Unknown property names are errors, which catches typos.

## Render options

| option | default | meaning |
|---|---|---|
| `width` | 800 | SVG width in px. It widens if the text columns would go below 60 px per flex unit. |
| `height` | 500 | Starting height of the log body in px |
| `scale` | – | px per display length unit; overrides `height` |
| `fit_text` | true | Stretch the depth scale until stacked descriptions fit within it |
| `units` | data's units | Display length units, `m` or `ft`; unit weight and diameter follow unless set below |
| `unit_weight`, `diameter_units` | – | Override display units |
| `columns` | see `DEFAULT_COLUMNS` | Column ids, in order |
| `hide_empty_columns` | true | Drop columns with no data |
| `header`, `legend` | true | Metadata block above, legend below |
| `title` | `metadata.boring_name` | Title text |
| `depth_range` | `[0, deepest]` | `[top, bottom]` in display units |
| `font_size` | 10 | px |
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
boundary to the text. With `fit_text`, the depth scale stretches until all
descriptions end within the depth of the boring. Sample values are centered on
their sample interval and pushed down in the same way when rows would collide.

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

### Deploying at www.uclageo.com/boring-log-viewer

Clone the repository to the directory Apache serves as `/boring-log-viewer`,
then, after each `git pull`:

```sh
npm ci
npm run build
```

The root `.htaccess` sends every request into `public/`, so the page is served
at `/boring-log-viewer/`, and nothing outside `public/` (source, tests,
`node_modules`, `.git`) is reachable. This needs `mod_rewrite` and
`AllowOverride` for the directory, the same as the CakePHP apps. `public/` is
build output and is not committed.

## Development

```sh
npm install
npm test                     # unit tests + snapshot comparison + resvg parse check
npm run dev                  # build the site, rebuild on change, serve at http://localhost:8080/
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
