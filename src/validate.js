// Full validation against the JSON Schema, for the paste page and the API.
// Returns every problem at once with a JSON Pointer path, rather than
// throwing on the first one.
import Ajv2020 from 'ajv/dist/2020.js';
import schema from '../schema/boringlog.schema.json' with { type: 'json' };
import { stripNulls, checkDepths } from './normalize.js';

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
            return 'is not a recognized USCS symbol (e.g. SM, CL, SP-SM)';
        default:
            return err.message;
    }
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
    if (!validateSchema(doc)) {
        for (const err of validateSchema.errors) {
            errors.push({ path: err.instancePath, message: describe(err) });
        }
    }
    const depth = checkDepths(doc && typeof doc === 'object' ? doc : {});
    errors.push(...depth.errors);
    return { valid: errors.length === 0, errors, warnings: depth.warnings };
}

export { schema };
