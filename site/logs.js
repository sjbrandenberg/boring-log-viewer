// The list of boring logs open on the page: each has its own JSON text, a
// display name and an optional import note. Pure functions, so they can be
// tested without a browser.

let counter = 0;
const newId = () => `log${Date.now().toString(36)}${(counter++).toString(36)}`;

export function createLog(text = '', { name = '', note = '' } = {}) {
    return { id: newId(), text, name, note };
}

// The name shown on a log's tab: its boring name when the JSON has one,
// else the name it was opened with, else "Untitled".
export function logName(log) {
    const fromJson = String(log?.text ?? '').slice(0, 20000).match(/"boring_name"\s*:\s*"((?:[^"\\]|\\.){1,60})"/);
    if (fromJson) {
        try {
            return JSON.parse(`"${fromJson[1]}"`);
        } catch {
            return fromJson[1];
        }
    }
    return log?.name || 'Untitled';
}

// Saved state: { logs: [...], active }. Accepts the old one-log format
// ({ json, options }) too.
export function restoreLogs(saved) {
    if (Array.isArray(saved?.logs) && saved.logs.length) {
        const logs = saved.logs
            .filter(l => l && typeof l.text === 'string')
            .map(l => ({ ...createLog(l.text, { name: l.name ?? '', note: l.note ?? '' }) }));
        if (logs.length) {
            const active = Math.min(Math.max(0, Number(saved.active) || 0), logs.length - 1);
            return { logs, active };
        }
    }
    if (typeof saved?.json === 'string') return { logs: [createLog(saved.json)], active: 0 };
    return null;
}

export const saveLogs = (logs, active) => ({ logs: logs.map(({ text, name, note }) => ({ text, name, note })), active });

// Adds new logs after the active one. An empty active log is replaced by the
// first new one, so opening a file on a blank page doesn't leave a blank tab.
// Returns { logs, active } with the first added log active.
export function addLogs(logs, active, added) {
    if (!added.length) return { logs, active };
    const list = [...logs];
    const current = list[active];
    if (current && !current.text.trim()) {
        list.splice(active, 1, ...added);
        return { logs: list, active };
    }
    list.splice(active + 1, 0, ...added);
    return { logs: list, active: active + 1 };
}

// Removes a log; there is always at least one (empty) log.
export function removeLog(logs, active, index) {
    const list = logs.filter((_, i) => i !== index);
    if (!list.length) return { logs: [createLog()], active: 0 };
    const next = index < active ? active - 1 : Math.min(active, list.length - 1);
    return { logs: list, active: next };
}

// Unique file names for a set of downloads: "B-1.svg", "B-1_2.svg", ...
export function uniqueNames(names) {
    const seen = new Map();
    return names.map(n => {
        const dot = n.lastIndexOf('.');
        const [base, ext] = dot > 0 ? [n.slice(0, dot), n.slice(dot)] : [n, ''];
        const count = (seen.get(n.toLowerCase()) ?? 0) + 1;
        seen.set(n.toLowerCase(), count);
        return count === 1 ? n : `${base}_${count}${ext}`;
    });
}

// A log's location for the map: { lat, lon } from metadata.latitude and
// metadata.longitude, or null when the JSON can't be read or has none.
export function logLocation(text) {
    let doc;
    try {
        doc = JSON.parse(text);
    } catch {
        return null;
    }
    const lat = doc?.metadata?.latitude;
    const lon = doc?.metadata?.longitude;
    if (typeof lat !== 'number' || typeof lon !== 'number' || !Number.isFinite(lat) || !Number.isFinite(lon)) return null;
    if (Math.abs(lat) > 90 || Math.abs(lon) > 180 || (lat === 0 && lon === 0)) return null;
    return { lat, lon };
}
