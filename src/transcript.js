/**
 * A rolling, speaker-attributed record of what was said in voice.
 *
 * This is the one thing the bot has that ordinary Discord bots do not: it sits
 * in the channel for hours and knows who said what. Keeping a short window of
 * that makes "what did I miss?" possible.
 *
 * It is deliberately in-memory and time-limited. A permanent recording of
 * everyone's conversations is a different and much heavier thing to own, and
 * nobody in the channel agreed to it.
 */

const RETAIN_MS = Number(process.env.TRANSCRIPT_RETAIN_MIN ?? 120) * 60_000;
const MAX_LINES = Number(process.env.TRANSCRIPT_MAX_LINES ?? 600);

/** guildId -> [{ who, text, at }] */
const logs = new Map();

export const enabled = () => process.env.TRANSCRIPT !== '0';

export function record(guildId, who, text) {
  if (!enabled() || !text?.trim()) return;

  const lines = logs.get(guildId) ?? [];
  lines.push({ who: who ?? 'someone', text: text.trim(), at: Date.now() });

  const cutoff = Date.now() - RETAIN_MS;
  let trimmed = lines.filter((l) => l.at > cutoff);
  if (trimmed.length > MAX_LINES) trimmed = trimmed.slice(-MAX_LINES);
  logs.set(guildId, trimmed);
}

/** Lines from the last `minutes`, oldest first. */
export function since(guildId, minutes) {
  const cutoff = Date.now() - Math.max(1, Number(minutes) || 30) * 60_000;
  return (logs.get(guildId) ?? []).filter((l) => l.at > cutoff);
}

export function search(guildId, query) {
  const words = String(query ?? '').toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return [];
  return (logs.get(guildId) ?? []).filter((l) => {
    const hay = `${l.who} ${l.text}`.toLowerCase();
    return words.every((w) => hay.includes(w));
  });
}

export function clear(guildId) {
  const had = (logs.get(guildId) ?? []).length;
  logs.delete(guildId);
  return had;
}

export const stats = (guildId) => {
  const lines = logs.get(guildId) ?? [];
  return {
    lines: lines.length,
    oldest: lines[0] ? new Date(lines[0].at).toLocaleTimeString() : null,
    retained_minutes: RETAIN_MS / 60_000,
  };
};

const format = (lines) =>
  lines.map((l) => `[${new Date(l.at).toLocaleTimeString()}] ${l.who}: ${l.text}`);
export { format };
