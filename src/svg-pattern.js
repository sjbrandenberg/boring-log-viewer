// Custom patterns given as SVG markup ("svg": "<svg ...>...</svg>" in a pattern
// entry). The markup is parsed and rebuilt from an allowlist of drawing elements
// and paint attributes, so nothing else (scripts, event handlers, links, external
// images, CSS) can reach the log. The rebuilt SVG is then drawn like an uploaded
// image, as a data URI in an <image>, which browsers never run scripts from.

const SHAPES = new Set(['g', 'path', 'rect', 'circle', 'ellipse', 'line', 'polyline', 'polygon']);
// Dropped with their contents: descriptive markup that editors (Inkscape,
// Illustrator) add and that draws nothing.
const IGNORED = new Set(['title', 'desc', 'metadata']);
const PAINT = [
    'fill', 'fill-opacity', 'fill-rule', 'stroke', 'stroke-width', 'stroke-opacity', 'stroke-linecap',
    'stroke-linejoin', 'stroke-miterlimit', 'stroke-dasharray', 'stroke-dashoffset', 'opacity',
];
const GEOMETRY = ['x', 'y', 'width', 'height', 'rx', 'ry', 'cx', 'cy', 'r', 'x1', 'y1', 'x2', 'y2', 'd', 'points', 'transform'];
const ALLOWED_ATTRS = new Set([...PAINT, ...GEOMETRY]);
const ROOT_ATTRS = new Set(['width', 'height', 'viewBox', 'preserveAspectRatio', ...PAINT]);
// Numbers, colour names, #hex, rgb(...), transform lists, path data.
const SAFE_VALUE = /^[\w#.,%\s()+-]*$/;
const UNSAFE_VALUE = /url\s*\(|script|expression/i;

export const SVG_ELEMENTS_HELP = 'use path, rect, circle, ellipse, line, polyline, polygon or g';

const escapeAttr = v => v.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');

function parseAttributes(src) {
    const attrs = [];
    const re = /([^\s=/]+)\s*=\s*("([^"]*)"|'([^']*)')/g;
    let m;
    let rest = src;
    while ((m = re.exec(src))) {
        attrs.push([m[1], m[3] ?? m[4]]);
        rest = rest.replace(m[0], '');
    }
    if (rest.replace(/\//g, '').trim()) throw new Error(`can't read the attributes "${rest.trim().slice(0, 40)}" (each needs name="value")`);
    return attrs;
}

// Keeps the allowed attributes, reading style="fill:#000;stroke:none" into
// attributes too. Unknown attributes (id, class, inkscape:..., on...) are dropped.
function cleanAttributes(attrs, allowed) {
    const out = new Map();
    const put = (name, value) => {
        value = value.trim();
        if (allowed.has(name) && SAFE_VALUE.test(value) && !UNSAFE_VALUE.test(value)) out.set(name, value);
    };
    for (const [name, value] of attrs) {
        if (name === 'style') {
            for (const decl of value.split(';')) {
                const i = decl.indexOf(':');
                if (i > 0) put(decl.slice(0, i).trim(), decl.slice(i + 1));
            }
        } else {
            put(name, value);
        }
    }
    return out;
}

const attrText = map => [...map].map(([k, v]) => ` ${k}="${escapeAttr(v)}"`).join('');

// Size in px from a width/height attribute ("40", "40px"); other units don't count.
const px = v => (v !== undefined && /^\s*[\d.]+\s*(px)?\s*$/.test(v) ? Number.parseFloat(v) : null);

/**
 * Parses and rebuilds pattern SVG markup.
 * @returns {{ svg: string, width: number, height: number }}
 * @throws Error with a message for the user when the markup can't be used
 */
export function cleanSvg(text) {
    if (typeof text !== 'string') throw new Error('must be SVG markup as a string');
    const src = text.trim();
    const token = /<!--[\s\S]*?-->|<\?[\s\S]*?\?>|<!\[CDATA\[|<!([A-Za-z]+)|<\/\s*([^\s>]+)\s*>|<([^\s/>]+)((?:\s+[^\s=/>]+\s*=\s*(?:"[^"]*"|'[^']*'))*)\s*(\/?)>|[^<]+|</g;
    const stack = [];   // open elements: { name, ignored }
    const out = [];
    let root = null;
    let skipDepth = 0;  // how many ignored elements we're inside
    let m;
    while ((m = token.exec(src))) {
        const [whole, bang, close, open, attrSrc, selfClose] = m;
        if (whole.startsWith('<!--') || whole.startsWith('<?')) continue;
        if (whole === '<![CDATA[') throw new Error('CDATA sections aren\'t allowed');
        if (bang) throw new Error(`<!${bang}> isn't allowed`);
        if (whole === '<') throw new Error('has a "<" that doesn\'t start a tag');
        if (close !== undefined) {
            const top = stack.pop();
            if (!top || top.name !== close) throw new Error(`</${close}> doesn't match ${top ? `<${top.name}>` : 'an open tag'}`);
            if (top.ignored) skipDepth--;
            else if (stack.length) out.push(`</${close}>`); // the root's </svg> is added below
            continue;
        }
        if (open !== undefined) {
            const name = open;
            const ignored = skipDepth > 0 || IGNORED.has(name) || name.includes(':');
            if (!root) {
                if (name !== 'svg') throw new Error('must start with an <svg> element');
                root = cleanAttributes(parseAttributes(attrSrc), ROOT_ATTRS);
                if (!selfClose) stack.push({ name, ignored: false });
                continue;
            }
            if (!stack.length) throw new Error('has content after </svg>');
            if (!ignored && !SHAPES.has(name)) {
                const hint = name === 'style' ? ' (use fill and stroke attributes, or style="..." on each shape)' : ` (${SVG_ELEMENTS_HELP})`;
                throw new Error(`<${name}> isn't allowed in a pattern${hint}`);
            }
            if (!ignored) out.push(`<${name}${attrText(cleanAttributes(parseAttributes(attrSrc), ALLOWED_ATTRS))}${selfClose ? '/' : ''}>`);
            if (!selfClose) {
                stack.push({ name, ignored });
                if (ignored) skipDepth++;
            }
            continue;
        }
        // Text between tags: only whitespace draws nothing and is allowed.
        if (skipDepth === 0 && whole.trim()) throw new Error(`text ("${whole.trim().slice(0, 30)}") isn't allowed; ${SVG_ELEMENTS_HELP}`);
    }
    if (!root) throw new Error('must be an <svg> element');
    if (stack.length) throw new Error(`<${stack[stack.length - 1].name}> is never closed`);

    let width = px(root.get('width'));
    let height = px(root.get('height'));
    const vb = (root.get('viewBox') ?? '').trim().split(/[\s,]+/).map(Number);
    const hasViewBox = vb.length === 4 && vb.every(Number.isFinite) && vb[2] > 0 && vb[3] > 0;
    if (hasViewBox) {
        if (width && !height) height = (width * vb[3]) / vb[2];
        else if (height && !width) width = (height * vb[2]) / vb[3];
        else if (!width && !height) [width, height] = [vb[2], vb[3]];
    }
    if (!(width > 0 && height > 0)) throw new Error('needs a viewBox, or width and height in px');
    // An SVG with width/height but no viewBox is drawn in those units; give it one
    // so it scales to the tile.
    if (!hasViewBox) root.set('viewBox', `0 0 ${width} ${height}`);
    root.set('width', String(width));
    root.set('height', String(height));
    const svg = `<svg xmlns="http://www.w3.org/2000/svg"${attrText(root)}>${out.join('')}</svg>`;
    return { svg, width, height };
}

// Data URI of cleaned markup (plain ASCII, so btoa is enough).
export const svgDataUri = svg => `data:image/svg+xml;base64,${btoa(svg)}`;
