import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Type } from '@google/genai';
import * as transcript from './transcript.js';

/**
 * Things the bot has been asked to remember, and reminders to deliver later.
 *
 * Everything is written to disk immediately: a reminder that evaporates when
 * the process restarts is worse than no reminder, because someone is relying
 * on it. Pending reminders are rescheduled on startup, and any that came due
 * while the bot was down are delivered late rather than dropped.
 */

const STORE = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  'memory-store.json',
);

/** How often to check for due reminders. */
const TICK_MS = 20_000;

function load() {
  try {
    const data = JSON.parse(fs.readFileSync(STORE, 'utf8'));
    return Array.isArray(data.entries) ? data : { entries: [] };
  } catch {
    return { entries: [] };
  }
}

function save(db) {
  try {
    fs.writeFileSync(STORE, JSON.stringify(db, null, 2));
  } catch (err) {
    console.error('[memory] could not save:', err.message);
  }
}

let db = load();

const norm = (s) => String(s ?? '').normalize('NFKD').toLowerCase();
const nextId = () => Math.random().toString(36).slice(2, 9);

/* ------------------------------------------------------------------ */
/* Query helpers                                                        */
/* ------------------------------------------------------------------ */

function entriesFor(guildId) {
  return db.entries.filter((e) => e.guildId === guildId);
}

function search(guildId, query) {
  const q = norm(query).split(/\s+/).filter(Boolean);
  if (!q.length) return entriesFor(guildId);
  return entriesFor(guildId).filter((e) => {
    const hay = norm(`${e.content} ${e.about ?? ''} ${e.authorName ?? ''}`);
    return q.every((word) => hay.includes(word));
  });
}

const describe = (e) => ({
  id: e.id,
  remembered: e.content,
  about: e.about ?? undefined,
  saved_by: e.authorName,
  saved_at: new Date(e.createdAt).toLocaleString(),
  reminder_at: e.remindAt ? new Date(e.remindAt).toLocaleString() : undefined,
  reminder_delivered: e.remindAt ? Boolean(e.delivered) : undefined,
});

/* ------------------------------------------------------------------ */
/* Reminder delivery                                                    */
/* ------------------------------------------------------------------ */

let timer = null;

/**
 * Poll for due reminders. Polling rather than one timer per reminder keeps
 * this correct across restarts and avoids setTimeout's 24-day ceiling.
 */
export function startReminderLoop(client, getSession) {
  if (timer) return;

  const tick = async () => {
    const now = Date.now();
    const due = db.entries.filter((e) => e.remindAt && !e.delivered && e.remindAt <= now);
    if (!due.length) return;

    for (const entry of due) {
      entry.delivered = true; // mark first, so a failure can't cause a loop
      try {
        await deliver(client, getSession, entry, now);
      } catch (err) {
        console.error(`[memory] failed to deliver reminder ${entry.id}:`, err.message);
      }
    }
    save(db);
  };

  timer = setInterval(tick, TICK_MS);
  timer.unref?.();
  setTimeout(tick, 2_000).unref?.(); // catch anything missed while offline
}

async function deliver(client, getSession, entry, now) {
  const late = now - entry.remindAt;
  const lateNote = late > 5 * 60_000 ? ` (late by ${Math.round(late / 60_000)} min)` : '';

  const channel = await client.channels.fetch(entry.channelId).catch(() => null);
  const mention = entry.userId ? `<@${entry.userId}>` : '';
  if (channel?.isTextBased()) {
    await channel
      .send(`⏰ ${mention} Reminder: ${entry.content}${lateNote}`.trim().slice(0, 1900))
      .catch(() => {});
  }

  // If a call is live in that guild, say it out loud too.
  const session = getSession(entry.guildId);
  session?.speakAnnouncement(
    `Reminder for ${entry.authorName}: ${entry.content}`,
  );

  console.log(`[memory] delivered reminder ${entry.id}${lateNote}`);
}

/* ------------------------------------------------------------------ */
/* Tools                                                                */
/* ------------------------------------------------------------------ */

export const memoryDeclarations = [
  {
    name: 'get_current_time',
    description:
      'The current date and time on the server. Call this before working out when a ' +
      'reminder like "8 am tomorrow" actually falls.',
    parameters: { type: Type.OBJECT, properties: {} },
  },
  {
    name: 'set_reply_language',
    description:
      'Change which language you reply in. Use when someone says "speak Hindi", ' +
      '"reply in English", "हिंदी में बात करो", or similar.',
    parameters: {
      type: Type.OBJECT,
      properties: {
        language: {
          type: Type.STRING,
          description: 'hindi, english, or auto (mirror whichever they spoke)',
        },
      },
      required: ['language'],
    },
  },
  {
    name: 'remember_this',
    description:
      'Store something for later: a fact, a phone number, a preference, a decision. ' +
      'Use when someone says remember, note, save, or "do not let me forget".',
    parameters: {
      type: Type.OBJECT,
      properties: {
        content: {
          type: Type.STRING,
          description: 'What to remember, written as a complete standalone sentence',
        },
        about: {
          type: Type.STRING,
          description: 'Optional subject, e.g. a person or topic, to make recall easier',
        },
      },
      required: ['content'],
    },
  },
  {
    name: 'set_reminder',
    description:
      'Remember something AND say it out loud at a given time. Give either in_minutes ' +
      'for relative times ("in an hour") or at_iso for clock times — call get_current_time ' +
      'first so you compute the right day.',
    parameters: {
      type: Type.OBJECT,
      properties: {
        content: { type: Type.STRING, description: 'What to remind them about' },
        in_minutes: { type: Type.NUMBER, description: 'Minutes from now' },
        at_iso: {
          type: Type.STRING,
          description: 'Absolute local time as ISO 8601, e.g. 2026-08-03T08:00:00',
        },
      },
      required: ['content'],
    },
  },
  {
    name: 'recall_memory',
    description:
      "Look up what YOU remembered for the person now speaking. Their notes are private " +
      'to them. Omit the query to list their recent ones.',
    parameters: {
      type: Type.OBJECT,
      properties: {
        query: { type: Type.STRING, description: 'Words to search for, e.g. a name or topic' },
      },
    },
  },
  {
    name: 'catch_up',
    description:
      'Summarise what was said in the voice channel recently. Use for "what did I miss", ' +
      '"what happened", "what did we decide". You get the raw lines with names and times — ' +
      'read them and give a short spoken summary of what actually matters.',
    parameters: {
      type: Type.OBJECT,
      properties: {
        minutes: { type: Type.NUMBER, description: 'How far back to look, default 30' },
      },
    },
  },
  {
    name: 'search_conversation',
    description:
      'Find where something was mentioned in the recent voice conversation — a name, a ' +
      'topic, a decision. Use for "did anyone mention X" or "what did Rock say about Y".',
    parameters: {
      type: Type.OBJECT,
      properties: {
        query: { type: Type.STRING, description: 'Words to look for' },
      },
      required: ['query'],
    },
  },
  {
    name: 'forget_memory',
    description: 'Delete a remembered item. Confirm which one before calling this.',
    parameters: {
      type: Type.OBJECT,
      properties: {
        query: { type: Type.STRING, description: 'Words identifying the item to delete' },
      },
      required: ['query'],
    },
  },
];

export const memoryHandlers = {
  get_current_time() {
    const now = new Date();
    return {
      iso: now.toISOString(),
      local: now.toLocaleString(),
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    };
  },

  /**
   * Switching language is only a change of instruction, so it takes effect on
   * the next reply without reconnecting.
   */
  set_reply_language(ctx, { language }) {
    const want = String(language ?? '').trim().toLowerCase();
    const choice = ['hindi', 'english', 'auto'].find((l) => want.includes(l));
    if (!choice) throw new Error('I can reply in Hindi, English, or auto.');

    ctx.session?.setReplyLanguage(choice);
    return {
      done:
        choice === 'auto'
          ? 'Replying in whichever of Hindi or English is spoken to me'
          : `Replying in ${choice} from now on`,
    };
  },

  remember_this(ctx, { content, about }) {
    if (!content?.trim()) throw new Error('There is nothing to remember.');
    const entry = {
      id: nextId(),
      guildId: ctx.guild.id,
      channelId: ctx.textChannel?.id ?? null,
      userId: ctx.requester?.id ?? null,
      authorName: ctx.requester?.displayName ?? 'someone',
      content: content.trim(),
      about: about?.trim() || null,
      createdAt: Date.now(),
      remindAt: null,
      delivered: false,
    };
    db.entries.push(entry);
    save(db);
    return { done: `Remembered: ${entry.content}` };
  },

  set_reminder(ctx, { content, in_minutes, at_iso }) {
    if (!content?.trim()) throw new Error('There is nothing to remind you about.');

    let remindAt;
    if (Number.isFinite(Number(in_minutes)) && in_minutes !== undefined && in_minutes !== null) {
      const mins = Number(in_minutes);
      if (mins <= 0) throw new Error('That time is in the past.');
      remindAt = Date.now() + mins * 60_000;
    } else if (at_iso) {
      remindAt = new Date(at_iso).getTime();
      if (Number.isNaN(remindAt)) throw new Error(`I couldn't read the time "${at_iso}".`);
      if (remindAt <= Date.now()) {
        throw new Error(
          `${new Date(remindAt).toLocaleString()} has already passed — did you mean tomorrow?`,
        );
      }
    } else {
      throw new Error('Tell me when: either in_minutes or at_iso.');
    }

    if (remindAt - Date.now() > 365 * 24 * 60 * 60_000) {
      throw new Error("That's more than a year away — I won't hold it that long.");
    }

    const entry = {
      id: nextId(),
      guildId: ctx.guild.id,
      channelId: ctx.textChannel?.id ?? null,
      userId: ctx.requester?.id ?? null,
      authorName: ctx.requester?.displayName ?? 'someone',
      content: content.trim(),
      about: null,
      createdAt: Date.now(),
      remindAt,
      delivered: false,
    };
    db.entries.push(entry);
    save(db);
    return { done: `Reminder set for ${new Date(remindAt).toLocaleString()}: ${entry.content}` };
  },

  /**
   * Only ever returns the speaker's own notes.
   *
   * Several people share this bot and the same voice channel, so a shared pool
   * would read one person's saved phone number out loud to whoever asked next.
   * Private by default is the only sane setting.
   */
  recall_memory(ctx, { query }) {
    if (!ctx.requester) throw new Error("I can't tell who is asking, so I won't read anything out.");

    const found = search(ctx.guild.id, query)
      .filter((e) => e.userId === ctx.requester.id)
      .sort((a, b) => b.createdAt - a.createdAt)
      .slice(0, 15);

    if (!found.length) {
      return {
        memories: [],
        note: query
          ? `Nothing of ${ctx.requester.displayName}'s about "${query}".`
          : `${ctx.requester.displayName} hasn't asked me to remember anything yet.`,
      };
    }
    return { memories: found.map(describe), whose: ctx.requester.displayName };
  },

  catch_up(ctx, { minutes }) {
    if (!transcript.enabled()) throw new Error('Conversation history is turned off.');
    const window = Math.min(Math.max(Number(minutes) || 30, 1), 180);
    const lines = transcript.since(ctx.guild.id, window);
    if (!lines.length) {
      return { note: `Nothing was said in the last ${window} minutes that I heard.` };
    }
    return {
      window_minutes: window,
      speakers: [...new Set(lines.map((l) => l.who))],
      conversation: transcript.format(lines).slice(-120),
      instruction:
        'Summarise this out loud in a few sentences: what was discussed, anything decided, ' +
        'and anything aimed at the person asking. Skip small talk.',
    };
  },

  search_conversation(ctx, { query }) {
    if (!transcript.enabled()) throw new Error('Conversation history is turned off.');
    const hits = transcript.search(ctx.guild.id, query);
    if (!hits.length) return { found: 0, note: `Nobody mentioned "${query}" recently.` };
    return { found: hits.length, lines: transcript.format(hits).slice(-25) };
  },

  forget_memory(ctx, { query }) {
    const found = search(ctx.guild.id, query).filter((e) => e.userId === ctx.requester?.id);
    if (!found.length) throw new Error(`You have nothing saved matching "${query}".`);
    if (found.length > 1) {
      throw new Error(
        `That matches ${found.length} items: ${found
          .map((e) => `"${e.content}"`)
          .slice(0, 5)
          .join('; ')}. Be more specific.`,
      );
    }
    db.entries = db.entries.filter((e) => e.id !== found[0].id);
    save(db);
    return { done: `Forgot: ${found[0].content}` };
  },
};

/** Test seam — lets a test point the store somewhere disposable. */
export function _resetForTests(entries = []) {
  db = { entries };
}
