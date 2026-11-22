// The debate: the only time the artists see or are aware of each other.
// Curator + 5 artists, 5 turns each. Resumable after a restart.
import { studio, runtime } from './config.js';
import { state, saveState, log, allImages } from './store.js';
import { chat, StopError, isStopped } from './openrouter.js';
import { persona, artistSystem, amiVoiceBlock, imageParts, currentBrief } from './agents.js';
import { noDashes } from './util.js';

const TURNS = () => studio.schedule.debate_turns || 5;
const WORDS = () => studio.schedule.debate_words || 80;
const amiVoice = a => a.persona === 'ami' || a.persona === 'p2';
const nameOf = id => id === 'curator' ? 'Curator' : (persona(studio.artists.find(a => a.id === id)).name || id);

// Speaking order: per round, the Curator first, then the artists rotated by one each round.
export function debatePlan() {
  const ids = studio.artists.map(a => a.id);
  const plan = [];
  for (let r = 0; r < TURNS(); r++) {
    plan.push({ round: r + 1, speaker: 'curator' });
    for (let i = 0; i < ids.length; i++) plan.push({ round: r + 1, speaker: ids[(i + r) % ids.length] });
  }
  return plan;
}

function latestSpreads() {
  const bv = state.briefVersion || 1;
  const out = [];
  for (const a of studio.artists) {
    const mine = allImages().filter(i => i.artist === a.id && i.kind === 'draft' && (i.brief_version || 1) === bv);
    const last = mine[mine.length - 1];
    if (last) out.push({ ...last, artist: nameOf(a.id), title: last.title });
  }
  return out;
}

function roster() {
  return studio.artists.map(a => {
    const p = persona(a);
    return `- ${p.name || a.id}: ${p.label}${a.group === 'persona' ? ' (carries Ami\'s voice)' : ''}. Personality: ${(p.personality || '').split('.')[0]}. Point: "${state.thesis?.[a.id]?.text || 'not stated'}"`;
  }).join('\n');
}

const transcript = () => (state.debate?.turns || []).map(t => `${nameOf(t.speaker)}: ${t.text}`).join('\n\n');

async function speak(step, idx, total, spreadsParts, round) {
  const isCurator = step.speaker === 'curator';
  const a = isCurator ? null : studio.artists.find(x => x.id === step.speaker);
  const myTurn = (state.debate.turns || []).filter(t => t.speaker === step.speaker).length + 1;
  const stage = isCurator
    ? (step.round === 1 ? 'Open the debate: introduce each artist and their point in one line each, then pose one sharp question to all.'
      : step.round === TURNS() ? 'Close the debate: say where each artist now stands and what is still unresolved. No winner.'
      : 'Moderate: name the sharpest disagreement so far and put a pointed question to one or two artists by name.')
    : 'Make your case, answer what was said, and challenge others by name where you disagree. Stay in character.';
  const system = isCurator
    ? `You are the Curator, moderating a live debate between five AI artists for ${studio.publication}, "${studio.title}". You write in Ami Nigam's voice: plain, short, no hype, no em-dashes.\n\n${amiVoiceBlock()}`
    : `${artistSystem(a)}\n\nThis is a live debate. For the first and only time today you can see the other artists and their work.`;
  const text = `Brief:\n${currentBrief()}\n\nParticipants:\n${roster()}\n\nTheir latest spreads are attached.\n\nTranscript so far:\n${transcript() || '(nothing yet)'}\n\nThis is your turn ${myTurn} of ${TURNS()}. ${stage}\nAt most ${isCurator && step.round === 1 ? WORDS() * 2 : WORDS()} words. Spoken words only, no stage directions, no name prefix.${isCurator || amiVoice(a) ? ' No em-dashes.' : ''}`;
  log(step.speaker, 'debate.request', { round, prompt: text, model: runtime.sonnetModel, endpoint: '/chat/completions', data: { turn: idx + 1, of: total } });
  const r = await chat({ model: runtime.sonnetModel, system, messages: [{ role: 'user', content: [{ type: 'text', text }, ...spreadsParts] }], agent: step.speaker, round, estimate: 0.06, maxTokens: 400 });
  let said = r.text.trim().replace(/^\s*\**[A-Z][a-zA-Z ]{0,20}\**:\s*/, '');
  if (isCurator || amiVoice(a)) said = noDashes(said);
  const mentions = ['curator', ...studio.artists.map(x => x.id)].filter(id => id !== step.speaker && new RegExp(`\\b${nameOf(id)}\\b`, 'i').test(said));
  state.debate.turns.push({ n: idx + 1, round: step.round, speaker: step.speaker, text: said, mentions, ts: new Date().toISOString() });
  saveState();
  log(step.speaker, 'debate.turn', { round, response: said, model: r.model, endpoint: '/chat/completions', task_id: r.id, cost: r.cost, data: { turn: idx + 1, of: total, debate_round: step.round, mentions, message: said.slice(0, 200) } });
}

export async function runDebateSteps(round) {
  state.debate = state.debate || { status: 'running', turns: [], takeaways: {}, started: new Date().toISOString(), round };
  if (state.debate.status === 'done') return;
  state.debate.status = 'running'; saveState();
  const plan = debatePlan();
  if (!state.debate.turns.length) log('system', 'debate.start', { round, data: { message: `debate opens: ${plan.length} turns`, total: plan.length } });
  const spreadsParts = await imageParts(latestSpreads(), 320);
  for (let i = state.debate.turns.length; i < plan.length; i++) {
    if (isStopped()) throw new StopError('stopped', 'paused');
    await speak(plan[i], i, plan.length, spreadsParts, round);
  }
  // Takeaways: the only thing that carries into later wakes.
  for (const a of studio.artists) {
    if (state.debate.takeaways?.[a.id]) continue;
    const text = `The debate is over. Transcript:\n${transcript()}\n\nIn one sentence (max 30 words), in your own voice: what will you keep and what will you change in your work after this debate?${amiVoice(a) ? ' No em-dashes.' : ''}`;
    log(a.id, 'debate.takeaway.request', { round, prompt: text, model: runtime.sonnetModel, endpoint: '/chat/completions' });
    const r = await chat({ model: runtime.sonnetModel, system: artistSystem(a), messages: [{ role: 'user', content: text }], agent: a.id, round, estimate: 0.04, maxTokens: 120 });
    const line = (amiVoice(a) ? noDashes(r.text) : r.text).trim().split('\n')[0];
    state.debate.takeaways = { ...(state.debate.takeaways || {}), [a.id]: line }; saveState();
    log(a.id, 'debate.takeaway', { round, response: line, model: r.model, endpoint: '/chat/completions', task_id: r.id, cost: r.cost, data: { message: line } });
  }
  state.debate.status = 'done'; state.debate.ended = new Date().toISOString(); saveState();
  log('system', 'debate.end', { round, data: { message: 'debate closed' } });
}
