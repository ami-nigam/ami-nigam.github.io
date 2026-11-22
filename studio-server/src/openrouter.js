// OpenRouter client with a hard spend guard, kill switch, 503 backoff and cost logging.
// The API key is read from process.env only. It is never logged or returned.
import { CEILING, PRICE, runtime } from './config.js';
import { state, saveState, saveRuntime, addCost, ledgerTotal, log } from './store.js';
import { sleep, round4, cmpVersion } from './util.js';

// Test-only override, restricted to localhost so the key can never be sent elsewhere.
const BASE = /^http:\/\/127\.0\.0\.1:\d+\/api\/v1$/.test(process.env.OPENROUTER_BASE_TEST || '') ? process.env.OPENROUTER_BASE_TEST : 'https://openrouter.ai/api/v1';
const KEY = () => process.env.OPENROUTER_API_KEY || '';
export const hasKey = () => !!KEY();

export class StopError extends Error { constructor(msg, kind) { super(msg); this.kind = kind; } }

// ---- Kill switch ----
const inflight = new Set();
export function isStopped() { return !!state.paused || !!state.ceilingHit; }
export function abortAll(reason) {
  for (const c of inflight) if (!c.system) { try { c.abort(new StopError(reason, 'paused')); } catch { /* noop */ } }
  inflight.clear();
}

// ---- Key info / spend ----
let keyInfo = null; let keyAt = 0;
export async function getKey(force = false) {
  if (!force && keyInfo && Date.now() - keyAt < 10000) return keyInfo;
  const r = await fetch(`${BASE}/key`, { headers: { Authorization: `Bearer ${KEY()}` }, signal: AbortSignal.timeout(15000) });
  if (!r.ok) throw new Error(`GET /key ${r.status}`);
  const j = await r.json();
  keyInfo = j.data || j; keyAt = Date.now();
  if (state.keyBaselineUsage == null && typeof keyInfo.usage === 'number') { state.keyBaselineUsage = keyInfo.usage; saveState(); }
  return keyInfo;
}
export const lastKey = () => keyInfo;

let reserved = 0;
export function spend() {
  const ledger = ledgerTotal();
  const keyDelta = keyInfo && typeof keyInfo.usage === 'number' && state.keyBaselineUsage != null
    ? keyInfo.usage - state.keyBaselineUsage : 0;
  const spent = Math.max(ledger, keyDelta);
  return {
    ceiling: CEILING, spent: round4(spent), ledger: round4(ledger), key_delta: round4(keyDelta),
    reserved: round4(reserved), remaining: round4(CEILING - spent - reserved),
    key_usage: keyInfo?.usage ?? null, key_limit: keyInfo?.limit ?? null, key_limit_remaining: keyInfo?.limit_remaining ?? null,
  };
}

function hitCeiling(why) {
  if (!state.ceilingHit) {
    state.ceilingHit = true; state.ceilingReason = why; saveState();
    log('system', 'ceiling.reached', { data: { message: why, ...spend() } });
    abortAll('ceiling reached');
  }
  throw new StopError(why, 'ceiling');
}

// Checked before every billable API call.
async function guard(estimate, ignorePause = false) {
  if (state.paused && !ignorePause) throw new StopError('studio paused', 'paused');
  if (state.ceilingHit) throw new StopError('spend ceiling reached', 'ceiling');
  if (!hasKey()) throw new Error('OPENROUTER_API_KEY not set');
  try { await getKey(); } catch (e) {
    // Fail closed if we cannot read the key's remaining limit.
    throw new Error(`cannot verify limit_remaining: ${e.message}`);
  }
  const s = spend();
  if (s.spent + reserved + estimate > CEILING) hitCeiling(`ceiling $${CEILING}: spent $${s.spent}, reserved $${round4(reserved)}, next ~$${estimate}`);
  if (keyInfo.limit_remaining != null && keyInfo.limit_remaining - reserved < estimate) hitCeiling(`key limit_remaining $${keyInfo.limit_remaining} below next call ~$${estimate}`);
  reserved += estimate;
  return () => { reserved = Math.max(0, reserved - estimate); };
}

async function call(path, body, { estimate, timeoutMs, agent, round, kind }) {
  const ignorePause = agent === 'system'; // connection check only
  const maxRetries = 3; // fixed by spec
  let attempt = 0;
  for (;;) {
    const release = await guard(estimate, ignorePause);
    const ctrl = new AbortController(); ctrl.system = ignorePause; inflight.add(ctrl);
    const timer = setTimeout(() => ctrl.abort(new Error(`timeout after ${timeoutMs}ms`)), timeoutMs);
    let res, text;
    try {
      res = await fetch(`${BASE}${path}`, {
        method: 'POST', signal: ctrl.signal,
        headers: { Authorization: `Bearer ${KEY()}`, 'Content-Type': 'application/json', 'X-Title': 'Stochastic by Design studio' },
        body: JSON.stringify(body),
      });
      text = await res.text();
    } catch (e) {
      release(); clearTimeout(timer); inflight.delete(ctrl);
      throw ctrl.signal.reason instanceof StopError ? ctrl.signal.reason : e;
    }
    clearTimeout(timer); inflight.delete(ctrl);
    let json = null; try { json = JSON.parse(text); } catch { /* non-JSON */ }
    if ([503, 502, 429].includes(res.status) && attempt < maxRetries) {
      release(); attempt++;
      const wait = (runtime.backoffBaseMs || 2000) * 2 ** (attempt - 1);
      log(agent, 'api.retry', { round, endpoint: path, data: { message: `${res.status}, retry ${attempt}/${maxRetries} in ${wait}ms` } });
      await sleep(wait);
      continue;
    }
    if (!res.ok || json?.error) {
      release();
      const msg = json?.error?.message || text?.slice(0, 500) || `HTTP ${res.status}`;
      const err = new Error(`${path} ${res.status}: ${msg}`); err.status = res.status; err.body = json?.error || text?.slice(0, 1000);
      throw err;
    }
    const cost = json?.usage?.cost;
    const actual = typeof cost === 'number' ? cost : estimate;
    addCost({ agent, round, endpoint: path, kind, model: body.model, cost: actual, estimated: typeof cost !== 'number', id: json?.id || null });
    keyAt = 0; // refresh key info on next guard
    release();
    return { json, cost: actual, costEstimated: typeof cost !== 'number' };
  }
}

// ---- Chat ----
export async function chat({ model, system, messages, maxTokens, agent, round, estimate = 0.08, temperature }) {
  const body = {
    model, max_tokens: maxTokens || runtime.chatMaxTokens,
    messages: [{ role: 'system', content: system }, ...messages],
  };
  if (temperature != null) body.temperature = temperature;
  const { json, cost } = await call('/chat/completions', body, { estimate, timeoutMs: runtime.chatTimeoutMs, agent, round, kind: 'chat' });
  const content = json.choices?.[0]?.message?.content;
  const text = Array.isArray(content) ? content.map(c => c.text || '').join('') : (content || '');
  return { text, cost: round4(cost), id: json.id, model: json.model || model, usage: json.usage };
}

// ---- Images ----
export function imageBody(prompt, quality) {
  const sup = runtime.imageSupported;
  const supports = k => !sup || Object.prototype.hasOwnProperty.call(sup, k);
  const body = { model: runtime.imageModel, prompt, n: 1 };
  if (supports('quality')) body.quality = quality; // always explicit, never auto
  if (runtime.sendAspectRatio && runtime.aspectRatio && supports('aspect_ratio')) body.aspect_ratio = runtime.aspectRatio;
  if (supports('output_format')) body.output_format = 'png';
  Object.assign(body, runtime.extraImageParams || {});
  if (body.quality === 'auto') body.quality = quality;
  return body;
}

export async function generateImage({ prompt, quality, agent, round }) {
  if (!runtime.imageModel) throw new Error('image model not resolved (run connection check)');
  const body = imageBody(prompt, quality);
  const estimate = round4((PRICE[quality] ?? 0.25) * 1.25);
  const { json, cost, costEstimated } = await call('/images', body, { estimate, timeoutMs: runtime.imageTimeoutMs, agent, round, kind: 'image' });
  const d = json.data?.[0];
  if (!d) throw new Error('no image in response');
  let buf, mediaType = d.media_type || 'image/png';
  if (d.b64_json) buf = Buffer.from(d.b64_json, 'base64');
  else if (d.url?.startsWith('data:')) { const [h, b] = d.url.split(','); mediaType = h.slice(5).split(';')[0]; buf = Buffer.from(b, 'base64'); }
  else if (d.url) { const r = await fetch(d.url, { signal: AbortSignal.timeout(60000) }); buf = Buffer.from(await r.arrayBuffer()); mediaType = r.headers.get('content-type') || mediaType; }
  else throw new Error('image response had neither b64_json nor url');
  const { data: _omit, ...meta } = json;
  return { buf, mediaType, cost: round4(cost), costEstimated, request: body, response_meta: meta, id: json.id || null, seed: d.seed ?? json.seed ?? null };
}

// ---- Model discovery (free endpoints) ----
async function getJson(path) {
  const r = await fetch(`${BASE}${path}`, { headers: { Authorization: `Bearer ${KEY()}` }, signal: AbortSignal.timeout(20000) });
  if (!r.ok) throw new Error(`GET ${path} ${r.status}`);
  return r.json();
}

export async function resolveModels() {
  const out = { notes: [] };
  const im = await getJson('/images/models');
  const ids = (im.data || []).map(m => m.id);
  runtime.knownImageModels = ids;
  const pick = (re) => ids.filter(id => re.test(id)).sort(cmpVersion).reverse()[0];
  const target = ids.find(id => /gpt-image-2\.6.*sunburst/i.test(id));
  const chosen = process.env.IMAGE_MODEL || target || pick(/sunburst/i) || pick(/gpt-image/i);
  if (!target) out.notes.push(`GPT Image 2.6 Sunburst not listed; using ${chosen || 'none'}`);
  runtime.imageModel = chosen || null;
  const entry = (im.data || []).find(m => m.id === chosen);
  runtime.imageSupported = entry?.supported_parameters || null;
  out.image = { id: chosen, target_found: !!target, supported_parameters: entry?.supported_parameters || null, sunburst_ids: ids.filter(i => /sunburst|gpt-image/i.test(i)) };

  const m = await getJson('/models');
  const mids = (m.data || []).map(x => x.id).filter(id => id.startsWith('anthropic/'));
  runtime.knownChatModels = mids;
  const latest = re => mids.filter(id => re.test(id) && !/:/.test(id)).sort(cmpVersion).reverse()[0];
  runtime.sonnetModel = process.env.SONNET_MODEL || latest(/claude-sonnet/) || latest(/sonnet/);
  runtime.opusModel = process.env.OPUS_MODEL || latest(/claude-opus/) || latest(/opus/);
  out.sonnet = runtime.sonnetModel; out.opus = runtime.opusModel;
  out.anthropic_ids = mids;
  saveRuntime();
  return out;
}
