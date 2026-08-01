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

/** How long a user must be quiet before we treat their turn as finished. */
const SILENCE_MS = 500;

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

    this.gemini = new GeminiLiveSession();
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
      if (!this.textChannel) return;
      const lines = [];
      if (user.trim()) lines.push(`🗣️ **You:** ${user.trim()}`);
      if (model.trim()) lines.push(`🤖 **Gemini:** ${model.trim()}`);
      if (lines.length) {
        this.textChannel.send(lines.join('\n').slice(0, 1900)).catch(() => {});
      }
    });

    this.gemini.on('error', (err) => console.error('[gemini]', err));

    this.gemini.on('closed', (reason) => {
      console.warn('[gemini] session closed:', reason);
      this.textChannel
        ?.send(`⚠️ Gemini session ended (${reason}). Run \`/join\` again.`)
        .catch(() => {});
      stopSession(this.voiceChannel.guild.id);
    });
  }

  #listenTo(userId) {
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

    pcm.on('data', (chunk) => this.gemini?.sendAudio(pcm48StereoTo16Mono(chunk)));

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
