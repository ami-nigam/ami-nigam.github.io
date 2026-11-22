// The zine: the Curator keeps a flatplan of A3 spreads that documents the whole experiment.
// The viewer typesets it; the Curator only decides structure, copy, images and quotes.
import { studio, runtime, CEILING } from './config.js';
import { state, saveState, log, allImages, events, ledgerEntries } from './store.js';
import { chat } from './openrouter.js';
import { persona, amiVoiceBlock, currentBrief } from './agents.js';
import { parseJsonReply, noDashes, round4 } from './util.js';
import { spend } from './openrouter.js';

export const TEMPLATES = {
  opener: 'Title spread: STOCHASTIC BY DESIGN, the question, the cast of artists. Fields: title, body (the question or a short intro).',
  setup: 'The studio: how the experiment worked (one brief, separate rooms, research, series, one debate, the Curator, the Engineer) beside a floor plan of the studio. Fields: title, body (60 to 120 words).',
  cast: 'The four artists side by side: what each thinks, how it makes the argument, its main research pointers. Fields: title, caption (optional one line).',
  artist: 'One artist\'s strongest spread, full bleed. Fields: artist, image (task id), caption: ONE sentence on what this spread says within that artist\'s argument (use its beat_text and intent).',
  series: 'Contact sheet of one artist\'s whole series in order, showing the narrative. Fields: artist, title, caption.',
  debate: 'The debate: one big pull quote plus 4 to 6 short excerpts. Fields: title, quote {speaker, text}, quotes [{speaker, text}].',
  after: 'Before and after the debate: each artist\'s takeaway beside a spread made after it. Fields: title.',
  numbers: 'The experiment in numbers. Fields: title, caption.',
  essay: 'Text spread: a section of the essay. Fields: title, body (150 to 300 words).',
  close: 'Closing spread: the Curator\'s conclusion and the stance. Fields: title, body (40 to 100 words).',
};

// What each spread says: its beat in the artist's arc and the artist's stated intent for that wake.
export function spreadNotes() {
  const out = {};
  const plans = events().filter(e => e.type === 'artist.plan');
  for (const i of allImages().filter(x => x.kind === 'draft')) {
    const plan = plans.find(e => e.agent === i.artist && e.round === i.round);
    const beats = state.arc?.[i.artist]?.beats || [];
    out[i.task_id] = { beat: i.beat || null, beat_text: i.beat ? (beats[i.beat - 1] || '') : '', intent: plan?.data?.intent || '', title: i.title };
  }
  return out;
}

export function stats() {
  const imgs = allImages();
  const ev = events();
  const first = ev.find(e => e.type === 'round.start');
  return {
    spreads: imgs.filter(i => i.kind === 'draft').length,
    finals: imgs.filter(i => i.kind === 'final').length,
    rounds: state.round || 0,
    calls: ledgerEntries().length,
    debate_turns: (state.debate?.turns || []).length,
    hours: first ? round4((Date.now() - new Date(first.ts)) / 3600000) : 0,
    artists: studio.artists.length,
  };
}

export async function curatorZine(round, label = 'update') {
  const n = studio.zine_spreads || 10;
  const bv = state.briefVersion || 1;
  const imgs = allImages().filter(i => i.kind === 'draft' && (i.brief_version || 1) === bv);
  const cast = studio.artists.map(a => {
    const p = persona(a);
    return { id: a.id, name: p.name, label: p.label, argument: state.thesis?.[a.id]?.text || p.point || '', series: state.arc?.[a.id]?.series_title || '', beats: state.arc?.[a.id]?.beats || [], research: state.research?.[a.id]?.findings || [], takeaway: state.debate?.takeaways?.[a.id] || null };
  });
  const notesBy = spreadNotes();
  const images = imgs.map(i => ({ id: i.task_id, artist: i.artist, round: i.round, beat: i.beat || null, title: i.title, beat_text: notesBy[i.task_id]?.beat_text || '', intent: notesBy[i.task_id]?.intent || '' }));
  const debate = (state.debate?.turns || []).map(t => ({ speaker: t.speaker === 'curator' ? 'Curator' : (persona(studio.artists.find(a => a.id === t.speaker)).name || t.speaker), text: t.text }));
  const notes = (state.curatorNotes || []).slice(-4).map(n2 => n2.notes);
  const system = `You are the Curator and art director of a zine for ${studio.publication}, working title "${studio.title}". You write in Ami Nigam's voice.\n\n${amiVoiceBlock()}`;
  const user = `Build the flatplan for a ${n}-spread zine (A3 landscape spreads) that documents this whole experiment: how it was set up, what each artist argued and made, the debate, what changed, and what it says about the question.
The question: "${studio.question}"
Editorial stance (Ami): "${studio.stance}"
Brief given to the artists:\n${currentBrief()}
Cast:\n${JSON.stringify(cast)}
Images available (use only these ids):\n${JSON.stringify(images)}
Debate ${state.debate?.status || 'not held yet'}:\n${JSON.stringify(debate).slice(0, 6000)}
Curator notes so far:\n${notes.join('\n')}
Numbers: ${JSON.stringify(stats())}
Final essay ${state.final?.text ? 'exists (use essay spreads for sections of it)' : 'not written yet (write short placeholder copy)'}.

Templates you may use:\n${Object.entries(TEMPLATES).map(([k, v]) => `- ${k}: ${v}`).join('\n')}

Rules: exactly ${n} spreads, numbered in reading order. Start with opener, then setup, then cast. End with close. Give every artist one "artist" spread and use "series" where it shows a narrative. If the debate has not happened, still reserve a debate spread and an after spread with placeholder copy. Make it unmistakable that the artists are AI agents created for this experiment (language models given a name, a temperament and a bias), not human artists. Never mention money, cost, budget or spend anywhere in the zine. Modern, confident, very little text per spread. Headlines short and sharp. Plain words, no hype, never em-dashes. Do not invent facts, quotes or numbers: quotes must come from the debate transcript above.
Return JSON only: {"spreads":[{"n":1,"template":"opener","title":"...","body":"...","artist":"A1","image":"task id","caption":"...","quote":{"speaker":"...","text":"..."},"quotes":[{"speaker":"...","text":"..."}]}],"note":"one sentence on the zine's arc"}`;
  log('curator', 'zine.request', { round, prompt: user, model: runtime.sonnetModel, endpoint: '/chat/completions' });
  const r = await chat({ model: runtime.sonnetModel, system, messages: [{ role: 'user', content: user }], agent: 'curator', round, estimate: 0.15, maxTokens: 5000 });
  const d = parseJsonReply(r.text);
  const ids = new Set(images.map(i => i.id));
  const artistIds = new Set(studio.artists.map(a => a.id));
  const clean = v => (typeof v === 'string' ? noDashes(v) : v);
  const alias = { method: 'setup' };
  const spreads = (d.spreads || []).slice(0, n).map((sp, i) => ({
    n: i + 1,
    template: TEMPLATES[alias[sp.template] || sp.template] ? (alias[sp.template] || sp.template) : 'essay',
    title: clean(sp.title || ''), body: clean(sp.body || ''), caption: clean(sp.caption || ''),
    artist: artistIds.has(sp.artist) ? sp.artist : null,
    image: ids.has(sp.image) ? sp.image : null,
    quote: sp.quote?.text ? { speaker: String(sp.quote.speaker || ''), text: clean(sp.quote.text) } : null,
    quotes: (sp.quotes || []).filter(q => q?.text).slice(0, 6).map(q => ({ speaker: String(q.speaker || ''), text: clean(q.text) })),
  }));
  state.zine = { version: (state.zine?.version || 0) + 1, ts: new Date().toISOString(), label, round, note: clean(d.note || ''), spreads };
  saveState();
  log('curator', 'zine.result', { round, response: r.text, model: r.model, endpoint: '/chat/completions', task_id: r.id, cost: r.cost, data: { message: `zine v${state.zine.version}: ${spreads.map(s => s.template).join(', ')}` } });
  return state.zine;
}
