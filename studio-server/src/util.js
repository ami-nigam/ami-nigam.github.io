// Time helpers (UK), ids, small utilities.
import crypto from 'node:crypto';

export const TZ = 'Europe/London';

export function ukParts(d = new Date()) {
  const f = new Intl.DateTimeFormat('en-GB', {
    timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
  });
  const p = Object.fromEntries(f.formatToParts(d).map(x => [x.type, x.value]));
  return { date: `${p.year}-${p.month}-${p.day}`, hh: +p.hour, mm: +p.minute, ss: +p.second };
}

export const hhmmToMin = s => { const [h, m] = String(s).split(':').map(Number); return h * 60 + m; };
export const minToHhmm = m => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
export function ukMinutes(d = new Date()) { const p = ukParts(d); return p.hh * 60 + p.mm; }

export const shortId = (n = 6) => crypto.randomBytes(8).toString('hex').slice(0, n);
export const sleep = ms => new Promise(r => setTimeout(r, ms));
export const slugify = s => String(s || 'untitled').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48) || 'untitled';
export const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
export const round4 = n => Math.round((Number(n) || 0) * 10000) / 10000;

// Remove em/en dashes from text written in Ami's voice.
export function noDashes(s) {
  return String(s || '')
    .replace(/\s*—\s*/g, ', ')
    .replace(/\s–\s/g, ' - ')
    .replace(/–/g, '-')
    .replace(/,\s*,/g, ',');
}

// Pull a JSON object out of a model reply (tolerates code fences / prose).
export function parseJsonReply(text) {
  if (!text) throw new Error('empty reply');
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const body = fenced ? fenced[1] : text;
  const start = body.indexOf('{'); const end = body.lastIndexOf('}');
  if (start < 0 || end < start) throw new Error('no JSON object in reply');
  return JSON.parse(body.slice(start, end + 1));
}

function versionKey(id) { return (String(id).match(/\d+(?:\.\d+)?/g) || []).map(Number); }
export function cmpVersion(a, b) {
  const x = versionKey(a), y = versionKey(b);
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    const d = (x[i] ?? -1) - (y[i] ?? -1);
    if (d) return d;
  }
  return 0;
}
