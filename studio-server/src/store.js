// Persistent storage on the Railway volume: append-only JSONL log, cost ledger,
// image index, and small JSON state files. Originals are never overwritten.
import fs from 'node:fs';
import path from 'node:path';

export const DATA_DIR = process.env.DATA_DIR || '/data';
export const IMG_DIR = path.join(DATA_DIR, 'images');
export const THUMB_DIR = path.join(DATA_DIR, 'thumbs');
export const FINAL_DIR = path.join(DATA_DIR, 'finals');
export const EXPORT_DIR = path.join(DATA_DIR, 'export');
const LOG = path.join(DATA_DIR, 'log.jsonl');
const LEDGER = path.join(DATA_DIR, 'ledger.jsonl');
const IMAGES = path.join(DATA_DIR, 'images.jsonl');
const STATE = path.join(DATA_DIR, 'state.json');
const RUNTIME = path.join(DATA_DIR, 'runtime.json');

for (const d of [DATA_DIR, IMG_DIR, THUMB_DIR, FINAL_DIR, EXPORT_DIR]) fs.mkdirSync(d, { recursive: true });

function readJsonl(file) {
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map(l => {
    try { return JSON.parse(l); } catch { return null; }
  }).filter(Boolean);
}
const append = (file, obj) => fs.appendFileSync(file, JSON.stringify(obj) + '\n');

// ---- Log (append-only) ----
const logCache = readJsonl(LOG);
let seq = logCache.length ? (logCache[logCache.length - 1].seq || logCache.length) : 0;
export function log(agent, type, fields = {}) {
  const ev = {
    seq: ++seq, ts: new Date().toISOString(), agent, type,
    round: fields.round ?? null, prompt: fields.prompt ?? null, response: fields.response ?? null,
    model: fields.model ?? null, endpoint: fields.endpoint ?? null, task_id: fields.task_id ?? null,
    cost: fields.cost ?? null, file: fields.file ?? null, data: fields.data ?? null,
  };
  append(LOG, ev);
  logCache.push(ev);
  const msg = typeof ev.data?.message === 'string' ? ev.data.message : '';
  console.log(`[log] ${agent} ${type} ${ev.task_id || ''} ${ev.cost != null ? '$' + ev.cost : ''} ${msg}`.slice(0, 300));
  return ev;
}
export const events = () => logCache;

// ---- Cost ledger ----
const ledger = readJsonl(LEDGER);
export function addCost(entry) { const e = { ts: new Date().toISOString(), ...entry }; append(LEDGER, e); ledger.push(e); }
export const ledgerEntries = () => ledger;
export const ledgerTotal = () => ledger.reduce((s, e) => s + (Number(e.cost) || 0), 0);

// ---- Image index ----
const images = readJsonl(IMAGES);
export function addImage(rec) { append(IMAGES, rec); images.push(rec); }
export const allImages = () => images;

// ---- JSON state ----
function readJson(file, dflt) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return dflt; }
}
function writeJson(file, obj) {
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2));
  fs.renameSync(tmp, file);
}
export const state = readJson(STATE, {});
export function saveState() { writeJson(STATE, state); }
export const runtime = readJson(RUNTIME, {});
export function saveRuntime() { writeJson(RUNTIME, runtime); }
