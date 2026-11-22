// Export: finals with descriptive names, text.md, credits.csv, zipped.
import fs from 'node:fs';
import path from 'node:path';
import archiver from 'archiver';
import { state, allImages, IMG_DIR, FINAL_DIR } from './store.js';
import { slugify } from './util.js';

const csvCell = v => { const s = v == null ? '' : String(v); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };

export function exportManifest() {
  const imgs = allImages();
  const picks = state.final?.picks || [];
  const rows = [];
  const items = picks.length ? picks.map(p => {
    const draft = imgs.find(i => i.task_id === p.task_id);
    const finalId = state.final?.renders?.[p.task_id];
    const fin = finalId ? imgs.find(i => i.task_id === finalId) : null;
    return { pick: p, draft, img: fin || draft, isFinal: !!fin };
  }).filter(x => x.img) : (state.shortlist || []).map(id => imgs.find(i => i.task_id === id)).filter(Boolean).map(d => ({ pick: { title: d.title, caption: '' }, draft: d, img: d, isFinal: false }));

  items.forEach((x, i) => {
    const name = `roll-${String(x.draft.round).padStart(2, '0')}-artist-${x.draft.artist.toLowerCase()}-${slugify(x.pick.title || x.draft.title)}.png`;
    x.name = rows.some(r => r.filename === name) ? name.replace('.png', `-${i + 1}.png`) : name;
    rows.push({
      filename: x.name, artist: x.draft.artist, model: x.img.model, endpoint: `https://openrouter.ai/api/v1${x.img.endpoint}`,
      prompt: x.img.prompt, seed: x.img.seed ?? 'not supported (full request logged)', task_id: x.img.task_id,
      draft_task_id: x.draft.task_id, timestamp: x.img.ts, quality: x.img.quality, cost_usd: x.img.cost,
      request: JSON.stringify(x.img.request || {}), caption: x.pick.caption || '',
    });
  });
  return { items, rows };
}

export function creditsCsv(rows) {
  const cols = ['filename', 'artist', 'model', 'endpoint', 'prompt', 'seed', 'task_id', 'timestamp', 'draft_task_id', 'quality', 'cost_usd', 'request', 'caption'];
  return [cols.join(','), ...rows.map(r => cols.map(c => csvCell(r[c])).join(','))].join('\n') + '\n';
}

export function textMd() {
  const t = state.final?.text || '_Text not written yet._';
  const caps = (state.final?.picks || []).map((p, i) => `${i + 1}. **${p.title}**. ${p.caption}`).join('\n');
  return `${t}\n\n---\n\n## Captions\n\n${caps || '_No picks yet._'}\n`;
}

export function streamZip(res) {
  const { items, rows } = exportManifest();
  const zip = archiver('zip', { zlib: { level: 6 } });
  res.writeHead(200, { 'Content-Type': 'application/zip', 'Content-Disposition': 'attachment; filename="stochastic-by-design.zip"' });
  zip.pipe(res);
  for (const x of items) {
    const dir = x.isFinal ? FINAL_DIR : IMG_DIR;
    const a3 = path.join(dir, x.img.file.replace(/\.png$/, '-a3.png'));
    const file = fs.existsSync(a3) ? a3 : path.join(dir, x.img.file);
    if (fs.existsSync(file)) zip.file(file, { name: `images/${x.name}` });
  }
  zip.append(textMd(), { name: 'text.md' });
  zip.append(creditsCsv(rows), { name: 'credits.csv' });
  if (state.zine) zip.append(JSON.stringify(state.zine, null, 2), { name: 'zine-flatplan.json' });
  zip.finalize();
}
