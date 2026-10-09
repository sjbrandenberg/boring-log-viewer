// Column ids of the boring log, shared by the renderer and the input checks.

export const DEFAULT_COLUMNS = [
    'depth', 'elevation', 'groundwater', 'graphic', 'uscs', 'description',
    'sample_type', 'sample_name', 'sampler_diameter', 'blow_count',
    'specimen', 'specimen_name',
    'water_content', 'total_unit_weight', 'dry_unit_weight', 'specific_gravity', 'fines_content', 'liquid_limit', 'plastic_limit',
    'remarks',
];

// Every built-in column; energy_ratio is drawn only when asked for.
export const BUILT_IN_COLUMNS = [...DEFAULT_COLUMNS, 'energy_ratio'];
