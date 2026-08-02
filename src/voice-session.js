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

import { GeminiLiveSession } from './gemini-live.js';
import { SpeakerStream, pcm48StereoTo16Mono, pcm24MonoTo48Stereo } from './audio.js';
import { moderationDeclarations, executeTool, autoMute } from './moderation-tools.js';
import { ProfanityGuard } from './profanity-guard.js';

/** How long a user must be quiet before we treat their turn as finished. */
const SILENCE_MS = 500;

/** Ignore an attributed speaker older than this when a tool call arrives. */
const SPEAKER_TTL_MS = 30_000;

const MODERATION_INSTRUCTION = `
You can moderate this Discord server with the provided tools.

Rules you must follow:
- Before disconnecting, timing out, or deleting messages, say what you are about
  to do and wait for the person to confirm. These cannot be undone.
- Speech recognition mishears names. If a name is unclear or could match several
  people, call list_members and ask which person is meant. Never guess.
- If a tool returns an error, read the reason out loud plainly. Do not retry it
  and do not look for another way around it.
- Only act when someone actually asks you to. Never moderate someone because of
  something you heard in conversation.
`.trim();

const PROFANITY_ENABLED = process.env.PROFANITY_FILTER === '1';

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
    this.player = createAudioPlayer({
      behaviors: { noSubscriber: NoSubscriberBehavior.Play },
    });
    this.player.play(
      createAudioResource(this.speaker, { inputType: StreamType.Raw }),
    );
    this.connection.subscribe(this.player);

    this.gemini = new GeminiLiveSession({
      functionDeclarations: moderationDeclarations,
      extraInstruction: MODERATION_INSTRUCTION,
    });
    this.#wireGemini();
    try {
      await this.gemini.connect();
    } catch (err) {
      throw new Error(`Gemini refused the live connection: ${err?.message ?? err}`);
    }

    this.connection.receiver.speaking.on('start', (userId) => this.#listenTo(userId));

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

  #wireGemini() {
    this.gemini.on('audio', (pcm24) => {
      this.speaker.write(pcm24MonoTo48Stereo(pcm24));
    });

    this.gemini.on('interrupted', () => this.speaker.clear());

    this.gemini.on('text', (chunk, who) => {
      this.#transcript[who] += chunk;
    });

    this.gemini.on('turnComplete', () => {
      const { user, model } = this.#transcript;
      this.#transcript = { user: '', model: '' };

      const spokeThisTurn = [...this.#turnSpeakers];
      this.#turnSpeakers.clear();
      if (this.#guard && user.trim()) this.#checkLanguage(user, spokeThisTurn);

      if (!this.textChannel) return;
      const lines = [];
      if (user.trim()) lines.push(`🗣️ **You:** ${user.trim()}`);
      if (model.trim()) lines.push(`🤖 **Gemini:** ${model.trim()}`);
      if (lines.length) {
        this.textChannel.send(lines.join('\n').slice(0, 1900)).catch(() => {});
      }
    });

    this.gemini.on('toolCall', (calls) => this.#runTools(calls));

    this.gemini.on('error', (err) => console.error('[gemini]', err));

    this.gemini.on('closed', (reason) => {
      console.warn('[gemini] session closed:', reason);
      this.textChannel
        ?.send(`⚠️ Gemini session ended (${reason}). Run \`/join\` again.`)
        .catch(() => {});
      stopSession(this.voiceChannel.guild.id);
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

  async #runTools(calls) {
    const requester = await this.#requester();
    const ctx = {
      guild: this.voiceChannel.guild,
      voiceChannel: this.voiceChannel,
      textChannel: this.textChannel,
      requester,
      presenceEnabled: process.env.ENABLE_PRESENCE === '1',
    };

    const responses = [];
    for (const call of calls) {
      const response = await executeTool(call.name, call.args, ctx);
      responses.push({ id: call.id, name: call.name, response });

      // Leave a written trail: voice moderation is otherwise invisible.
      if (this.textChannel && call.name !== 'list_members') {
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

    pcm.on('data', (chunk) => {
      // Keep attribution fresh through a long uninterrupted turn.
      this.#lastSpeaker = { id: userId, at: Date.now() };
      this.#turnSpeakers.add(userId);
      this.gemini?.sendAudio(pcm48StereoTo16Mono(chunk));
    });

    const finish = () => {
      if (!this.#speakers.delete(userId)) return;
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
