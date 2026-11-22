// Static config (from env + config/studio.json) and runtime config (Engineer-editable).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runtime, saveRuntime } from './store.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const readText = f => { try { return fs.readFileSync(path.join(ROOT, f), 'utf8'); } catch { return ''; } };

export const studio = JSON.parse(readText('config/studio.json'));
export const voiceSamples = readText('config/voice-samples.md');

// Hard ceiling: $20 maximum. The env var can only lower it.
const HARD_CEILING = 20;
export const CEILING = Math.min(HARD_CEILING, Number(process.env.SPEND_CEILING_USD) || HARD_CEILING);

export const env = {
  port: Number(process.env.PORT) || 8080,
  password: process.env.STUDIO_PASSWORD || '',
  sessionSecret: process.env.SESSION_SECRET || process.env.STUDIO_PASSWORD || '',
  allowedOrigins: (process.env.ALLOWED_ORIGINS || 'https://ami-nigam.com,https://www.ami-nigam.com,https://ami-nigam.github.io')
    .split(',').map(s => s.trim()).filter(Boolean),
  requireHttps: process.env.REQUIRE_HTTPS !== '0',
};

// Image price table (Replicate reference; real cost comes from usage.cost).
export const PRICE = { low: 0.05, medium: 0.09, high: 0.128, auto: 0.25, xhigh: 0.25, max: 0.5 };

// Runtime config. Only keys in ENGINEER_EDITABLE may be changed by the Engineer.
const RUNTIME_DEFAULTS = {
  imageModel: process.env.IMAGE_MODEL || null,      // resolved from GET /images/models
  sonnetModel: process.env.SONNET_MODEL || null,    // resolved from GET /models
  opusModel: process.env.OPUS_MODEL || null,
  imageSupported: null,                             // supported_parameters map for imageModel
  draftQuality: 'low',
  aspectRatio: '4:5',                               // magazine portrait
  sendAspectRatio: true,
  extraImageParams: {},                             // e.g. { output_format: 'png' }
  imageTimeoutMs: 240000,
  chatTimeoutMs: 120000,
  backoffBaseMs: 2000,
  artistHistoryImages: 4,
  curatorReviewImages: 15,
  chatMaxTokens: 1200,
  reasoningMode: 'budget',
  reasoningBudget: 1024,
};
export const ENGINEER_EDITABLE = [
  'imageModel', 'sonnetModel', 'opusModel', 'draftQuality', 'aspectRatio', 'sendAspectRatio',
  'extraImageParams', 'imageTimeoutMs', 'chatTimeoutMs', 'backoffBaseMs', 'artistHistoryImages',
  'curatorReviewImages', 'chatMaxTokens', 'reasoningMode', 'reasoningBudget',
];
for (const [k, v] of Object.entries(RUNTIME_DEFAULTS)) if (!(k in runtime)) runtime[k] = v;
// One-time migration to zine spreads: landscape, medium drafts so text is legible.
if ((runtime.formatVersion || 1) < 3) { runtime.aspectRatio = '3:2'; runtime.draftQuality = 'medium'; runtime.formatVersion = 3; }
// Env overrides always win over persisted values.
if (process.env.IMAGE_MODEL) runtime.imageModel = process.env.IMAGE_MODEL;
if (process.env.SONNET_MODEL) runtime.sonnetModel = process.env.SONNET_MODEL;
if (process.env.OPUS_MODEL) runtime.opusModel = process.env.OPUS_MODEL;
saveRuntime();
export { runtime };
