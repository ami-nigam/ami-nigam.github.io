// HTTP API. Every data endpoint and every image requires a valid session token.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { env, studio, runtime, CEILING } from './config.js';
import { state, saveState, log, events, allImages, IMG_DIR, THUMB_DIR, FINAL_DIR, ledgerEntries } from './store.js';
import { hasKey, getKey, spend, abortAll, resolveModels, chat, generateImage, lastKey } from './openrouter.js';
import { startScheduler, runRound, runFinal, runCheckpoint, nextWake, isBusy } from './scheduler.js';
import { currentBrief, limits } from './agents.js';
import { streamZip, exportManifest, creditsCsv, textMd } from './export.js';
import { round4 } from './util.js';

if (!env.password || env.password.length < 8) console.warn('WARNING: STUDIO_PASSWORD missing or shorter than 8 chars; login disabled.');
const SECRET = crypto.createHash('sha256').update(`vam-session:${env.sessionSecret}`).digest();
const TOKEN_TTL_MS = 12 * 3600 * 1000;

function sign(payload) {
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const mac = crypto.createHmac('sha256', SECRET).update(body).digest('base64url');
  return `${body}.${mac}`;
}
function verify(token) {
  if (!token || !token.includes('.')) return null;
  const [body, mac] = token.split('.');
  const expect = crypto.createHmac('sha256', SECRET).update(body).digest('base64url');
  const a = Buffer.from(mac), b = Buffer.from(expect);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  try { const p = JSON.parse(Buffer.from(body, 'base64url').toString()); return p.exp > Date.now() ? p : null; } catch { return null; }
}
function safeEqual(a, b) {
  const x = crypto.createHash('sha256').update(String(a)).digest(), y = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(x, y);
}

// Login rate limit: 5 attempts per 10 minutes per IP, plus a global 30 per 10 minutes.
const attempts = new Map(); let globalAttempts = [];
function rateLimited(ip) {
  const now = Date.now(), win = 10 * 60 * 1000;
  const arr = (attempts.get(ip) || []).filter(t => now - t < win);
  globalAttempts = globalAttempts.filter(t => now - t < win);
  if (arr.length >= 5 || globalAttempts.length >= 30) return true;
  arr.push(now); attempts.set(ip, arr); globalAttempts.push(now);
  return false;
}

function cors(req, res) {
  const origin = req.headers.origin;
  if (origin && env.allowedOrigins.includes(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
    res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Expose-Headers', 'Content-Disposition');
    res.setHeader('Access-Control-Max-Age', '600');
  }
}
function send(res, code, obj) {
  res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(obj));
}
async function readBody(req, max = 10000) {
  let s = '';
  for await (const c of req) { s += c; if (s.length > max) throw new Error('body too large'); }
  try { return s ? JSON.parse(s) : {}; } catch { return {}; }
}
const clientIp = req => (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.socket.remoteAddress;

function status() {
  const imgs = allImages();
  const s = spend();
  return {
    now: new Date().toISOString(), paused: !!state.paused, ceiling_hit: !!state.ceilingHit, ceiling_reason: state.ceilingReason || null,
    busy: isBusy(), round: state.round || 0, next_wake_uk: nextWake(), schedule: { ...studio.schedule, ...(state.schedule || {}) },
    spend: s, ceiling: CEILING, key_configured: hasKey(),
    limits: limits(), limits_reason: state.limitsReason || null,
    models: { image: runtime.imageModel, sonnet: runtime.sonnetModel, opus: runtime.opusModel, draft_quality: runtime.draftQuality, aspect_ratio: runtime.aspectRatio },
    agents: studio.artists.map(a => ({
      id: a.id, group: a.group, persona: studio.personas[a.persona].label,
      drafts: imgs.filter(i => i.artist === a.id && i.kind === 'draft').length,
      last_event: [...events()].reverse().find(e => e.agent === a.id)?.type || null,
    })),
    incidents: state.incidents || [], notices: state.notices || [],
    thesis: state.thesis || {}, research: state.research || {}, directions: state.directions || null, brief_version: state.briefVersion || 1,
    final_status: state.final?.status || null, stance: studio.stance, stance_status: studio.stance_status,
  };
}

async function connectionCheck() {
  const out = { started: new Date().toISOString(), steps: [] };
  const step = async (name, fn) => {
    try { const r = await fn(); out.steps.push({ name, ok: true, ...r }); } catch (e) { out.steps.push({ name, ok: false, error: e.message }); }
  };
  await step('GET /key', async () => { const k = await getKey(true); return { usage: k.usage, limit: k.limit, limit_remaining: k.limit_remaining, label: k.label }; });
  await step('GET /images/models + /models', async () => resolveModels());
  await step('test image (low)', async () => {
    const g = await generateImage({ prompt: 'A single grey pebble on white paper, soft daylight, studio photograph.', quality: runtime.draftQuality || 'low', agent: 'system', round: 0 });
    const meta = await import('sharp').then(m => m.default(g.buf).metadata()).catch(() => ({}));
    return { cost: g.cost, cost_estimated: g.costEstimated, request: g.request, width: meta.width, height: meta.height, bytes: g.buf.length, seed_returned: g.seed };
  });
  await step('Sonnet chat', async () => {
    const r = await chat({ model: runtime.sonnetModel, system: 'Reply in five words or fewer.', messages: [{ role: 'user', content: 'Say hello.' }], agent: 'system', round: 0, estimate: 0.01, maxTokens: 20 });
    return { model: r.model, reply: r.text, cost: r.cost };
  });
  out.spend = spend();
  state.lastCheck = out; saveState();
  log('system', 'connection.check', { data: out });
  return out;
}

function serveImage(res, name, thumb) {
  if (!/^[a-z0-9-]+$/i.test(name)) return send(res, 400, { error: 'bad name' });
  const candidates = thumb ? [path.join(THUMB_DIR, `${name}.jpg`)] : [];
  candidates.push(path.join(IMG_DIR, `${name}-a3.png`), path.join(FINAL_DIR, `${name}-a3.png`), path.join(IMG_DIR, `${name}.png`), path.join(FINAL_DIR, `${name}.png`));
  const file = candidates.find(f => fs.existsSync(f));
  if (!file) return send(res, 404, { error: 'not found' });
  res.writeHead(200, { 'Content-Type': file.endsWith('.jpg') ? 'image/jpeg' : 'image/png', 'Cache-Control': 'private, max-age=86400' });
  fs.createReadStream(file).pipe(res);
}

const server = http.createServer(async (req, res) => {
  try {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Strict-Transport-Security', 'max-age=31536000');
    cors(req, res);
    const url = new URL(req.url, 'http://x');
    const p = url.pathname;

    if (p === '/health') return send(res, 200, { ok: true, key_configured: hasKey(), password_configured: !!env.password, paused: !!state.paused, ceiling_hit: !!state.ceilingHit, round: state.round || 0 });
    if (env.requireHttps && req.headers['x-forwarded-proto'] && req.headers['x-forwarded-proto'] !== 'https') return send(res, 403, { error: 'https only' });
    if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }

    if (p === '/api/login' && req.method === 'POST') {
      if (!env.password || env.password.length < 8) return send(res, 503, { error: 'password not configured' });
      if (rateLimited(clientIp(req))) return send(res, 429, { error: 'too many attempts, wait 10 minutes' });
      const { password } = await readBody(req);
      if (!password || !safeEqual(password, env.password)) return send(res, 401, { error: 'wrong password' });
      return send(res, 200, { token: sign({ exp: Date.now() + TOKEN_TTL_MS }), expires_in: TOKEN_TTL_MS / 1000 });
    }

    if (!p.startsWith('/api/')) return send(res, 404, { error: 'not found' });
    const auth = req.headers.authorization || '';
    if (!verify(auth.replace(/^Bearer\s+/i, ''))) return send(res, 401, { error: 'login required' });

    if (p === '/api/status' && req.method === 'GET') { if (hasKey()) await getKey().catch(() => {}); return send(res, 200, status()); }
    if (p === '/api/events' && req.method === 'GET') {
      const since = Number(url.searchParams.get('since') || 0); const agent = url.searchParams.get('agent');
      const limit = Math.min(1000, Number(url.searchParams.get('limit') || 300));
      let ev = events().filter(e => e.seq > since);
      if (agent) ev = ev.filter(e => e.agent === agent);
      return send(res, 200, { events: ev.slice(-limit) });
    }
    if (p === '/api/images' && req.method === 'GET') {
      return send(res, 200, { images: allImages().map(({ response_meta, ...r }) => r), favourites: state.favourites || {}, shortlist: state.shortlist || [] });
    }
    if (p.startsWith('/api/image/') && req.method === 'GET') return serveImage(res, p.slice(11), url.searchParams.get('thumb') === '1');
    if (p === '/api/curator' && req.method === 'GET') {
      return send(res, 200, { brief: currentBrief(), notes: state.curatorNotes || [], shortlist: state.shortlist || [], final: state.final || null, limits_reason: state.limitsReason || null, last_check: state.lastCheck || null });
    }
    if (p === '/api/costs' && req.method === 'GET') {
      const by = {}; for (const e of ledgerEntries()) { const k = `${e.agent}|${e.kind}`; by[k] = round4((by[k] || 0) + (Number(e.cost) || 0)); }
      return send(res, 200, { spend: spend(), by_agent_kind: by, entries: ledgerEntries().slice(-200), key: lastKey() ? { usage: lastKey().usage, limit: lastKey().limit, limit_remaining: lastKey().limit_remaining } : null });
    }
    if (p === '/api/pause' && req.method === 'POST') {
      state.paused = true; saveState(); abortAll('paused by Ami'); log('system', 'paused', { data: { message: 'kill switch: all agents paused' } });
      return send(res, 200, status());
    }
    if (p === '/api/resume' && req.method === 'POST') {
      state.paused = false; saveState(); log('system', 'resumed', { data: { message: 'agents resumed' } });
      return send(res, 200, status());
    }
    if (p === '/api/run-round' && req.method === 'POST') {
      if (isBusy()) return send(res, 409, { error: `${isBusy()} already running` });
      runRound('manual'); return send(res, 202, { started: true });
    }
    if (p === '/api/run-checkpoint' && req.method === 'POST') { runCheckpoint('checkpoint'); return send(res, 202, { started: true }); }
    if (p === '/api/run-final' && req.method === 'POST') { runFinal(); return send(res, 202, { started: true }); }
    if (p === '/api/admin/check' && req.method === 'POST') {
      if (isBusy()) return send(res, 409, { error: `${isBusy()} running` });
      return send(res, 200, await connectionCheck());
    }
    if (p === '/api/export.zip' && req.method === 'GET') return streamZip(res);
    if (p === '/api/export/credits.csv' && req.method === 'GET') { res.writeHead(200, { 'Content-Type': 'text/csv' }); return res.end(creditsCsv(exportManifest().rows)); }
    if (p === '/api/export/text.md' && req.method === 'GET') { res.writeHead(200, { 'Content-Type': 'text/markdown' }); return res.end(textMd()); }
    return send(res, 404, { error: 'not found' });
  } catch (e) {
    console.error(e);
    if (!res.headersSent) send(res, 500, { error: 'server error' });
  }
});

server.listen(env.port, async () => {
  console.log(`studio listening on ${env.port}; key ${hasKey() ? 'configured' : 'MISSING'}`);
  if (hasKey()) {
    try { const r = await resolveModels(); log('system', 'models.resolved', { data: { image: r.image.id, sonnet: r.sonnet, opus: r.opus, notes: r.notes } }); }
    catch (e) { log('system', 'models.error', { data: { message: e.message } }); }
  }
  startScheduler();
});
