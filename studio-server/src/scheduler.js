// In-process scheduler. Slots are UK half-hours. The fired slot is persisted
// BEFORE running, so restarts never double-fire; a restart within the grace
// window still fires a missed slot.
import { studio } from './config.js';
import { state, saveState, log } from './store.js';
import { ukParts, hhmmToMin, minToHhmm } from './util.js';
import { artistWake, curatorBudget, curatorCheckpoint, curatorFinal, curatorWriteBrief, withEngineer, limits } from './agents.js';
import { StopError, isStopped } from './openrouter.js';
import { runDebateSteps } from './debate.js';
import { curatorZine } from './zine.js';

let busy = null;
export const isBusy = () => busy;

function schedule() {
  const s = studio.schedule;
  if (!state.schedule) {
    const p = ukParts();
    const start = s.start || minToHhmm(Math.ceil((p.hh * 60 + p.mm) / s.interval_min) * s.interval_min);
    state.schedule = { date: s.date || p.date, start };
    saveState();
  }
  return { ...s, ...state.schedule };
}

export function nextWake() {
  const s = schedule(); const p = ukParts();
  const now = p.hh * 60 + p.mm;
  if (p.date !== s.date) return null;
  const start = hhmmToMin(s.start), last = hhmmToMin(s.last_artist_wake);
  for (let m = start; m <= last; m += s.interval_min) if (m > now || (m === now && state.lastSlot !== `${s.date} ${minToHhmm(m)}`)) return minToHhmm(m);
  return null;
}

export async function runRound(trigger = 'schedule') {
  if (busy) { log('system', 'round.skipped', { data: { message: `${busy} still running` } }); return false; }
  if (isStopped()) { log('system', 'round.skipped', { data: { message: 'paused or ceiling reached' } }); return false; }
  busy = 'round';
  const round = (state.round || 0) + 1; state.round = round; state.roundRunning = round; saveState();
  log('system', 'round.start', { round, data: { message: `round ${round} (${trigger})` } });
  try {
    await curatorWriteBrief(round);
    const lim = await curatorBudget(round);
    if (lim.skip_round) { log('system', 'round.skip', { round, data: { message: state.limitsReason } }); return true; }
    await Promise.all(studio.artists.map(a => withEngineer(a.id, round, () => artistWake(a, round, lim)).catch(e => {
      log(a.id, 'artist.error', { round, data: { message: e.message, kind: e.kind || null } });
    })));
    log('system', 'round.end', { round });
  } catch (e) {
    log('system', e instanceof StopError ? 'round.stopped' : 'round.error', { round, data: { message: e.message } });
  } finally { busy = null; state.roundRunning = null; saveState(); }
  return true;
}

export async function runCheckpoint(label = 'checkpoint') {
  // Wait for an in-flight round to finish (max ~15 min).
  for (let i = 0; i < 90 && busy; i++) await new Promise(r => setTimeout(r, 10000));
  if (busy || isStopped()) return;
  busy = label;
  try { await curatorCheckpoint(state.round || 0, label); } catch (e) { log('curator', `${label}.error`, { data: { message: e.message } }); }
  try { await curatorZine(state.round || 0, label); } catch (e) { log('curator', 'zine.error', { data: { message: e.message } }); }
  finally { busy = null; }
}

export async function runDebate() {
  for (let i = 0; i < 90 && busy; i++) await new Promise(r => setTimeout(r, 10000));
  if (busy) return;
  if (isStopped()) { log('system', 'debate.skipped', { data: { message: 'paused or ceiling reached' } }); return; }
  busy = 'debate';
  try { await runDebateSteps(state.round || 0); }
  catch (e) { state.debate = { ...(state.debate || {}), status: 'interrupted', error: e.message }; saveState(); log('system', e instanceof StopError ? 'debate.stopped' : 'debate.error', { data: { message: e.message } }); }
  finally { busy = null; }
}

export async function runZine() {
  if (busy) return false;
  busy = 'zine';
  try { await curatorZine(state.round || 0, 'manual'); } catch (e) { log('curator', 'zine.error', { data: { message: e.message } }); } finally { busy = null; }
  return true;
}

export async function runFinal() {
  for (let i = 0; i < 90 && busy; i++) await new Promise(r => setTimeout(r, 10000));
  if (busy) return;
  if (isStopped()) { log('system', 'final.skipped', { data: { message: 'paused or ceiling reached' } }); return; }
  busy = 'final';
  try {
    if (!state.final?.picks?.length) { try { await curatorCheckpoint(state.round || 0, 'checkpoint'); } catch (e) { log('curator', 'checkpoint.error', { data: { message: e.message } }); } }
    await curatorFinal(state.round || 0);
    try { await curatorZine(state.round || 0, 'final'); } catch (e) { log('curator', 'zine.error', { data: { message: e.message } }); }
  } catch (e) {
    state.final = { ...(state.final || {}), status: 'error', error: e.message }; saveState();
    log('curator', 'final.error', { data: { message: e.message } });
  } finally { busy = null; }
}

function tick() {
  try {
    const s = schedule(); const p = ukParts();
    if (p.date !== s.date) return;
    const now = p.hh * 60 + p.mm;
    const slotMin = Math.floor(now / s.interval_min) * s.interval_min;
    const slot = `${s.date} ${minToHhmm(slotMin)}`;
    const inWindow = slotMin >= hhmmToMin(s.start) && slotMin <= hhmmToMin(s.last_artist_wake);
    const fresh = now - slotMin < s.grace_min;
    const finalMin = hhmmToMin(s.final);

    if (inWindow && fresh && state.lastSlot !== slot) {
      state.lastSlot = slot; saveState(); // persist first: no double fire
      if (!state.paused && !state.ceilingHit) {
        const hhmm = minToHhmm(slotMin);
        runRound('schedule').then(() => {
          if (s.checkpoints.includes(hhmm) && state.lastCheckpoint !== slot) {
            state.lastCheckpoint = slot; saveState();
            runCheckpoint('checkpoint');
          }
        });
      } else log('system', 'round.skipped', { data: { message: `slot ${slot} skipped: paused or ceiling` } });
    }
    const debateMin = s.debate_at ? hhmmToMin(s.debate_at) : null;
    if (debateMin != null && now >= debateMin && now < finalMin && !state.debateFired) {
      state.debateFired = slot; saveState();
      log('system', 'debate.scheduled', { data: { message: 'debate time' } });
      runDebate();
    }
    if (now >= finalMin && now < finalMin + 60 && !state.finalFired) {
      state.finalFired = slot; saveState();
      log('system', 'final.start', { data: { message: 'final selection' } });
      runFinal();
    }
  } catch (e) { console.error('tick error', e); }
}

export function startScheduler() {
  if (state.paused == null) { state.paused = process.env.AUTOSTART !== '1'; saveState(); } // first boot starts paused until Ami resumes
  limits(); schedule();
  if (state.final?.status === 'running') { state.final.status = 'interrupted'; saveState(); }
  if (state.roundRunning) {
    const r = state.roundRunning; state.roundRunning = null; saveState();
    log('system', 'round.interrupted', { round: r, data: { message: `round ${r} was cut off by a restart; starting a fresh round` } });
    if (!state.paused && !state.ceilingHit && state.debate?.status !== 'running') setTimeout(() => runRound('recover'), 8000);
  }
  if (state.debate?.status === 'running') { log('system', 'debate.resume', { data: { message: 'resuming debate after restart' } }); setTimeout(runDebate, 8000); }
  log('system', 'scheduler.start', { data: { message: `date ${state.schedule.date}, start ${state.schedule.start}, last wake ${studio.schedule.last_artist_wake}, final ${studio.schedule.final}`, lastSlot: state.lastSlot || null } });
  setInterval(tick, 15000);
  setTimeout(tick, 3000);
}
