// Text measurement and wrapping from a static metrics table, so the layout
// does not depend on the DOM and comes out the same in browsers and Node.
import { UNITS_PER_EM, REGULAR, BOLD } from './font-metrics.js';

// Rendered text uses Arial or a metric-compatible substitute (Liberation Sans,
// Arimo); the metrics table was built from Arimo.
export const FONT_FAMILY = "Arial, 'Liberation Sans', Arimo, Helvetica, sans-serif";

// Width used for characters missing from the table (roughly a digit).
const FALLBACK = 1139;

export function measureText(text, fontSize, bold = false) {
    const widths = bold ? BOLD : REGULAR;
    let units = 0;
    for (const ch of String(text)) {
        units += widths[ch.codePointAt(0)] ?? FALLBACK;
    }
    return (units * fontSize) / UNITS_PER_EM;
}

// Greedy word wrap. Honors explicit newlines and breaks words that are
// longer than the line on their own.
export function wrapText(text, maxWidth, fontSize, bold = false) {
    const lines = [];
    if (text == null || text === '') return lines;
    const fits = s => measureText(s, fontSize, bold) <= maxWidth;
    for (const paragraph of String(text).split(/\r?\n/)) {
        const words = paragraph.split(/\s+/).filter(Boolean);
        if (words.length === 0) {
            lines.push('');
            continue;
        }
        let line = '';
        for (let word of words) {
            const candidate = line ? `${line} ${word}` : word;
            if (fits(candidate)) {
                line = candidate;
                continue;
            }
            if (line) lines.push(line);
            // Break a word that cannot fit on a line by itself.
            while (!fits(word) && word.length > 1) {
                let cut = word.length - 1;
                while (cut > 1 && !fits(word.slice(0, cut))) cut--;
                lines.push(word.slice(0, cut));
                word = word.slice(cut);
            }
            line = word;
        }
        if (line) lines.push(line);
    }
    return lines;
}

export function escapeXml(value) {
    return String(value)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}
