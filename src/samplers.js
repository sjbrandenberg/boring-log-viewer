// Built-in sampler types (a sample's `type`) and their legend names, in legend
// order. The symbols are drawn by samplerSymbol() in render.js; the schema's enum
// (schema/boring-log.schema.json) must list the same codes.
export const SAMPLER_NAMES = {
    SPT: 'Standard penetration test (SPT)',
    ModCal: 'Modified California',
    DamesMoore: 'Dames & Moore (ring-lined)',
    Shelby: 'Shelby tube',
    Piston: 'Piston sampler',
    Osterberg: 'Osterberg (fixed piston)',
    Pitcher: 'Pitcher barrel',
    Denison: 'Denison',
    LargeDiameter: 'Large-diameter sampler',
    Block: 'Block sample',
    DirectPush: 'Direct push (e.g. dual tube)',
    GelPush: 'Gel push',
    Sonic: 'Sonic core',
    Core: 'Rock core',
    TripleTube: 'Triple-tube core',
    Bulk: 'Bulk sample',
    Grab: 'Grab sample',
    Composite: 'Composite sample',
    Auger: 'Auger cuttings or hand auger',
    Trench: 'Trench or test-pit sample',
    Disturbed: 'Disturbed or remolded sample',
    NoRecovery: 'No recovery (attempted sample)',
    Other: 'Other sampler',
};
