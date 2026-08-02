import {
  joinVoiceChannel,
  createAudioPlayer,
  createAudioResource,
  entersState,
  EndBehaviorType,
  StreamType,
  VoiceConnectionStatus,
  NoSubscriberBehavior,
} from '@discordjs/voice';
import prism from 'prism-media';
import { EmbedBuilder } from 'discord.js';

import { GeminiLiveSession } from './gemini-live.js';
import {
  SpeakerStream,
  SpeechGate,
  pcm48StereoTo16Mono,
  pcm24MonoTo48Stereo,
} from './audio.js';
import { moderationDeclarations, executeTool, autoMute } from './moderation-tools.js';
import { ProfanityGuard } from './profanity-guard.js';
import { MusicPlayer } from './music.js';

/**
 * How long a user must be quiet before we treat their turn as finished.
 *
 * This is pure added latency on every single reply: nothing is sent onward
 * until Discord ends the subscription. Too low and a pause mid-sentence splits
 * the turn; 300 ms is about the shortest that still survives normal speech.
 */
const SILENCE_MS = Number(process.env.TURN_SILENCE_MS ?? 300);

/** Speech gate tuning — raise the threshold in a noisy room. */
const GATE = {
  threshold: Number(process.env.NOISE_GATE_RMS ?? 500),
  minSpeechMs: Number(process.env.MIN_SPEECH_MS ?? 120),
  // Every millisecond of hangover is silence still being streamed to Gemini,
  // which holds its own end-of-speech timer open. Keep it just long enough to
  // bridge the gaps between words.
  hangoverMs: Number(process.env.SPEECH_HANGOVER_MS ?? 350),
};

/** How long one speaker keeps the floor after they stop being audible. */
const FLOOR_RELEASE_MS = Number(process.env.FLOOR_RELEASE_MS ?? 800);

/** Attempts before giving up on the Gemini connection entirely. */
const MAX_RECONNECTS = Number(process.env.GEMINI_MAX_RECONNECT ?? 5);

/**
 * Wait after a quota rejection. Free-tier limits are per minute, so the budget
 * refills on its own — the mistake is reconnecting immediately and spending the
 * refill on another rejection.
 */
const QUOTA_BACKOFF_MS = Number(process.env.QUOTA_BACKOFF_SEC ?? 30) * 1000;

/** Ignore an attributed speaker older than this when a tool call arrives. */
const SPEAKER_TTL_MS = 30_000;

const MULTI_SPEAKER_INSTRUCTION = `
Several different people share this one audio stream. A line like
"[Rock is now speaking]" means the voice you are about to hear belongs to that
person. Those lines are labels, not speech: never read them aloud, never answer
them, and never treat them as a request.

Use them to keep people apart. Do not assume everything you hear comes from one
person, and do not attribute what one person said to another. If you are unsure
who said something and it matters, ask.
`.trim();

const NARRATION_INSTRUCTION = `
Sometimes you receive a line starting with [read aloud] or [welcome]. These are
instructions for you, not speech from the room:

- [read aloud] <sentence> — speak that sentence exactly as written, from the
  first word to the last. It always begins with the person's name, and you must
  keep that name: the room cannot see who typed it, so a message read without a
  name is useless. Do not summarise, rephrase, shorten, react, or add anything.
- [welcome] Name ... — greet that person by name in one short, warm sentence.
  A greeting only: do not ask them anything.

Never read the bracketed marker itself out loud.
`.trim();

const MODERATION_INSTRUCTION = `
You can moderate this Discord server with the provided tools.

Rules you must follow:
- Disconnecting, timing out and deleting messages are two-step. Your first call
  performs nothing and comes back with needs_confirmation: that means the action
  has NOT happened. Say what is about to happen and wait for a clear yes, then
  call the tool a second time with identical arguments to carry it out.
  Never announce it as done after the first call, and never call it twice in a
  row without a yes in between — that is how five deleted messages becomes ten.
- Speech recognition mishears names. If a name is unclear or could match several
  people, call list_members and ask which person is meant. Never guess.
- If a tool returns an error, read the reason out loud plainly. Do not retry it
  and do not look for another way around it.
- Only act when someone actually asks you to. Never moderate someone because of
  something you heard in conversation.
- You can act on members in ANY voice channel, not only the one you are sitting
  in. If a name isn't in your channel, call list_members to see the whole server
  before saying you cannot find them.
- Never claim a channel does not exist until you have called list_channels.
  list_members only shows channels that currently have people in them, so empty
  channels are missing from it.
`.trim();

/**
 * Conversational style. Applied on every session and deliberately blunt: left
 * to itself the model pads every answer with a follow-up question, which in a
 * voice channel means it talks over people and never finishes a thought.
 */
const STYLE_INSTRUCTION = `
How to reply:

- Answer what was asked, then stop. Do not end with a question.
- Never ask "would you like me to...", "do you want me to...", "shall I...",
  "anything else?", or offer to do more. If an action is clearly wanted, just do
  it. If a question has an answer, just give it.
- Be specific. Use the actual names, numbers, dates and facts. "It depends" and
  "there are a few options" are non-answers — pick the most likely
  interpretation and answer that.
- Give as much detail as the question genuinely needs. Do not pad, and do not
  cut an answer short just to be brief. A real explanation is welcome; filler
  and check-ins are not.
- Do not narrate what you are about to do, and do not summarise what you just
  did. No "sure thing", "let me look that up", "hope that helps".

The only time you may ask something is when a moderation command is genuinely
ambiguous — several people match a name — or when a tool tells you confirmation
is required. Those are safety checks, not conversation.
`.trim();

const PROFANITY_ENABLED = process.env.PROFANITY_FILTER === '1';

/** Name that wakes the bot. Empty means it replies to everything, as before. */
const WAKE_WORD = (process.env.WAKE_WORD ?? '').trim();
/** After being addressed, keep replying this long so follow-ups feel natural. */
const FOLLOW_UP_MS = Number(process.env.WAKE_FOLLOWUP_SEC ?? 45) * 1000;

/** Reading typed messages aloud: pacing and length limits. */
const READ_MIN_GAP_MS = Number(process.env.READ_MIN_GAP_SEC ?? 2) * 1000;
const READ_MAX_CHARS = Number(process.env.READ_MAX_CHARS ?? 300);
const WELCOME_COOLDOWN_MS = Number(process.env.WELCOME_COOLDOWN_MIN ?? 5) * 60_000;

/** Google Search grounding. On by default: it needs no extra key or quota. */
const WEB_SEARCH = process.env.WEB_SEARCH !== '0';

const SEARCH_INSTRUCTION = `
You can search the web. Use it whenever someone asks you to look something up,
or asks about news, prices, releases, scores, or anything that changes over
time. Do not guess at those from memory.

Out loud, give the actual findings — the specific facts, numbers and names you
found, not a description of what you searched for. The full written answer and
its sources are posted to the text channel automatically, so do not read out
URLs or recite a list of links, and do not ask whether they want more detail.
`.trim();

const PROACTIVE = process.env.PROACTIVE_ACTIVITY === '1';
const ACTIVITY_COOLDOWN_MS = Number(process.env.ACTIVITY_COOLDOWN_MIN ?? 10) * 60_000;

/**
 * Identity of an activity for change detection.
 *
 * Music needs the track in the key: `activity.name` is the literal string
 * "Spotify" for every song, so keying on the name alone means a listener who
 * never closes Spotify looks permanently unchanged and never triggers anything.
 */
export function activityKey(a) {
  return a.type === 2 ? `${a.name}:${a.details ?? ''}:${a.state ?? ''}` : a.name;
}

const fold = (s) =>
  String(s ?? '').normalize('NFKD').toLowerCase().replace(/[^a-z0-9 ]/g, ' ');

/** Did this utterance address the bot by name? Tolerates one misheard letter. */
function mentionsWakeWord(text, wake) {
  const want = fold(wake).trim();
  if (!want) return false;
  const haystack = fold(text);
  if (haystack.includes(want)) return true;

  // Compare word by word so "Kamia"/"Camiya" still count.
  const target = want.replace(/ /g, '');
  return haystack.split(/\s+/).some((tok) => {
    if (!tok || Math.abs(tok.length - target.length) > 1) return false;
    let edits = 0, i = 0, j = 0;
    while (i < tok.length && j < target.length) {
      if (tok[i] === target[j]) { i++; j++; continue; }
      if (++edits > 1) return false;
      if (tok.length > target.length) i++;
      else if (tok.length < target.length) j++;
      else { i++; j++; }
    }
    return edits + (tok.length - i) + (target.length - j) <= 1;
  });
}

const sessions = new Map(); // guildId -> VoiceSession

export function getSession(guildId) {
  return sessions.get(guildId);
}

export async function startSession(voiceChannel, textChannel) {
  await stopSession(voiceChannel.guild.id);
  const session = new VoiceSession(voiceChannel, textChannel);
  sessions.set(voiceChannel.guild.id, session);
  try {
    await session.start();
  } catch (err) {
    sessions.delete(voiceChannel.guild.id);
    session.destroy();
    throw err;
  }
  return session;
}

export async function stopSession(guildId) {
  const session = sessions.get(guildId);
  if (!session) return false;
  sessions.delete(guildId);
  session.destroy();
  return true;
}

class VoiceSession {
  #speakers = new Set(); // user ids currently streaming into Gemini
  #transcript = { user: '', model: '' };
  #lastSpeaker = null; // { id, at } — who a tool call is attributed to
  #turnSpeakers = new Set(); // everyone who spoke during the current turn
  #guard = PROFANITY_ENABLED ? new ProfanityGuard() : null;
  #respondUntil = 0; // replies are played while now() is below this
  #floor = null; // { userId, at } — whose audio is currently being forwarded
  #labelled = null; // userId we last announced to the model
  #lastActivityPing = new Map(); // userId -> when we last commented on them
  #lastWelcome = new Map(); // userId -> when we last greeted them
  #lastRead = 0; // when we last read a typed message aloud
  #grounding = null; // search sources for the turn in progress
  #resumeHandle = null; // lets a new socket continue the same conversation
  #reconnecting = false;
  #closing = false; // set by destroy(), so a deliberate close isn't retried

  constructor(voiceChannel, textChannel) {
    this.voiceChannel = voiceChannel;
    this.textChannel = textChannel;
    this.connection = null;
    this.player = null;
    this.speaker = null;
    this.gemini = null;
  }

  async start() {
    this.connection = joinVoiceChannel({
      channelId: this.voiceChannel.id,
      guildId: this.voiceChannel.guild.id,
      adapterCreator: this.voiceChannel.guild.voiceAdapterCreator,
      selfDeaf: false, // we need to hear people
      selfMute: false,
      // DAVE (Discord's end-to-end encryption) stays ON: turning it off makes
      // the voice gateway refuse the connection outright. Its decrypt path can
      // still throw "UnencryptedWhenPassthroughDisabled" from a UDP callback,
      // so the tolerance is raised well above the default 36 and index.js
      // survives the throw if it ever gets through.
      daveEncryption: process.env.DAVE_ENCRYPTION !== '0',
      decryptionFailureTolerance: 10_000,
    });

    // Set DEBUG_VOICE=1 to trace the handshake. Networking codes:
    // 0 OpeningWs -> 1 Identifying -> 2 UdpHandshaking -> 3 SelectingProtocol -> 4 Ready.
    // Stalling at 1 means Discord dropped the voice websocket; at 2 means UDP is blocked.
    if (process.env.DEBUG_VOICE) {
      this.connection.on('stateChange', (oldState, newState) => {
        console.log(`[voice] ${oldState.status} -> ${newState.status}`);
        const net = newState.networking;
        if (net && net !== oldState.networking) {
          net.on('stateChange', (o, n) => {
            console.log(`[voice:net] ${o.code} -> ${n.code}`);
            if (n.ws && n.ws !== o.ws) {
              n.ws.on('close', (e) =>
                console.error(`[voice:ws] closed code=${e?.code} reason=${e?.reason || '(none)'}`),
              );
            }
          });
          net.on('error', (err) => console.error('[voice:net] error', err));
        }
      });
    }
    this.connection.on('error', (err) => console.error('[voice] error', err));

    try {
      await entersState(this.connection, VoiceConnectionStatus.Ready, 20_000);
    } catch {
      throw new Error(
        'Could not establish the voice connection (it never became Ready). ' +
          'Usually a firewall blocking outbound UDP, or missing Connect/Speak permission.',
      );
    }

    this.speaker = new SpeakerStream();
    this.music = new MusicPlayer(this.speaker);
    this.player = createAudioPlayer({
      behaviors: { noSubscriber: NoSubscriberBehavior.Play },
    });
    this.player.play(
      createAudioResource(this.speaker, { inputType: StreamType.Raw }),
    );
    this.connection.subscribe(this.player);

    try {
      await this.#connectGemini();
    } catch (err) {
      throw new Error(`Gemini refused the live connection: ${err?.message ?? err}`);
    }

    this.connection.receiver.speaking.on('start', (userId) => this.#listenTo(userId));

    // Give the greeting a moment so it doesn't collide with the join message.
    setTimeout(() => this.#noticeExistingActivities(), 3_000).unref?.();

    this.connection.on(VoiceConnectionStatus.Disconnected, async () => {
      try {
        await Promise.race([
          entersState(this.connection, VoiceConnectionStatus.Signalling, 5_000),
          entersState(this.connection, VoiceConnectionStatus.Connecting, 5_000),
        ]);
      } catch {
        await stopSession(this.voiceChannel.guild.id);
      }
    });
  }

  #instructions() {
    // Style comes first so it frames everything that follows.
    const parts = [STYLE_INSTRUCTION, MULTI_SPEAKER_INSTRUCTION, NARRATION_INSTRUCTION, MODERATION_INSTRUCTION];
    if (WEB_SEARCH) parts.push(SEARCH_INSTRUCTION);
    if (WAKE_WORD) {
      parts.push(
        `Your name is "${WAKE_WORD}". Several people share this channel and most ` +
          'of what you hear is them talking to each other, not to you. Reply only ' +
          'when someone says your name or is clearly continuing a conversation with ' +
          'you. Otherwise say nothing at all — silence is the correct response.',
      );
    }
    return parts.join('\n\n');
  }

  /** Open a Live session, resuming the previous conversation when possible. */
  async #connectGemini() {
    this.gemini = new GeminiLiveSession({
      functionDeclarations: moderationDeclarations,
      extraInstruction: this.#instructions(),
      resumeHandle: this.#resumeHandle,
      enableSearch: WEB_SEARCH,
    });
    this.#wireGemini();
    await this.gemini.connect(this.#resumeHandle);

    // A new socket means the model has not been told who is talking yet.
    this.#labelled = null;
    this.#transcript = { user: '', model: '' };
  }

  /**
   * Live sessions expire after about ten minutes. Rather than ending the call,
   * open a new one from the last resumption handle so the conversation carries
   * over — the voice connection and playback stream are untouched, so from the
   * channel's point of view nothing happened.
   */
  async #reconnect(reason, immediate = false) {
    if (this.#reconnecting || this.#closing) return;
    this.#reconnecting = true;
    console.warn(`[gemini] reconnecting: ${reason}`);

    // A quota close is a rate limit, not a broken socket. Reconnecting a second
    // later just trips the same per-minute limit and burns the retry budget, so
    // wait out the window instead.
    const rateLimited = /quota|exceeded|RESOURCE_EXHAUSTED|429/i.test(reason ?? '');
    if (rateLimited) {
      console.warn(`[gemini] rate limited — waiting ${QUOTA_BACKOFF_MS / 1000}s before reconnecting`);
      this.textChannel
        ?.send(`⏳ Hit Gemini's per-minute limit. Reconnecting in ${QUOTA_BACKOFF_MS / 1000}s…`)
        .catch(() => {});
    }

    for (let attempt = 1; attempt <= MAX_RECONNECTS; attempt++) {
      const wait = rateLimited
        ? QUOTA_BACKOFF_MS * attempt
        : immediate && attempt === 1
          ? 0
          : Math.min(1000 * 2 ** (attempt - 1), 15_000);
      if (wait) await new Promise((r) => setTimeout(r, wait));
      if (this.#closing) return;

      try {
        this.gemini?.close();
        await this.#connectGemini();
        console.log(
          `[gemini] reconnected on attempt ${attempt}` +
            (this.#resumeHandle ? ' (conversation resumed)' : ' (fresh conversation)'),
        );
        this.#reconnecting = false;
        return;
      } catch (err) {
        console.warn(`[gemini] reconnect attempt ${attempt} failed: ${err?.message ?? err}`);
        // A rejected handle is worse than none — drop it and start clean.
        if (/handle|resum/i.test(err?.message ?? '')) this.#resumeHandle = null;
      }
    }

    this.#reconnecting = false;
    this.textChannel
      ?.send(`⚠️ Lost the Gemini connection and couldn't get it back. Run \`/join\` again.`)
      .catch(() => {});
    stopSession(this.voiceChannel.guild.id);
  }

  /** Should the bot be heard right now? */
  get #awake() {
    return !WAKE_WORD || Date.now() < this.#respondUntil;
  }

  /** Let the bot speak for this exchange and any quick follow-up. */
  #wake() {
    this.#respondUntil = Date.now() + FOLLOW_UP_MS;
  }

  #wireGemini() {
    // Bind to this specific session object. After a reconnect the old socket
    // can still emit — its close event in particular — and without this check
    // that stale event would tear down the healthy session that replaced it.
    const g = this.gemini;
    const stale = () => this.gemini !== g;

    this.gemini.on('audio', (pcm24) => {
      if (stale()) return;
      // Gemini answers everything it hears; when it wasn't addressed we simply
      // never play the reply. The audio is already generated either way — this
      // gates the room, not the API usage.
      if (!this.#awake) return;
      this.speaker.write(pcm24MonoTo48Stereo(pcm24));
    });

    this.gemini.on('interrupted', () => this.speaker.clear());

    this.gemini.on('text', (chunk, who) => {
      if (stale()) return;
      this.#transcript[who] += chunk;
      // Check as the transcript streams in, so the decision is made before the
      // model's audio arrives.
      if (who === 'user' && WAKE_WORD && mentionsWakeWord(this.#transcript.user, WAKE_WORD)) {
        this.#wake();
      }
    });

    this.gemini.on('turnComplete', () => {
      const { user, model } = this.#transcript;
      this.#transcript = { user: '', model: '' };

      const spokeThisTurn = [...this.#turnSpeakers];
      this.#turnSpeakers.clear();
      if (this.#guard && user.trim()) this.#checkLanguage(user, spokeThisTurn);

      const heard = this.#awake;
      if (!heard) this.speaker.clear(); // drop anything that slipped through

      const grounding = this.#grounding;
      this.#grounding = null;

      if (!this.textChannel) return;

      // A searched answer gets its own post with citations, since the whole
      // point is to leave something readable behind in the channel.
      if (grounding && heard && model.trim()) {
        this.#postSearchResult(user, model, grounding);
        return;
      }

      const lines = [];
      if (user.trim()) lines.push(`🗣️ **You:** ${user.trim()}`);
      if (heard && model.trim()) lines.push(`🤖 **Gemini:** ${model.trim()}`);
      if (lines.length) {
        this.textChannel.send(lines.join('\n').slice(0, 1900)).catch(() => {});
      }
    });

    this.gemini.on('toolCall', (calls) => {
      if (stale()) return;
      this.#runTools(calls);
    });

    this.gemini.on('error', (err) => console.error('[gemini]', err));

    this.gemini.on('grounding', (info) => {
      if (stale()) return;
      // Arrives mid-turn; held until turnComplete so the answer and its
      // sources can be posted as one message.
      this.#grounding = info;
    });

    // Keep the newest handle so a reconnect can resume this conversation.
    this.gemini.on('resumable', (handle) => {
      if (stale()) return;
      this.#resumeHandle = handle;
    });

    // The server warns before it drops the socket; get ahead of it so the gap
    // falls in a moment of silence rather than mid-sentence.
    this.gemini.on('goAway', (timeLeft) => {
      if (stale()) return;
      console.log(`[gemini] server going away${timeLeft ? ` in ${timeLeft}` : ''}`);
      this.#reconnect('server announced shutdown', true);
    });

    this.gemini.on('closed', (reason) => {
      if (this.#closing || stale()) return; // deliberate, or an old socket
      this.#reconnect(`socket closed (${reason})`);
    });
  }

  /**
   * Everyone shares one Gemini session, so the model can't tell us who asked.
   * We attribute a tool call to whoever most recently spoke, and refuse to act
   * if that attribution is stale — better a refusal than moderating on behalf
   * of the wrong person.
   */
  async #requester() {
    const last = this.#lastSpeaker;
    if (!last || Date.now() - last.at > SPEAKER_TTL_MS) return null;

    const cached = this.voiceChannel.members.get(last.id);
    if (cached) return cached;
    try {
      return await this.voiceChannel.guild.members.fetch(last.id);
    } catch {
      return null;
    }
  }

  /**
   * Escalating profanity enforcement. Nobody reviews an automatic punishment,
   * so this only fires when exactly one person spoke during the turn — with
   * overlapping voices the transcript cannot be safely attributed, and muting
   * the wrong person is worse than missing one.
   */
  async #checkLanguage(transcript, spokeThisTurn) {
    if (spokeThisTurn.length !== 1) {
      const hits = this.#guard.findHits(transcript);
      if (hits.length) {
        console.log(`[guard] skipped — ${spokeThisTurn.length} speakers overlapped, can't attribute`);
      }
      return;
    }

    const member = this.voiceChannel.members.get(spokeThisTurn[0]);
    if (!member) return;

    const verdict = this.#guard.evaluate(member.id, transcript);
    if (!verdict) return;

    console.log(`[guard] ${member.user.tag} strike ${verdict.count} -> ${verdict.action}`);

    if (verdict.action === 'warn') {
      this.gemini.sendText(
        `[automated notice] ${member.displayName} used inappropriate language. ` +
          'Warn them briefly and firmly that repeating it will get them muted. Do not repeat the word.',
      );
      this.textChannel
        ?.send(`⚠️ **${member.displayName}** warned for language (strike 1).`)
        .catch(() => {});
      return;
    }

    const minutes = Math.round(this.#guard.muteMs / 60_000);
    try {
      const { dryRun } = await autoMute(
        member,
        this.#guard.muteMs,
        `Repeated inappropriate language (strike ${verdict.count})`,
      );
      this.gemini.sendText(
        `[automated notice] ${member.displayName} was warned already and did it again, ` +
          `so they have been muted for ${minutes} minutes. Say so briefly. Do not repeat the word.`,
      );
      this.textChannel
        ?.send(
          `🔇 **${member.displayName}** muted for ${minutes} min — strike ${verdict.count}.` +
            (dryRun ? ' *(dry run — not actually muted)*' : ''),
        )
        .catch(() => {});
    } catch (err) {
      console.warn(`[guard] could not mute ${member.user.tag}: ${err.message}`);
      this.textChannel
        ?.send(`⚠️ Wanted to mute **${member.displayName}** but couldn't: ${err.message}`)
        .catch(() => {});
    }
  }

  /**
   * Speak a message that was typed in the channel, for people whose hands are
   * busy gaming.
   */
  speakMessage(message) {
    if (!this.gemini) return;

    // Anything the bot itself posts — transcripts, moderation notes, image
    // embeds — lands in this same channel. Reading those would have it talking
    // to itself in a loop.
    if (message.author.bot || message.system) return;
    if (message.channelId !== this.textChannel?.id) return;

    const text = message.cleanContent?.trim();
    if (!text) return; // attachment or embed only, nothing to read

    const now = Date.now();
    if (now - this.#lastRead < READ_MIN_GAP_MS) {
      if (process.env.DEBUG_READ) console.log('[read] skipped, too soon after the last one');
      return;
    }
    this.#lastRead = now;

    const name = message.member?.displayName ?? message.author.username;
    const trimmed = text.length > READ_MAX_CHARS ? `${text.slice(0, READ_MAX_CHARS)}…` : text;
    // Quotes in the message would close the quoted span early and blur where
    // the person's words start and end.
    const body = trimmed.replace(/["""]/g, "'");

    // Hand over the finished sentence rather than a description of one. Asking
    // the model to "say their name, then the message" leaves it free to decide
    // the name is redundant, and it drops it.
    const line = `${name} said: ${body}`;

    if (process.env.DEBUG_READ) console.log(`[read] ${line}`);
    this.#wake(); // the bot is relaying, so it may be heard
    this.gemini.sendText(`[read aloud] ${line}`);
  }

  /** Post a searched answer with the sources it was drawn from. */
  #postSearchResult(question, answer, { sources, queries }) {
    const embed = new EmbedBuilder()
      .setColor('#4285f4')
      .setTitle('🔎 ' + (queries[0] ?? question.trim() ?? 'Search').slice(0, 250))
      .setDescription(answer.trim().slice(0, 4000));

    // De-duplicate by URL: the same page is often cited several times.
    const seen = new Set();
    const cited = sources.filter((s) => !seen.has(s.uri) && seen.add(s.uri)).slice(0, 5);
    if (cited.length) {
      embed.addFields({
        name: 'Sources',
        value: cited
          .map((s, i) => `${i + 1}. [${s.title.slice(0, 70)}](${s.uri})`)
          .join('\n')
          .slice(0, 1024),
      });
    }
    if (queries.length) {
      embed.setFooter({ text: `searched: ${queries.join(' • ')}`.slice(0, 2048) });
    }

    console.log(`[search] ${queries.join(', ') || '(no query reported)'} -> ${cited.length} sources`);
    this.textChannel.send({ embeds: [embed] }).catch(() => {});
  }

  /**
   * Say something the bot initiated — a due reminder, for instance. Bypasses
   * the wake word, since nobody is going to address the bot about a reminder
   * they have forgotten.
   */
  speakAnnouncement(line) {
    if (!this.gemini || !line) return;
    this.#wake();
    this.gemini.sendText(`[read aloud] ${String(line).replace(/["""]/g, "'")}`);
  }

  /** Greet someone who just arrived. */
  welcome(member, { joinedServer = false } = {}) {
    if (!this.gemini || member.user.bot) return;

    const last = this.#lastWelcome.get(member.id) ?? 0;
    if (Date.now() - last < WELCOME_COOLDOWN_MS) return;
    this.#lastWelcome.set(member.id, Date.now());

    console.log(`[welcome] ${member.user.tag}${joinedServer ? ' (new to the server)' : ''}`);
    this.#wake();
    this.gemini.sendText(
      joinedServer
        ? `[welcome] ${member.displayName} just joined the server for the first time. ` +
          'Greet them in one warm sentence. Do not ask them anything.'
        : `[welcome] ${member.displayName} just joined the voice channel. ` +
          'Say hello in one short sentence. Do not ask them anything.',
    );
  }

  /**
   * Someone may already have been gaming or playing music long before the bot
   * arrived — there is no presence *change* to react to in that case, so look
   * once at what is already happening.
   */
  #noticeExistingActivities() {
    if (!PROACTIVE) return;
    for (const member of this.voiceChannel.members.values()) {
      if (member.user.bot) continue;
      const activity = member.presence?.activities?.find((a) => a.type !== 4);
      if (!activity) continue;
      if (process.env.DEBUG_ACTIVITY) {
        console.log(`[activity] on join: ${member.user.tag} is ${activity.name}`);
      }
      this.notePresenceChange(member, activity);
      return; // one remark on arrival is plenty
    }
    if (process.env.DEBUG_ACTIVITY) {
      console.log('[activity] on join: nobody has a visible activity');
    }
  }

  /**
   * Someone in the channel started doing something. Offer it to the model as
   * context and let it decide whether saying anything is natural — a bot that
   * announces every presence change is a bot people mute.
   */
  notePresenceChange(member, activity) {
    if (!PROACTIVE || !this.gemini) return;
    if (!this.voiceChannel.members.has(member.id)) {
      if (process.env.DEBUG_ACTIVITY) {
        console.log(`[activity] ignored ${member.user.tag}: not in my voice channel`);
      }
      return;
    }

    const last = this.#lastActivityPing.get(member.id) ?? 0;
    if (Date.now() - last < ACTIVITY_COOLDOWN_MS) {
      if (process.env.DEBUG_ACTIVITY) {
        const wait = Math.ceil((ACTIVITY_COOLDOWN_MS - (Date.now() - last)) / 60_000);
        console.log(`[activity] ignored ${member.user.tag}: cooldown, ~${wait} min left`);
      }
      return;
    }
    this.#lastActivityPing.set(member.id, Date.now());

    const what =
      activity.type === 2
        ? `listening to "${activity.details ?? activity.name}"` +
          (activity.state ? ` by ${activity.state}` : '')
        : activity.type === 1
          ? `streaming ${activity.name}`
          : `playing ${activity.name}`;

    console.log(`[activity] ${member.user.tag} -> ${what}`);
    // Speaking here is the bot's own initiative, so allow it to be heard.
    this.#wake();
    this.gemini.sendText(
      `[context] ${member.displayName} just started ${what}. If it fits the moment, make ` +
        'one short, casual remark about it — a statement, not a question. If the room is ' +
        'mid-conversation, stay quiet and reply with nothing at all.',
    );
  }

  async #runTools(calls) {
    const requester = await this.#requester();
    const ctx = {
      guild: this.voiceChannel.guild,
      voiceChannel: this.voiceChannel,
      textChannel: this.textChannel,
      requester,
      presenceEnabled: process.env.ENABLE_PRESENCE === '1',
      session: this, // music tools need the player attached to this session
    };

    const responses = [];
    for (const call of calls) {
      const response = await executeTool(call.name, call.args, ctx);
      responses.push({ id: call.id, name: call.name, response });

      // Leave a written trail: voice moderation is otherwise invisible.
      // Lookups and image posts speak for themselves and are skipped.
      const QUIET = [
        'list_members', 'list_channels', 'list_waifu_tags', 'send_waifu_image',
        'get_current_time', 'recall_memory',
      ];
      if (this.textChannel && !QUIET.includes(call.name)) {
        const who = requester?.displayName ?? 'unknown speaker';
        const line = response.error
          ? `🚫 **${who}** → \`${call.name}\` refused: ${response.error}`
          : `🛡️ **${who}** → ${response.done}`;
        this.textChannel.send(line.slice(0, 1900)).catch(() => {});
      }
    }

    this.gemini.sendToolResponse(responses);
  }

  #listenTo(userId) {
    this.#lastSpeaker = { id: userId, at: Date.now() };
    if (this.#speakers.has(userId)) return; // already piping this user
    this.#speakers.add(userId);

    const opus = this.connection.receiver.subscribe(userId, {
      end: { behavior: EndBehaviorType.AfterSilence, duration: SILENCE_MS },
    });

    const decoder = new prism.opus.Decoder({
      rate: 48000,
      channels: 2,
      frameSize: 960,
    });

    const pcm = opus.pipe(decoder);
    const gate = new SpeechGate(GATE);

    pcm.on('data', (chunk) => {
      const voice = gate.push(pcm48StereoTo16Mono(chunk));
      if (!voice) return; // background noise, not speech

      const now = Date.now();

      // One voice at a time. Overlapping talkers arrive as a single mixed
      // stream that no model can separate, so the second speaker is dropped
      // rather than smeared over the first.
      if (this.#floor && this.#floor.userId !== userId) {
        if (now - this.#floor.at < FLOOR_RELEASE_MS) return;
      }
      this.#floor = { userId, at: now };

      // Everyone shares one stream, so tell the model when the voice changes.
      if (this.#labelled !== userId) {
        this.#labelled = userId;
        const name = this.voiceChannel.members.get(userId)?.displayName;
        if (name) {
          if (process.env.DEBUG_GATE) console.log(`[gate] floor -> ${name}`);
          this.gemini?.sendSpeakerLabel(name);
        }
      }

      // Keep attribution fresh through a long uninterrupted turn.
      this.#lastSpeaker = { id: userId, at: now };
      this.#turnSpeakers.add(userId);
      this.gemini?.sendAudio(voice);
    });

    const finish = () => {
      if (!this.#speakers.delete(userId)) return;
      gate.reset();
      if (this.#floor?.userId === userId) this.#floor = null;
      decoder.destroy();
      // Only close the audio turn once nobody else is still talking.
      if (this.#speakers.size === 0) this.gemini?.endAudio();
    };

    pcm.on('end', finish);
    pcm.on('error', (err) => {
      console.error('[receiver]', err);
      finish();
    });
  }

  destroy() {
    this.#closing = true; // stop the close handler from trying to reconnect
    this.music?.stop();
    this.#speakers.clear();
    this.gemini?.close();
    this.player?.stop(true);
    this.speaker?.destroy();
    try {
      this.connection?.destroy();
    } catch {
      /* already destroyed */
    }
  }
}
