import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import ffmpegPath from 'ffmpeg-static';
import { Type } from '@google/genai';

/**
 * Music playback.
 *
 * Sources are things you are entitled to play: audio files in a local library
 * folder, direct links to audio files, and public radio streams. Ripping audio
 * out of YouTube is deliberately not supported — it breaks YouTube's terms, it
 * is what got the big music bots shut down, and the scraping libraries that do
 * it break every few weeks.
 *
 * Everything is decoded by ffmpeg to the exact format Discord voice wants
 * (48 kHz stereo signed 16-bit LE) so it can be mixed straight into the same
 * output stream the bot speaks through.
 */

const LIBRARY = process.env.MUSIC_DIR || path.join(process.cwd(), 'music');
const AUDIO_EXT = /\.(mp3|flac|wav|ogg|opus|m4a|aac|wma|webm)$/i;
const DEFAULT_VOLUME = Number(process.env.MUSIC_VOLUME ?? 0.5);

/** Public streams, so "put some music on" works with nothing set up. */
export const RADIO = {
  lofi: { name: 'Lofi Girl radio', url: 'https://play.streamafrica.net/lofiradio' },
  chillhop: { name: 'Chillhop', url: 'https://streams.fluxfm.de/Chillhop/mp3-320/' },
  jazz: { name: 'SomaFM Sonic Universe (jazz)', url: 'https://ice2.somafm.com/sonicuniverse-128-mp3' },
  groove: { name: 'SomaFM Groove Salad', url: 'https://ice2.somafm.com/groovesalad-128-mp3' },
  synth: { name: 'SomaFM Underground 80s', url: 'https://ice2.somafm.com/u80s-128-mp3' },
  metal: { name: 'SomaFM Metal Detector', url: 'https://ice2.somafm.com/metal-128-mp3' },
};

/* ------------------------------------------------------------------ */
/* Local library                                                        */
/* ------------------------------------------------------------------ */

function listLibrary() {
  try {
    return fs
      .readdirSync(LIBRARY, { withFileTypes: true })
      .filter((d) => d.isFile() && AUDIO_EXT.test(d.name))
      .map((d) => d.name);
  } catch {
    return [];
  }
}

const norm = (s) => String(s ?? '').normalize('NFKD').toLowerCase().replace(/[^a-z0-9]/g, '');

function findTrack(spoken) {
  const want = norm(spoken);
  if (!want) return null;
  const files = listLibrary();
  const bare = (f) => norm(f.replace(AUDIO_EXT, ''));
  return (
    files.find((f) => bare(f) === want) ??
    files.find((f) => bare(f).includes(want)) ??
    files.find((f) => want.includes(bare(f))) ??
    null
  );
}

/* ------------------------------------------------------------------ */
/* Decoder                                                             */
/* ------------------------------------------------------------------ */

/**
 * One playing track. ffmpeg writes raw PCM to stdout; the mixer pulls frames
 * from `stream` at its own pace, and back-pressure keeps ffmpeg in step.
 */
export class Track {
  constructor({ title, input, isStream = false }) {
    this.title = title;
    this.input = input;
    this.isStream = isStream;
    this.startedAt = Date.now();

    this.proc = spawn(
      ffmpegPath,
      [
        '-loglevel', 'error',
        ...(isStream ? ['-reconnect', '1', '-reconnect_streamed', '1', '-reconnect_delay_max', '5'] : []),
        '-i', input,
        '-vn',
        '-f', 's16le', '-ar', '48000', '-ac', '2',
        'pipe:1',
      ],
      { stdio: ['ignore', 'pipe', 'pipe'] },
    );

    this.stream = this.proc.stdout;
    this.error = null;
    this.proc.stderr.on('data', (d) => {
      const msg = d.toString().trim();
      if (msg) {
        this.error ??= msg.split('\n')[0];
        console.warn(`[music] ffmpeg: ${msg.split('\n')[0]}`);
      }
    });
    this.proc.on('error', (err) => {
      this.error = err.message;
    });
  }

  stop() {
    try {
      this.proc.kill('SIGKILL');
    } catch {
      /* already gone */
    }
  }
}

/* ------------------------------------------------------------------ */
/* Per-guild player                                                     */
/* ------------------------------------------------------------------ */

export class MusicPlayer {
  #queue = [];
  #current = null;

  constructor(speaker) {
    this.speaker = speaker; // SpeakerStream doing the mixing
    this.volume = DEFAULT_VOLUME;
  }

  get nowPlaying() {
    return this.#current?.title ?? null;
  }

  get upNext() {
    return this.#queue.map((q) => q.title);
  }

  /** Resolve a spoken request into something ffmpeg can open. */
  resolve(query) {
    const q = String(query ?? '').trim();
    if (!q) throw new Error('Name a track, a radio station, or give a direct audio link.');

    if (/^https?:\/\//i.test(q)) {
      if (/youtu\.?be|youtube\.com/i.test(q)) {
        throw new Error(
          "I can't play YouTube links — extracting audio from YouTube breaks their terms " +
            'of service. Give me a direct audio link, a radio station, or a file in the music folder.',
        );
      }
      return { title: q.split('/').pop()?.slice(0, 80) || q, input: q, isStream: true };
    }

    const station = RADIO[norm(q)] ?? Object.values(RADIO).find((r) => norm(r.name).includes(norm(q)));
    if (station) return { title: station.name, input: station.url, isStream: true };

    const file = findTrack(q);
    if (file) return { title: file.replace(AUDIO_EXT, ''), input: path.join(LIBRARY, file), isStream: false };

    const have = listLibrary();
    throw new Error(
      `Nothing matching "${q}". Radio stations: ${Object.keys(RADIO).join(', ')}.` +
        (have.length
          ? ` Local tracks: ${have.slice(0, 8).map((f) => f.replace(AUDIO_EXT, '')).join(', ')}.`
          : ` The music folder (${LIBRARY}) is empty.`),
    );
  }

  play(query) {
    const spec = this.resolve(query);
    this.#current?.stop();
    this.#current = new Track(spec);
    this.speaker.setMusic(this.#current.stream, this.volume);
    this.#current.stream.once('end', () => this.#advance());
    return spec.title;
  }

  enqueue(query) {
    const spec = this.resolve(query);
    if (!this.#current) return { started: this.play(query) };
    this.#queue.push(spec);
    return { queued: spec.title, position: this.#queue.length };
  }

  #advance() {
    const next = this.#queue.shift();
    this.#current?.stop();
    this.#current = null;
    if (!next) {
      this.speaker.setMusic(null);
      return;
    }
    this.#current = new Track(next);
    this.speaker.setMusic(this.#current.stream, this.volume);
    this.#current.stream.once('end', () => this.#advance());
  }

  skip() {
    if (!this.#current) throw new Error('Nothing is playing.');
    const was = this.#current.title;
    this.#advance();
    return was;
  }

  stop() {
    this.#current?.stop();
    this.#current = null;
    this.#queue = [];
    this.speaker.setMusic(null);
  }

  setVolume(v) {
    const vol = Number(v);
    if (!Number.isFinite(vol) || vol < 0 || vol > 1) throw new Error('Volume goes from 0 to 1.');
    this.volume = vol;
    this.speaker.setMusicVolume(vol);
    return vol;
  }
}

/* ------------------------------------------------------------------ */
/* Tools                                                                */
/* ------------------------------------------------------------------ */

export const musicDeclarations = [
  {
    name: 'play_music',
    description:
      'Play music in the voice channel: a track from the local music folder, a radio station ' +
      'by name, or a direct audio link. YouTube links are not supported.',
    parameters: {
      type: Type.OBJECT,
      properties: {
        query: { type: Type.STRING, description: 'Track name, radio station, or direct audio URL' },
        queue: { type: Type.BOOLEAN, description: 'true to add to the queue instead of playing now' },
      },
      required: ['query'],
    },
  },
  {
    name: 'control_music',
    description: 'Stop, skip, change the volume, or report what is playing.',
    parameters: {
      type: Type.OBJECT,
      properties: {
        action: { type: Type.STRING, description: 'stop, skip, status, or volume' },
        volume: { type: Type.NUMBER, description: 'For volume: 0 to 1' },
      },
      required: ['action'],
    },
  },
  {
    name: 'list_music',
    description: 'List the radio stations and the tracks available in the local music folder.',
    parameters: { type: Type.OBJECT, properties: {} },
  },
];

export const musicHandlers = {
  play_music(ctx, { query, queue }) {
    const player = ctx.session?.music;
    if (!player) throw new Error('I need to be in a voice channel first.');
    if (queue) {
      const r = player.enqueue(query);
      return { done: r.started ? `Playing ${r.started}` : `Queued ${r.queued} at #${r.position}` };
    }
    return { done: `Playing ${player.play(query)}` };
  },

  control_music(ctx, { action, volume }) {
    const player = ctx.session?.music;
    if (!player) throw new Error('I need to be in a voice channel first.');

    switch (String(action).toLowerCase()) {
      case 'stop':
        player.stop();
        return { done: 'Stopped the music' };
      case 'skip':
        return { done: `Skipped ${player.skip()}` };
      case 'volume':
        return { done: `Volume set to ${Math.round(player.setVolume(volume) * 100)}%` };
      case 'status':
        return player.nowPlaying
          ? { playing: player.nowPlaying, up_next: player.upNext }
          : { playing: null, note: 'Nothing is playing.' };
      default:
        throw new Error(`Unknown action "${action}". Use stop, skip, volume or status.`);
    }
  },

  list_music() {
    return {
      radio_stations: Object.entries(RADIO).map(([k, v]) => ({ say: k, name: v.name })),
      local_tracks: listLibrary().map((f) => f.replace(AUDIO_EXT, '')),
      music_folder: LIBRARY,
    };
  },
};
