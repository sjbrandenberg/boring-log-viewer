// Fonts for server-side PNG rendering. The SVG text was laid out with Arimo's
// metrics (see src/font-metrics.js), so resvg is given Arimo itself instead of
// whatever fonts the server has installed. @fontsource ships WOFF, which
// resvg cannot read, so the files are unpacked to plain TrueType here.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { inflateSync } from 'node:zlib';

// WOFF 1.0 -> SFNT (TrueType/OpenType). WOFF is the SFNT tables, each
// optionally zlib-compressed, behind a 44-byte header and a 20-byte-per-table
// directory: https://www.w3.org/TR/WOFF/
export function woffToSfnt(woff) {
    if (woff.toString('latin1', 0, 4) !== 'wOFF') throw new Error('not a WOFF 1.0 file');
    const flavor = woff.readUInt32BE(4);
    const numTables = woff.readUInt16BE(12);

    const tables = [];
    for (let i = 0; i < numTables; i++) {
        const entry = 44 + i * 20;
        const offset = woff.readUInt32BE(entry + 4);
        const compLength = woff.readUInt32BE(entry + 8);
        const origLength = woff.readUInt32BE(entry + 12);
        const raw = woff.subarray(offset, offset + compLength);
        tables.push({
            tag: woff.subarray(entry, entry + 4),
            checksum: woff.readUInt32BE(entry + 16),
            data: compLength < origLength ? inflateSync(raw) : raw,
        });
    }

    const pad4 = n => (n + 3) & ~3;
    const headerSize = 12 + numTables * 16;
    const total = headerSize + tables.reduce((n, t) => n + pad4(t.data.length), 0);
    const out = Buffer.alloc(total);
    const log2 = Math.floor(Math.log2(numTables));
    out.writeUInt32BE(flavor, 0);
    out.writeUInt16BE(numTables, 4);
    out.writeUInt16BE(2 ** log2 * 16, 6);
    out.writeUInt16BE(log2, 8);
    out.writeUInt16BE(numTables * 16 - 2 ** log2 * 16, 10);

    let dataOffset = headerSize;
    tables.forEach((t, i) => {
        const rec = 12 + i * 16;
        t.tag.copy(out, rec);
        out.writeUInt32BE(t.checksum, rec + 4);
        out.writeUInt32BE(dataOffset, rec + 8);
        out.writeUInt32BE(t.data.length, rec + 12);
        t.data.copy(out, dataOffset);
        dataOffset += pad4(t.data.length);
    });
    return out;
}

// Writes regular and bold Arimo (Latin and Latin-1 supplement) as TrueType
// files and returns their paths. resvg-js 2.x takes font file paths only; its
// fontBuffers option is not supported and silently discards all options.
export function loadFonts(dir = join(tmpdir(), 'boring-log-viewer-fonts')) {
    const require = createRequire(import.meta.url);
    const src = require.resolve('@fontsource/arimo/package.json').replace(/package\.json$/, 'files/');
    mkdirSync(dir, { recursive: true });
    return ['arimo-latin-400-normal', 'arimo-latin-700-normal'].map(name => {
        const path = join(dir, `${name}.ttf`);
        writeFileSync(path, woffToSfnt(readFileSync(`${src}${name}.woff`)));
        return path;
    });
}
