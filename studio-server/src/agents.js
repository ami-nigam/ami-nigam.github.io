// Agents: Curator, Artists, Engineer.
import fs from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';
import { studio, voiceSamples, runtime, ENGINEER_EDITABLE, CEILING, PRICE } from './config.js';
import { state, saveState, saveRuntime, log, addImage, allImages, events, ledgerEntries, IMG_DIR, THUMB_DIR, FINAL_DIR } from './store.js';
import { chat, generateImage, spend, getKey, StopError, isStopped } from './openrouter.js';
import { parseJsonReply, slugify, shortId, clamp, noDashes, round4, ukMinutes, hhmmToMin } from './util.js';

export const persona = a => studio.personas[a.persona];

// ---------- Image files ----------
async function saveImage(buf, taskId, dir = IMG_DIR) {
  const file = path.join(dir, `${taskId}.png`);
  if (fs.existsSync(file)) throw new Error(`refusing to overwrite ${file}`);
  // Normalise to PNG; keep full resolution.
  let out = buf;
  try { out = await sharp(buf).png().toBuffer(); } catch { /* keep original bytes */ }
  fs.writeFileSync(file, out, { flag: 'wx' });
  // A3 landscape trim (sqrt 2 : 1), centred. Original stays untouched; the trim is a separate file.
  let view = out;
  try {
    const m = await sharp(out).metadata(); const R = Math.SQRT2;
    let w = m.width, h = m.height;
    if (w / h > R) w = Math.round(h * R); else h = Math.round(w / R);
    const left = Math.floor((m.width - w) / 2), top = Math.floor((m.height - h) / 2);
    if (w !== m.width || h !== m.height) {
      view = await sharp(out).extract({ left, top, width: w, height: h }).png().toBuffer();
      fs.writeFileSync(path.join(dir, `${taskId}-a3.png`), view, { flag: 'wx' });
    }
  } catch { /* keep untrimmed */ }
  try { await sharp(view).resize({ width: 640, withoutEnlargement: true }).jpeg({ quality: 78 }).toFile(path.join(THUMB_DIR, `${taskId}.jpg`)); } catch { /* thumb optional */ }
  return file;
}
async function asDataUrl(taskId, width = 512) {
  const thumb = path.join(THUMB_DIR, `${taskId}.jpg`);
  try {
    const src = fs.existsSync(thumb) ? thumb : path.join(IMG_DIR, `${taskId}.png`);
    const b = await sharp(src).resize({ width, withoutEnlargement: true }).jpeg({ quality: 70 }).toBuffer();
    return `data:image/jpeg;base64,${b.toString('base64')}`;
  } catch { return null; }
}
export async function imageParts(recs, width) {
  const parts = [];
  for (const r of recs) {
    const url = await asDataUrl(r.task_id, width);
    if (!url) continue;
    parts.push({ type: 'text', text: `[${r.task_id}] round ${r.round}, ${r.artist}: "${r.title}"` });
    parts.push({ type: 'image_url', image_url: { url } });
  }
  return parts;
}

// ---------- Prompts ----------
export function amiVoiceBlock() {
  return [
    `About Ami: ${studio.ami.bio}`,
    `His position on this piece: ${studio.ami.position}`,
    `Writing style: ${studio.ami.style}`,
    'Do not invent his opinions. Where his stance is unclear for a decision, say so in the "stance_unclear" field instead of guessing.',
    `Samples of his real writing (tone only):\n${voiceSamples}`,
  ].join('\n\n');
}

export function artistSystem(a) {
  const p = persona(a);
  const who = p.name ? `Your name is ${p.name}. Personality: ${p.personality}\n\n` : '';
  return who + artistSystemBase(a, p);
}
function artistSystemBase(a, p) {
  if (a.persona === 'control') return p.system;
  if (p.bias) return `You are an image-making agent with a strong point of view. ${p.bias}\n\nYou make two-page zine spreads that argue your side. You are not neutral and you do not hedge.`;
  return [
    `You are an image-making agent carrying Ami Nigam's editorial voice. The work is published under his name.`,
    `Your emphasis: ${p.emphasis}`,
    amiVoiceBlock(),
    'Each wake you look at the images you have already made, decide what to make next, write a prompt for an image model, and note one line of reflection.',
  ].join('\n\n');
}

export function currentBrief() {
  return studio.brief_override || state.brief || '';
}

// ---------- Curator ----------
export async function curatorWriteBrief(round) {
  const version = studio.brief_version || 1;
  if (studio.brief_override) return studio.brief_override;
  if (state.brief && state.briefVersion === version) return state.brief;
  if (state.brief) { state.briefHistory = [...(state.briefHistory || []), { version: state.briefVersion || 1, brief: state.brief, replaced: new Date().toISOString() }]; }
  const system = `You are the Curator of an AI art studio producing a submission for ${studio.publication}, working title "${studio.title}". You write in Ami Nigam's voice.\n\n${amiVoiceBlock()}`;
  const user = `Write the shared brief that ${studio.artists.length} AI artists will all receive, unchanged, for the whole day. Editorial stance (${studio.stance_status}): "${studio.stance}".
The brief must:
- pose this question to every artist, in plain words: "${studio.question}";
- ask each artist to argue its own answer: yes, no, or something more precise, and to build that argument across a series of spreads;
- leave subject matter completely open: each artist chooses whatever subjects serve its argument. Do NOT set a shared subject;
- rule out cliches: no robots, circuits, glowing brains, code rain, glitch art, dice, or patterns turning into paintings;
- ask for two-page zine spreads, A3 landscape, where image and short text work together: headline, a line of body text, labels or captions where they help;
- not mention the other artists or the study design.
120 to 200 words. No em-dashes. Return only the brief text.`;
  log('curator', 'brief.request', { round, prompt: user, model: runtime.sonnetModel, endpoint: '/chat/completions' });
  const r = await chat({ model: runtime.sonnetModel, system, messages: [{ role: 'user', content: user }], agent: 'curator', round, estimate: 0.05, maxTokens: 600 });
  state.brief = noDashes(r.text.trim()); state.briefVersion = version; saveState();
  log('curator', 'brief.result', { round, response: state.brief, model: r.model, endpoint: '/chat/completions', task_id: r.id, cost: r.cost });
  return state.brief;
}

function roundCosts() {
  const by = {};
  for (const e of ledgerEntries()) { if (e.round == null) continue; by[e.round] = round4((by[e.round] || 0) + (Number(e.cost) || 0)); }
  return by;
}

export function scheduleInfo() {
  const sch = studio.schedule;
  const now = ukMinutes();
  const last = hhmmToMin(sch.last_artist_wake);
  const wakesLeft = Math.max(0, Math.floor((last - now) / sch.interval_min) + 1);
  return { now_min: now, wakes_left: wakesLeft, minutes_to_final: hhmmToMin(sch.final) - now };
}

export function limits() {
  if (!state.limits) { state.limits = { ...studio.limits_default }; saveState(); }
  return state.limits;
}

// Curator sets the next round's limits from live spend. Code clamps everything to the ceiling.
export async function curatorBudget(round) {
  let key = null; try { key = await getKey(true); } catch (e) { log('curator', 'budget.key_error', { round, data: { message: e.message } }); }
  const s = spend(); const sch = scheduleInfo(); const cur = limits();
  const costs = roundCosts();
  const draftsSoFar = Object.fromEntries(studio.artists.map(a => [a.id, allImages().filter(i => i.artist === a.id && i.kind === 'draft').length]));
  const debateReserve = state.debate?.status === 'done' ? 0 : 1.5;
  const finalReserve = (cur.finals_count || 10) * (PRICE[cur.final_quality] || 0.128) * 1.25 + 0.6 + debateReserve; // finals + final text + debate
  const facts = {
    ceiling: CEILING, spend: s, key: key ? { usage: key.usage, limit: key.limit, limit_remaining: key.limit_remaining } : null,
    wakes_left_including_this: sch.wakes_left, minutes_to_final: sch.minutes_to_final,
    cost_by_round: costs, drafts_so_far: draftsSoFar, current_limits: cur,
    draft_price: PRICE[runtime.draftQuality] || PRICE.low, draft_quality: runtime.draftQuality, final_reserve_needed: round4(finalReserve), suggested_split: studio.budget_split,
  };
  const system = 'You are the Curator of an AI art studio, managing a hard budget in real time. Be conservative. You may tighten or loosen limits only within the ceiling. You cannot raise the ceiling.';
  const user = `Live numbers:\n${JSON.stringify(facts, null, 2)}\n\nArtists are building narrative series of ${studio.arc_spreads || 6} spreads (and may add more); the zine needs their full series, so more spreads are valuable. Keep at least 1 image per artist per wake unless the budget cannot cover the final reserve. Set limits for the next round. Each artist (${studio.artists.length}) makes up to images_per_wake images (0 to 3) at draft quality, each wake also costs about two Claude calls per artist. Keep enough for final_reserve_needed. Return JSON only: {"images_per_wake":int,"draft_cap_per_artist":int,"final_quality":"high"|"xhigh","skip_round":bool,"reasoning":"one or two sentences"}`;
  log('curator', 'budget.request', { round, prompt: user, model: runtime.sonnetModel, endpoint: '/chat/completions' });
  let d;
  try {
    const r = await chat({ model: runtime.sonnetModel, system, messages: [{ role: 'user', content: user }], agent: 'curator', round, estimate: 0.03, maxTokens: 300 });
    d = parseJsonReply(r.text);
    log('curator', 'budget.result', { round, response: r.text, model: r.model, endpoint: '/chat/completions', task_id: r.id, cost: r.cost });
  } catch (e) {
    if (e instanceof StopError) throw e;
    log('curator', 'budget.error', { round, data: { message: e.message } });
    d = { ...cur, skip_round: false, reasoning: 'budget call failed; keeping previous limits' };
  }
  // Hard clamps in code.
  const next = {
    images_per_wake: clamp(parseInt(d.images_per_wake ?? cur.images_per_wake, 10) || 0, 1, 3),
    draft_cap_per_artist: clamp(parseInt(d.draft_cap_per_artist ?? cur.draft_cap_per_artist, 10) || 0, (studio.arc_spreads || 6) + 4, 60),
    final_quality: ['high', 'xhigh'].includes(d.final_quality) ? d.final_quality : 'high',
    finals_count: cur.finals_count || 10,
    skip_round: false, // only the reserve clamp below may skip a round
  };
  // Never plan a round that would eat the finals reserve.
  const draftPrice = PRICE[runtime.draftQuality] || PRICE.low;
  const nA = studio.artists.length;
  const roundEst = nA * (next.images_per_wake * draftPrice * 1.1 + 0.06);
  if (s.remaining - roundEst < finalReserve) {
    next.images_per_wake = Math.max(0, Math.floor(((s.remaining - finalReserve) / nA - 0.06) / (draftPrice * 1.1)));
    next.images_per_wake = clamp(next.images_per_wake, 0, 3);
    if (next.images_per_wake === 0) next.skip_round = true;
    d.reasoning = `${d.reasoning || ''} [code clamp: protecting finals reserve $${round4(finalReserve)}]`;
  }
  state.limits = next; state.limitsReason = d.reasoning; saveState();
  log('curator', 'budget.set', { round, data: { message: d.reasoning, limits: next, spend: s } });
  return next;
}

export async function curatorCheckpoint(round, label = 'checkpoint') {
  const imgs = allImages().filter(i => i.kind === 'draft');
  const recent = [];
  for (const a of studio.artists) {
    const mine = imgs.filter(i => i.artist === a.id);
    const favs = new Set(state.favourites?.[a.id] || []);
    const pickd = [...mine.filter(i => favs.has(i.task_id)).slice(-2), ...mine.slice(-2)];
    for (const p of pickd) if (!recent.find(x => x.task_id === p.task_id)) recent.push(p);
  }
  const review = recent.slice(-runtime.curatorReviewImages);
  const s = spend();
  const reflections = events().filter(e => e.type === 'artist.reflection').slice(-15).map(e => `${e.agent} r${e.round}: ${e.response}`).join('\n');
  const system = `You are the Curator. You see all artists' work; they cannot see each other. Each artist has a point of view: ${studio.artists.map(x => `${x.id} ${persona(x).name || ''} = ${persona(x).label}, ${persona(x).personality || ''}`).join('; ')}. ${studio.artists.filter(x => x.group === 'persona').map(x => x.id).join(' and ')} carries Ami's voice.  You do not make images. Write in Ami's voice: plain, short, no hype, no em-dashes.\n\n${amiVoiceBlock()}`;
  const user = [
    { type: 'text', text: `Brief:\n${currentBrief()}\n\nSpend: $${s.spent} of $${CEILING}. Current shortlist: ${JSON.stringify(state.shortlist || [])}.\nRecent artist reflections:\n${reflections}\n\nEach artist argues one point (thesis) across zine spreads. Theses: ${JSON.stringify(state.thesis || {})}.
Current directions: ${JSON.stringify(state.directions || {})}.
Review the spreads below, then direct the artists. You may push them in the same direction or in different directions.
Rules for directions: one note per artist about its own work and argument. Never describe or mention another artist's work. You may push them in the same direction or apart (e.g. sharpen the disagreement). One to three sentences each, plain words, no em-dashes.
Return JSON only: {"notes":"4 to 8 sentences: what is working, where the points of view clash or agree, whether each argument reads","shortlist":["task ids worth considering for the final 8 to 10, max 16, keep good earlier picks"],"directions":{"mode":"same or different",${studio.artists.map(x => `"${x.id}":"..."`).join(',')}},"stance_unclear":"optional"}` },
    ...(await imageParts(review, 384)),
  ];
  log('curator', `${label}.request`, { round, prompt: user[0].text, model: runtime.sonnetModel, endpoint: '/chat/completions', data: { images: review.map(r => r.task_id) } });
  const r = await chat({ model: runtime.sonnetModel, system, messages: [{ role: 'user', content: user }], agent: 'curator', round, estimate: 0.12, maxTokens: 3000 });
  const d = parseJsonReply(r.text);
  const known = new Set(imgs.map(i => i.task_id));
  state.shortlist = (d.shortlist || []).filter(id => known.has(id)).slice(0, 16);
  state.curatorNotes = [...(state.curatorNotes || []), { ts: new Date().toISOString(), round, label, notes: noDashes(d.notes), stance_unclear: d.stance_unclear || null, directions: d.directions || null }];
  if (d.directions && label === 'checkpoint') {
    const dir = d.directions; const ts = new Date().toISOString();
    state.directions = { mode: dir.mode || null, round, ts };
    for (const x of studio.artists) state.directions[x.id] = noDashes(dir[x.id] || dir.controls || '');
    log('curator', 'direction', { round, response: JSON.stringify(state.directions), data: { message: `${dir.mode || ''} directions sent to ${studio.artists.length} artists`, directions: state.directions } });
  }
  saveState();
  log('curator', `${label}.result`, { round, response: r.text, model: r.model, endpoint: '/chat/completions', task_id: r.id, cost: r.cost, data: { shortlist: state.shortlist } });
  return d;
}

// Final: select 8 to 10, captions, re-render at high/xhigh, write 1,500 words.
export async function curatorFinal(round) {
  state.final = state.final || { status: 'running', picks: [], renders: {} };
  state.final.status = 'running'; saveState();
  const L = limits();
  const imgs = allImages().filter(i => i.kind === 'draft');
  if (!state.final.picks?.length) {
    const pool = [...new Set([...(state.shortlist || []), ...Object.values(state.favourites || {}).flat()])]
      .map(id => imgs.find(i => i.task_id === id)).filter(Boolean);
    const extra = imgs.filter(i => !pool.includes(i)).slice(-Math.max(0, 30 - pool.length));
    const candidates = [...pool, ...extra].slice(0, 30);
    const system = `You are the Curator making the final selection for ${studio.publication}, "${studio.title}". Stance (${studio.stance_status}): "${studio.stance}".\n\n${amiVoiceBlock()}`;
    const user = [
      { type: 'text', text: `Select ${L.finals_count >= 10 ? '8 to 10' : '8'} zine spreads for print, the ones whose argument reads most clearly, from the candidates below. Include each artist's strongest argument where possible, so the points of view can be compared. Return JSON only: {"picks":[{"task_id":"...","title":"short descriptive title, 2 to 5 words","caption":"one or two plain sentences in Ami's voice, no em-dashes"}],"rationale":"3 sentences"}` },
      ...(await imageParts(candidates, 384)),
    ];
    log('curator', 'final.select.request', { round, prompt: user[0].text, model: runtime.sonnetModel, endpoint: '/chat/completions', data: { candidates: candidates.map(c => c.task_id) } });
    const r = await chat({ model: runtime.sonnetModel, system, messages: [{ role: 'user', content: user }], agent: 'curator', round, estimate: 0.2, maxTokens: 1500 });
    const d = parseJsonReply(r.text);
    const picks = (d.picks || []).filter(p => imgs.find(i => i.task_id === p.task_id)).slice(0, 10);
    state.final.picks = picks.map(p => ({ ...p, caption: noDashes(p.caption), title: noDashes(p.title) }));
    state.final.rationale = noDashes(d.rationale || '');
    saveState();
    log('curator', 'final.select.result', { round, response: r.text, model: r.model, endpoint: '/chat/completions', task_id: r.id, cost: r.cost, data: { picks: state.final.picks.map(p => p.task_id) } });
  }
  // Re-render each pick at final quality with the identical prompt.
  for (const p of state.final.picks) {
    if (state.final.renders[p.task_id]) continue;
    const src = imgs.find(i => i.task_id === p.task_id);
    const taskId = `final-${p.task_id}-${shortId(4)}`;
    log('curator', 'final.render.request', { round, prompt: src.prompt, model: runtime.imageModel, endpoint: '/images', task_id: taskId, data: { quality: L.final_quality, source: p.task_id } });
    try {
      const g = await generateImage({ prompt: src.prompt, quality: L.final_quality, agent: 'curator', round });
      const file = await saveImage(g.buf, taskId, FINAL_DIR);
      const rec = { task_id: taskId, kind: 'final', source: p.task_id, artist: src.artist, round: src.round, title: p.title, prompt: src.prompt, quality: L.final_quality, model: runtime.imageModel, endpoint: '/images', request: g.request, seed: g.seed, cost: g.cost, ts: new Date().toISOString(), file: path.basename(file), openrouter_id: g.id };
      addImage(rec);
      state.final.renders[p.task_id] = taskId; saveState();
      log('curator', 'final.render.result', { round, prompt: src.prompt, model: runtime.imageModel, endpoint: '/images', task_id: taskId, cost: g.cost, file: rec.file, data: { request: g.request } });
    } catch (e) {
      log('curator', 'final.render.error', { round, task_id: taskId, data: { message: e.message } });
      if (e instanceof StopError) throw e;
    }
  }
  if (!state.final.text) await curatorWriteText(round);
  state.final.status = 'done'; saveState();
  log('curator', 'final.done', { round, data: { message: `${Object.keys(state.final.renders).length} finals rendered` } });
}

export async function curatorWriteText(round) {
  const imgs = allImages();
  const picks = (state.final?.picks || []).map(p => { const s = imgs.find(i => i.task_id === p.task_id); return { ...p, artist: s?.artist, round: s?.round, prompt: s?.prompt }; });
  const notes = (state.curatorNotes || []).map(n => `- ${n.label} r${n.round}: ${n.notes}`).join('\n');
  const reflections = events().filter(e => e.type === 'artist.reflection').map(e => `${e.agent} r${e.round}: ${e.response}`).slice(-40).join('\n');
  const totalImages = imgs.filter(i => i.kind === 'draft').length;
  const system = `You write as Ami Nigam, for publication under his name.\n\n${amiVoiceBlock()}`;
  const user = `Write about 1,500 words for ${studio.publication}, working title "${studio.title}". Markdown, with a title and a few section headings.
Stance (${studio.stance_status}): "${studio.stance}"
Core position: ${studio.ami.position}
What happened: AI artists worked from one brief through one day, waking every 30 minutes. There were ${studio.artists.length} artists, each given a bias. First they researched their side and committed to one point; then each built a series of zine spreads as a narrative arc. They could not see each other's work except once, in a debate: ${studio.artists.map(x => `${persona(x).name || x.id} (${x.id}, ${persona(x).label}): ${state.thesis?.[x.id]?.text || ''}`).join('; ')}. ${studio.artists.filter(x => x.group === 'persona').map(x => persona(x).name || x.id).join(' and ')} carried my voice. The Curator directed each artist at checkpoints. ${totalImages} drafts were made; the Curator chose ${picks.length}.
Brief:\n${currentBrief()}
Curator notes through the day:\n${notes}\nMidway through the day the artists met once, in a debate (the only time they saw each other). Their takeaways: ${JSON.stringify(state.debate?.takeaways || {})}\nCurator's closing words: ${(state.debate?.turns || []).filter(t => t.speaker === 'curator').slice(-1)[0]?.text || '(no debate held)'}
Artist reflections (sample):\n${reflections}
Selected images:\n${picks.map(p => `- ${p.title} (${p.artist}, round ${p.round}): ${p.caption}`).join('\n')}
Rules: plain words, short sentences, grounded in what actually happened above. No hype, no flattery. Never use em-dashes or en-dashes. Do not claim randomness equals creativity. Do not invent opinions or anecdotes I have not stated; where my stance is unclear, write [AMI: ...] as a placeholder for me to fill.`;
  log('curator', 'text.request', { round, prompt: user, model: runtime.sonnetModel, endpoint: '/chat/completions' });
  const r = await chat({ model: runtime.sonnetModel, system, messages: [{ role: 'user', content: user }], agent: 'curator', round, estimate: 0.25, maxTokens: 3500 });
  state.final = state.final || {}; state.final.text = noDashes(r.text.trim()); saveState();
  log('curator', 'text.result', { round, response: state.final.text, model: r.model, endpoint: '/chat/completions', task_id: r.id, cost: r.cost, data: { words: state.final.text.split(/\s+/).length } });
}

// ---------- Artist research (once per brief version) ----------
async function artistResearch(a, round, bv) {
  state.research = state.research || {};
  if (state.research[a.id]?.brief_version === bv) return state.research[a.id];
  const p = persona(a);
  const system = artistSystem(a);
  const fixed = p.point ? `Your side is already set: "${p.point}". Research to support and sharpen it.` : 'Research to find your side, then commit to it.';
  const user = `Before making anything, research this question from your point of view:\n"${studio.question || studio.ami.position}"\n\nBrief you will work from:\n${currentBrief()}\n\n${fixed}\nFind 3 to 5 concrete references that support your side (artists, works, studies, events, numbers) and 1 that challenges it. Be accurate; do not invent sources.\nReturn JSON only: {"findings":["one line each, with who/what/when"],"counter":"the strongest point against you, one line","thesis":"ONE sentence: the strong point you will argue in every spread today"}`;
  log(a.id, 'artist.research.request', { round, prompt: user, model: runtime.sonnetModel, endpoint: '/chat/completions', data: { web: true } });
  let r;
  try {
    r = await chat({ model: runtime.sonnetModel, system, messages: [{ role: 'user', content: user }], agent: a.id, round, estimate: 0.08, maxTokens: 2500, plugins: [{ id: 'web', max_results: 5 }] });
  } catch (e) {
    if (e instanceof StopError) throw e;
    log(a.id, 'artist.research.web_error', { round, data: { message: `web search failed, using model knowledge: ${e.message}` } });
    r = await chat({ model: runtime.sonnetModel, system, messages: [{ role: 'user', content: user }], agent: a.id, round, estimate: 0.05, maxTokens: 2500 });
  }
  const d = parseJsonReply(r.text);
  const sources = (r.annotations || []).filter(x => x.type === 'url_citation').map(x => ({ title: x.url_citation?.title || '', url: x.url_citation?.url || '' })).slice(0, 8);
  const clean = t => (a.persona === 'ami' || a.persona === 'p2') ? noDashes(t) : String(t || '');
  state.research[a.id] = { brief_version: bv, round, findings: (d.findings || []).map(clean).slice(0, 6), counter: clean(d.counter), thesis: clean(d.thesis), sources };
  state.thesis = state.thesis || {};
  if (p.point) state.thesis[a.id] = { text: p.point, sharpened: clean(d.thesis), round, brief_version: bv };
  else if (d.thesis) state.thesis[a.id] = { text: clean(d.thesis), round, brief_version: bv };
  saveState();
  log(a.id, 'artist.research', { round, response: r.text, model: r.model, endpoint: '/chat/completions', task_id: r.id, cost: r.cost, data: { message: state.research[a.id].thesis, findings: state.research[a.id].findings, counter: state.research[a.id].counter, sources } });
  if (state.thesis[a.id]?.round === round) log(a.id, 'artist.thesis', { round, response: state.thesis[a.id].text, data: { message: state.thesis[a.id].text } });
  return state.research[a.id];
}

// ---------- Narrative arc (after research, once per brief version) ----------
async function artistArc(a, round, bv, research) {
  state.arc = state.arc || {};
  if (state.arc[a.id]?.brief_version === bv) return state.arc[a.id];
  const n = studio.arc_spreads || 6;
  const user = `Brief:\n${currentBrief()}\n\nYour point: "${state.thesis?.[a.id]?.text || ''}"\nYour research:\n${(research?.findings || []).map(f => '- ' + f).join('\n')}\nAgainst you: ${research?.counter || ''}\n\nPlan a narrative: a series of ${n} two-page zine spreads that together build your argument, from opening to conclusion. Each beat is one spread. Make it a real sequence: set up, develop, turn, land.\nReturn JSON only: {"series_title":"2 to 6 words","beats":["one line per spread: what it shows and what it argues"]}`;
  log(a.id, 'artist.arc.request', { round, prompt: user, model: runtime.sonnetModel, endpoint: '/chat/completions' });
  const r = await chat({ model: runtime.sonnetModel, system: artistSystem(a), messages: [{ role: 'user', content: user }], agent: a.id, round, estimate: 0.04, maxTokens: 2000 });
  const d = parseJsonReply(r.text);
  const clean = t => (a.persona === 'ami' || a.persona === 'p2') ? noDashes(t) : String(t || '');
  state.arc[a.id] = { brief_version: bv, round, series_title: clean(d.series_title), beats: (d.beats || []).map(clean).slice(0, 10) };
  saveState();
  log(a.id, 'artist.arc', { round, response: r.text, model: r.model, endpoint: '/chat/completions', task_id: r.id, cost: r.cost, data: { message: `"${state.arc[a.id].series_title}", ${state.arc[a.id].beats.length} spreads`, arc: state.arc[a.id] } });
  return state.arc[a.id];
}

// ---------- Artist wake ----------
export async function artistWake(a, round, lim) {
  const mine = allImages().filter(i => i.artist === a.id && i.kind === 'draft');
  const cap = lim.draft_cap_per_artist;
  const doneThisWake = mine.filter(i => i.round === round).length; // engineer retries do not add extra images
  const n = Math.min(lim.images_per_wake - doneThisWake, Math.max(0, cap - mine.length), 3);
  if (n <= 0) { log(a.id, 'artist.skip', { round, data: { message: `no images allowed (made ${mine.length}, cap ${cap}, per wake ${lim.images_per_wake})` } }); return; }
  const bv = state.briefVersion || 1;
  const cur = mine.filter(i => (i.brief_version || 1) === bv);
  state.thesis = state.thesis || {};
  if (state.thesis[a.id] && state.thesis[a.id].brief_version !== bv) delete state.thesis[a.id];
  const thesis = persona(a).point || '';
  const direction = state.directions?.[a.id] || '';
  const takeaway = state.debate?.status === 'done' ? (state.debate.takeaways?.[a.id] || '') : '';
  let research = null;
  if (persona(a).bias || persona(a).point) research = await artistResearch(a, round, bv);
  const arc = await artistArc(a, round, bv, research);
  const beatNo = cur.length + 1;
  const history = events().filter(e => e.agent === a.id && ['artist.plan', 'artist.reflection'].includes(e.type) && (e.data?.brief_version || 1) === bv).slice(-12)
    .map(e => e.type === 'artist.plan' ? `r${e.round} plan: ${e.data?.intent || ''}` : `r${e.round} reflection: ${e.response}`).join('\n');
  const favs = new Set(state.favourites?.[a.id] || []);
  const shown = [...cur.filter(i => favs.has(i.task_id)).slice(-2), ...cur.slice(-runtime.artistHistoryImages)]
    .filter((v, i, arr) => arr.findIndex(x => x.task_id === v.task_id) === i).slice(-runtime.artistHistoryImages);
  const system = artistSystem(a);
  const fmt = `Format: each image is ONE two-page zine spread, A3 landscape (two A4 pages side by side, gutter in the middle). The left and right edges (outer 5% each side) will be trimmed, so keep all text and key content well inside them. Design the whole spread: imagery, layout and the words on it. Use text where it carries your point: a headline, a short line of body text, labels or captions. At most 30 words of text on a spread. In the prompt, put every word that must appear in double quotes, spelled exactly, and say where it sits. The spread must make your point, not just show the subject.`;
  const thesisLine = state.thesis[a.id]?.text
    ? `Your argument (keep arguing it): "${state.thesis[a.id].text}"`
    : thesis ? `Your point to argue across every spread today: "${thesis}". Restate it in your own words as "thesis".`
    : `You have not chosen your point yet. From the brief, decide ONE strong point you will argue across every spread today, in one sentence, and return it as "thesis".`;
  const researchLine = research ? `\nYour research:\n${research.findings.map(f => '- ' + f).join('\n')}\nStrongest point against you: ${research.counter}\nUse your research: name real references on the spread where they help.\n` : '';
  const arcLine = `\nYour series: "${arc.series_title}"\n${arc.beats.map((b, i) => `${i + 1}. ${b}${i + 1 < beatNo ? ' (made)' : i + 1 === beatNo ? '  <- next' : ''}`).join('\n')}\n${beatNo > arc.beats.length ? 'Your planned series is complete. Make an extra spread that sharpens, tests or answers your argument; you may extend the arc with new beats.' : `Make the next beat${n > 1 ? 's in order' : ''}.`} If what you have made so far changes the story, you may revise the remaining beats: return them as "arc" (full list).\n`;
  const text = `Brief:\n${currentBrief()}\n\n${fmt}\n\n${thesisLine}\n${researchLine}${arcLine}${direction ? `\nDirection from the Curator: ${direction}\n` : ''}${takeaway ? `\nAfter the debate you said you would: ${takeaway}\n` : ''}\nThis is wake ${round}. You may make ${n} spread${n > 1 ? 's' : ''} this wake. Each spread should advance your point; together they should read as a sequence.\nYour notes so far:\n${history || '(none, this is your first wake)'}\n\nYour previous images${shown.length ? ' are below' : ': none yet'}. Look at them, select the ones you want to keep building on, then decide what to make next. Do not repeat a composition you have already made unless you are deliberately developing a kept image.\n\nReturn JSON only:\n{"thesis":"your one-sentence point","arc":["optional: revised full list of beats"],"review":"one sentence on your previous spreads","keep":["task ids you select from your own images"],"intent":"one sentence: what this spread argues and why","images":[{"title":"2 to 5 word descriptive title","prompt":"full prompt for the image model"}]${a.persona !== 'control' ? ',"stance_unclear":"optional: where Ami\'s stance is unclear for this decision"' : ''}}\nGive exactly ${n} item${n > 1 ? 's' : ''} in "images".`;
  const content = [{ type: 'text', text }, ...(await imageParts(shown, 512))];
  log(a.id, 'artist.plan.request', { round, prompt: text, model: runtime.sonnetModel, endpoint: '/chat/completions', data: { shown: shown.map(s => s.task_id) } });
  const r = await chat({ model: runtime.sonnetModel, system, messages: [{ role: 'user', content }], agent: a.id, round, estimate: 0.06, maxTokens: 2500 });
  const d = parseJsonReply(r.text);
  const known = new Set(mine.map(m => m.task_id));
  state.favourites = state.favourites || {};
  state.favourites[a.id] = [...new Set([...(state.favourites[a.id] || []), ...(d.keep || []).filter(k => known.has(k))])].slice(-8);
  if (Array.isArray(d.arc) && d.arc.length >= cur.length + 1) {
    const clean = t => (a.persona === 'ami' || a.persona === 'p2') ? noDashes(t) : String(t || '');
    state.arc[a.id] = { ...state.arc[a.id], beats: d.arc.map(clean).slice(0, 10), revised: round };
    log(a.id, 'artist.arc.revised', { round, data: { message: `revised arc: ${state.arc[a.id].beats.length} spreads`, arc: state.arc[a.id] } });
  }
  if (!state.thesis[a.id] && d.thesis) {
    state.thesis[a.id] = { text: (a.persona === 'ami' || a.persona === 'p2') ? noDashes(d.thesis) : String(d.thesis), round, brief_version: bv };
    log(a.id, 'artist.thesis', { round, response: state.thesis[a.id].text, data: { message: state.thesis[a.id].text } });
  }
  saveState();
  log(a.id, 'artist.plan', { round, response: r.text, model: r.model, endpoint: '/chat/completions', task_id: r.id, cost: r.cost, data: { intent: d.intent, review: d.review, keep: d.keep, thesis: state.thesis[a.id]?.text || null, direction: direction || null, brief_version: bv, stance_unclear: d.stance_unclear || null } });

  const made = [];
  for (const img of (d.images || []).slice(0, n)) {
    if (isStopped()) throw new StopError('stopped', 'paused');
    const slug = slugify(img.title);
    const taskId = `r${String(round).padStart(2, '0')}-${a.id.toLowerCase()}-${shortId(6)}`;
    const quality = runtime.draftQuality || 'low';
    log(a.id, 'image.request', { round, prompt: img.prompt, model: runtime.imageModel, endpoint: '/images', task_id: taskId, data: { title: img.title, quality } });
    const g = await generateImage({ prompt: img.prompt, quality, agent: a.id, round });
    const file = await saveImage(g.buf, taskId);
    const rec = { task_id: taskId, kind: 'draft', artist: a.id, group: a.group, persona: a.persona, round, brief_version: bv, beat: beatNo + made.length, title: img.title, slug, prompt: img.prompt, quality, model: runtime.imageModel, endpoint: '/images', request: g.request, response_meta: g.response_meta, seed: g.seed, cost: g.cost, cost_estimated: g.costEstimated, ts: new Date().toISOString(), file: path.basename(file), openrouter_id: g.id };
    addImage(rec); made.push(rec);
    log(a.id, 'image.result', { round, prompt: img.prompt, model: runtime.imageModel, endpoint: '/images', task_id: taskId, cost: g.cost, file: rec.file, data: { title: img.title, request: g.request, seed: g.seed, cost_estimated: g.costEstimated } });
  }

  if (made.length) {
    const rc = [{ type: 'text', text: `You just made these spreads. Write one line of reflection (max 25 words): does the spread make your point, and is the text legible? Plain text only.` }, ...(await imageParts(made, 512))];
    log(a.id, 'artist.reflection.request', { round, prompt: rc[0].text, model: runtime.sonnetModel, endpoint: '/chat/completions' });
    const rr = await chat({ model: runtime.sonnetModel, system, messages: [{ role: 'user', content: rc }], agent: a.id, round, estimate: 0.03, maxTokens: 120 });
    const line = ((a.persona === 'ami' || a.persona === 'p2') ? noDashes(rr.text) : rr.text).trim().split('\n')[0];
    log(a.id, 'artist.reflection', { round, response: line, model: rr.model, endpoint: '/chat/completions', task_id: rr.id, cost: rr.cost, data: { brief_version: bv } });
  }
}

// ---------- Engineer ----------
// Called when an artist run errors. Max 3 fix attempts per incident. Cannot touch caps, kill switch or briefs.
export async function withEngineer(agentId, round, fn) {
  try { return await fn(); } catch (err) {
    if (err instanceof StopError) throw err;
    const inc = { id: `inc-${shortId(6)}`, agent: agentId, round, error: err.message, status: 'open', attempts: [], ts: new Date().toISOString() };
    state.incidents = [...(state.incidents || []), inc]; saveState();
    log('engineer', 'incident.open', { round, task_id: inc.id, data: { message: err.message, agent: agentId, body: err.body || null } });
    let lastErr = err;
    for (let attempt = 1; attempt <= 3; attempt++) {
      if (isStopped()) break;
      let fix = null;
      try { fix = await engineerPropose(inc, lastErr, attempt); } catch (e) {
        if (e instanceof StopError) throw e;
        log('engineer', 'fix.error', { round, task_id: inc.id, data: { message: e.message } });
      }
      inc.attempts.push({ attempt, fix, ts: new Date().toISOString() }); saveState();
      if (fix && fix.retry === false) break;
      try {
        const out = await fn();
        inc.status = 'fixed'; saveState();
        log('engineer', 'incident.fixed', { round, task_id: inc.id, data: { message: `fixed on attempt ${attempt}` } });
        return out;
      } catch (e2) {
        if (e2 instanceof StopError) throw e2;
        lastErr = e2;
        log('engineer', 'retry.failed', { round, task_id: inc.id, data: { message: e2.message, attempt } });
      }
    }
    inc.status = 'failed'; saveState();
    state.notices = [...(state.notices || []), { ts: new Date().toISOString(), message: `Incident ${inc.id} (${agentId}, round ${round}) failed after 3 attempts: ${lastErr.message}` }];
    saveState();
    log('engineer', 'incident.failed', { round, task_id: inc.id, data: { message: lastErr.message } });
  }
}

async function engineerPropose(inc, err, attempt) {
  const recentErrors = events().filter(e => /error|retry|failed/.test(e.type)).slice(-12).map(e => ({ ts: e.ts, agent: e.agent, type: e.type, msg: e.data?.message, body: e.data?.body }));
  const editable = Object.fromEntries(ENGINEER_EDITABLE.map(k => [k, runtime[k]]));
  const system = 'You are the Engineer for an AI art studio that calls OpenRouter (POST /api/v1/images for images, /chat/completions for text). You fix configuration and retry settings only. You may not change spending caps, the kill switch, or any agent brief. Be minimal.';
  const user = `Incident ${inc.id}, attempt ${attempt} of 3.\nFailing agent: ${inc.agent}\nError: ${err.message}\nError body: ${JSON.stringify(err.body || null).slice(0, 1500)}\nRecent error log: ${JSON.stringify(recentErrors).slice(0, 3000)}\nEditable runtime config: ${JSON.stringify(editable)}\nImage model supported_parameters: ${JSON.stringify(runtime.imageSupported || null).slice(0, 1500)}\n\nReturn JSON only: {"diagnosis":"one sentence","patch":{ only keys from the editable config },"retry":true|false}. Use an empty patch if the error is transient.`;
  log('engineer', 'fix.request', { round: inc.round, task_id: inc.id, prompt: user, model: runtime.opusModel, endpoint: '/chat/completions' });
  const r = await chat({ model: runtime.opusModel || runtime.sonnetModel, system, messages: [{ role: 'user', content: user }], agent: 'engineer', round: inc.round, estimate: 0.2, maxTokens: 600 });
  const d = parseJsonReply(r.text);
  const applied = {};
  for (const [k, v] of Object.entries(d.patch || {})) {
    if (!ENGINEER_EDITABLE.includes(k)) continue;
    if (k === 'imageModel' && !(runtime.knownImageModels || []).includes(v)) continue;
    if (['sonnetModel', 'opusModel'].includes(k) && !(runtime.knownChatModels || []).includes(v)) continue;
    if (k === 'draftQuality' && !['low', 'medium'].includes(v)) continue; // drafts stay cheap
    if (k === 'extraImageParams' && (typeof v !== 'object' || v === null || ['quality', 'n', 'model', 'prompt'].some(x => x in v))) continue;
    applied[k] = v; runtime[k] = v;
  }
  saveRuntime();
  log('engineer', 'fix.applied', { round: inc.round, task_id: inc.id, response: r.text, model: r.model, endpoint: '/chat/completions', cost: r.cost, data: { message: d.diagnosis, applied, retry: d.retry !== false } });
  return { diagnosis: d.diagnosis, applied, retry: d.retry !== false };
}
