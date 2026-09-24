// Re-renders every tests/fixtures/*.json into tests/snapshots/*.svg.
// Run after an intentional layout change, then review the diff (and the
// PNGs from `npm run render`) before committing.
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { renderBoringLog } from '../src/index.js';

const fixtures = new URL('../tests/fixtures/', import.meta.url);
const snapshots = new URL('../tests/snapshots/', import.meta.url);
for (const file of readdirSync(fixtures).filter(f => f.endsWith('.json'))) {
    const svg = renderBoringLog(readFileSync(new URL(file, fixtures), 'utf8'));
    writeFileSync(new URL(file.replace(/\.json$/, '.svg'), snapshots), svg + '\n');
    console.log(`updated ${file.replace(/\.json$/, '.svg')}`);
}
