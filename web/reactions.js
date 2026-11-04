// What the one character should do. Every decision is the Yard's (vendor/model.mjs, copied unchanged);
// the only thing added here is folding all of the manager's sessions into the one session it stages.
import { familiarPose, marksFor, nextStagingChange, stagingMode } from './vendor/model.mjs';

// Same id every time, so the character keeps one clip sequence however sessions come and go.
const CREW_ID = 'companion';

const time = (value) => {
  const at = Date.parse(value ?? '');
  return Number.isNaN(at) ? 0 : at;
};
const lastHeard = (session) => time(session.lastOutputAt) || time(session.startedAt) || time(session.createdAt);

/** One session standing for them all: busy if any is busy, with all of their helpers. */
export function mergeSessions(sessions) {
  const running = sessions.filter((session) => session.status === 'running');
  if (!sessions.length) return { id: CREW_ID, status: 'running', activity: 'quiet', lastOutputAt: new Date(0).toISOString(), agents: [], shells: [] };
  if (!running.length) {
    // Everything has ended: show how the last one to end did.
    const last = sessions.reduce((a, b) => (time(b.exitedAt) > time(a.exitedAt) ? b : a));
    return { ...last, id: CREW_ID, agents: [], shells: [] };
  }
  const heard = Math.max(...running.map(lastHeard));
  return {
    id: CREW_ID,
    status: 'running',
    activity: running.some((session) => session.activity === 'active') ? 'active' : 'quiet',
    lastOutputAt: heard ? new Date(heard).toISOString() : null,
    // Ids are only unique within their session.
    agents: running.flatMap((session) => (session.agents ?? []).map((agent) => ({ ...agent, id: `${session.id}:${agent.id}` }))),
    shells: running.flatMap((session) => (session.shells ?? []).map((shell) => ({ ...shell, id: `${session.id}:${shell.id}` }))),
  };
}

/** The Yard's helpersFor (web/yard/renderer.js), which that file does not export. */
export function helpersFor(session) {
  return [
    ...(session.agents ?? []).map((agent) => ({ id: agent.id, name: agent.name, pose: familiarPose(agent), shell: false })),
    // A monitor watches rather than works, so it rests beside the character.
    ...(session.shells ?? []).map((shell) => (shell.kind === 'monitor'
      ? { id: shell.id, name: 'Monitor', pose: 'idle', shell: true }
      : { id: shell.id, name: 'Shell command', pose: 'working', shell: true })),
  ];
}

export function reactionTo(sessions, now) {
  const merged = mergeSessions(sessions);
  const mode = stagingMode(merged, now);
  const marks = marksFor(merged, mode);
  // The Yard marks a crash on the session that crashed; here it must show even while others run.
  const failed = sessions.some((session) => marksFor(session, 'done').crew === 'failed');
  return {
    id: merged.id,
    mode,
    helpers: helpersFor(merged),
    crewMark: failed ? 'failed' : marks.crew,
    helperMarks: marks.helpers,
    nextChange: nextStagingChange([merged], now),
  };
}

/** The manager's event stream, kept as the session list it describes. */
export function applyEvent(sessions, event) {
  if (event.type === 'hello') return new Map(event.sessions.map((session) => [session.id, session]));
  if (event.type === 'disconnected') return new Map();
  const next = new Map(sessions);
  if (event.type === 'session.created' || event.type === 'session.updated') next.set(event.session.id, event.session);
  if (event.type === 'session.removed') next.delete(event.sessionId);
  return next;
}
