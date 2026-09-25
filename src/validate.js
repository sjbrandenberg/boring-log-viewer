// Full validation against the JSON Schema, for the paste page and the API.
// Returns every problem at once with a JSON Pointer path, rather than
// throwing on the first one.
import Ajv2020 from 'ajv/dist/2020.js';
import schema from '../schema/boring-log.schema.json' with { type: 'json' };
import { stripNulls, checkDepths, checkPatternReferences } from './normalize.js';

const ajv = new Ajv2020({ allErrors: true, strict: true, allowUnionTypes: true });
const validateSchema = ajv.compile(schema);

function describe(err) {
    switch (err.keyword) {
        case 'additionalProperties':
            return `unknown property "${err.params.additionalProperty}"`;
        case 'enum':
            return `must be one of: ${err.params.allowedValues.join(', ')}`;
        case 'const':
            return `must be ${JSON.stringify(err.params.allowedValue)}`;
        case 'pattern':
            if (err.propertyName !== undefined || /^\/patterns$/.test(err.instancePath)) {
                return `pattern code "${err.propertyName}" must be a letter followed by up to 15 letters, digits or _`;
            }
            if (/\/image$/.test(err.instancePath)) return 'must be a base64 data URI of a PNG, JPEG or SVG image (data:image/png;base64,...)';
            if (/\/hatch$/.test(err.instancePath)) return 'must be "none", a USCS symbol (e.g. SM, SP-SM), or a code defined in patterns';
            return 'is not a recognized USCS symbol (e.g. SM, CL, SP-SM)';
        default:
            return err.message;
    }
}

// The value at a JSON Pointer such as /layers/4/uscs, or undefined.
function valueAt(doc, pointer) {
    return pointer.split('/').slice(1).reduce((v, key) => (v == null ? undefined : v[key.replace(/~1/g, '/').replace(/~0/g, '~')]), doc);
}

// The sample type's anyOf reports one error per branch; show one message instead.
function collapse(errors, doc) {
    const out = [];
    const typePaths = new Set();
    const patterns = doc && typeof doc.patterns === 'object' && doc.patterns ? doc.patterns : {};
    for (const err of errors) {
        // A custom pattern code put in "uscs" instead of "hatch".
        if (err.keyword === 'pattern' && /\/uscs$/.test(err.instancePath)) {
            const value = valueAt(doc, err.instancePath);
            if (typeof value === 'string' && Object.prototype.hasOwnProperty.call(patterns, value)) {
                const layer = /^\/layers\//.test(err.instancePath);
                out.push({
                    path: err.instancePath,
                    message: `"${value}" is a custom pattern, not a USCS symbol: ${layer ? `use "hatch": "${value}" to draw it` : 'custom patterns are used through a layer\'s "hatch"'} ("uscs" only takes USCS symbols)`,
                });
                continue;
            }
        }
        if (/^\/samples\/\d+\/type$/.test(err.instancePath)) {
            if (!typePaths.has(err.instancePath)) {
                typePaths.add(err.instancePath);
                out.push({ path: err.instancePath, message: 'must be SPT, ModCal, Shelby, Piston, Bulk, Core, Other, or a sampler code defined in patterns' });
            }
            continue;
        }
        out.push({ path: err.instancePath, message: describe(err) });
    }
    return out;
}

export function validateBoringLog(input) {
    let doc = input;
    if (typeof doc === 'string') {
        try {
            doc = JSON.parse(doc);
        } catch (e) {
            return { valid: false, errors: [{ path: '', message: `Invalid JSON: ${e.message}` }], warnings: [] };
        }
    }
    doc = stripNulls(doc);
    const errors = [];
    if (!validateSchema(doc)) errors.push(...collapse(validateSchema.errors, doc));
    const target = doc && typeof doc === 'object' ? doc : {};
    const depth = checkDepths(target);
    errors.push(...depth.errors);
    // Reference checks only add something for fields the schema accepted.
    const flagged = new Set(errors.map(e => e.path));
    errors.push(...checkPatternReferences(target).filter(e => !flagged.has(e.path)));
    return { valid: errors.length === 0, errors, warnings: depth.warnings };
}

export { schema };
