// Zine asset export: the viewer sends what the zine shows; the server streams a zip
// through a short-lived one-time-ish link so phones download it natively.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import archiver from 'archiver';
import { state, allImages, IMG_DIR, FINAL_DIR } from './store.js';
import { creditsCsv, textMd } from './export.js';

const TTL = 10 * 60 * 1000;
const jobs = new Map();
const safeName = s => String(s || '').replace(/[^a-zA-Z0-9._-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 120) || 'file';

export function createZineExport(body) {
  for (const [k, v] of jobs) if (v.exp < Date.now()) jobs.delete(k);
  const images = (Array.isArray(body.images) ? body.images : []).slice(0, 200)
    .filter(x => /^[a-z0-9-]+$/i.test(x?.id || '')).map(x => ({ id: x.id, name: safeName(x.name).replace(/(\.png)?$/i, '.png') }));
  const files = (Array.isArray(body.files) ? body.files : []).slice(0, 20)
    .filter(f => typeof f?.content === 'string' && f.content.length < 2_000_000).map(f => ({ name: safeName(f.name), content: f.content }));
  let plan = null;
  if (typeof body.plan_png === 'string' && body.plan_png.startsWith('data:image/png;base64,') && body.plan_png.length < 12_000_000) {
    plan = Buffer.from(body.plan_png.slice(22), 'base64');
  }
  const token = crypto.randomBytes(18).toString('base64url');
  jobs.set(token, { exp: Date.now() + TTL, images, files, plan });
  return { path: `/zine-export/${token}`, expires_in: TTL / 1000, images: images.length };
}

function fileFor(id) {
  for (const f of [path.join(IMG_DIR, `${id}-a3.png`), path.join(FINAL_DIR, `${id}-a3.png`), path.join(IMG_DIR, `${id}.png`), path.join(FINAL_DIR, `${id}.png`)]) if (fs.existsSync(f)) return f;
  return null;
}

export function streamZineExport(token, res) {
  const job = jobs.get(token);
  if (!job || job.exp < Date.now()) { jobs.delete(token); res.writeHead(410, { 'Content-Type': 'text/plain' }); return res.end('This export link has expired. Press Export zine zip again.'); }
  const all = allImages();
  const used = [];
  const zip = archiver('zip', { zlib: { level: 1 } });
  res.writeHead(200, { 'Content-Type': 'application/zip', 'Content-Disposition': 'attachment; filename="stochastic-by-design-zine.zip"', 'Cache-Control': 'no-store' });
  zip.pipe(res);
  const names = new Set();
  for (const im of job.images) {
    const f = fileFor(im.id); if (!f) continue;
    let n = im.name; let k = 2; while (names.has(n)) n = im.name.replace(/\.png$/, `-${k++}.png`); names.add(n);
    zip.file(f, { name: `images/${n}`, store: true });
    const rec = all.find(r => r.task_id === im.id);
    if (rec) used.push({ filename: n, artist: rec.artist, model: rec.model, endpoint: `https://openrouter.ai/api/v1${rec.endpoint || '/images'}`, prompt: rec.prompt, seed: rec.seed ?? 'not supported (full request logged)', task_id: rec.task_id, timestamp: rec.ts, draft_task_id: rec.source || rec.task_id, quality: rec.quality, cost_usd: rec.cost, request: JSON.stringify(rec.request || {}), caption: '' });
  }
  if (job.plan) zip.append(job.plan, { name: 'diagrams/studio-floor-plan.png', store: true });
  for (const f of job.files) zip.append(f.content, { name: `text/${f.name}` });
  zip.append(textMd(), { name: 'text/essay.md' });
  if (state.zine) zip.append(JSON.stringify(state.zine, null, 2), { name: 'text/flatplan.json' });
  zip.append(creditsCsv(used), { name: 'credits.csv' });
  zip.finalize();
}
