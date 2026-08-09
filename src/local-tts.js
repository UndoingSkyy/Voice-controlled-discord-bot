import { spawn } from 'node:child_process';

/**
 * Text-to-speech against a local Kokoro server.
 *
 * Two dialects are supported because Kokoro is distributed two ways:
 *
 *  - `openai`  POST /v1/audio/speech, the interface kokoro-fastapi serves.
 *              Preferred: it is a plain request that returns audio bytes.
 *  - `gradio`  The Pinokio/Gradio app in Kokoro-TTS.git. Its API is a two-step
 *              submit-then-poll protocol that returns a *path* to a file, so it
 *              needs a third request to fetch the audio. Workable, but the UI
 *              is the product there and the API shape moves between versions.
 *
 * Whatever comes back is decoded to 24 kHz mono PCM, which is what the voice
 * session already expects from Gemini.
 */

const BASE = (process.env.TTS_URL || 'http://localhost:8880').replace(/\/+$/, '');
const MODE = (process.env.TTS_MODE || 'openai').toLowerCase();
const VOICE = process.env.TTS_VOICE || 'af_heart';
const SPEED = Number(process.env.TTS_SPEED ?? 1);
const TIMEOUT_MS = Number(process.env.TTS_TIMEOUT_MS ?? 30_000);
const FN = process.env.TTS_GRADIO_FN || 'generate_first';

const authHeaders = () =>
  process.env.TTS_API_KEY ? { Authorization: `Bearer ${process.env.TTS_API_KEY}` } : {};

export async function health() {
  for (const path of ['/health', '/v1/models', '/']) {
    try {
      const res = await fetch(BASE + path, { signal: AbortSignal.timeout(4000) });
      if (res.ok) return true;
    } catch {
      /* try the next one */
    }
  }
  return false;
}

/* ------------------------------------------------------------------ */
/* Decoding                                                             */
/* ------------------------------------------------------------------ */

/**
 * Decode arbitrary audio to 24 kHz mono PCM using ffmpeg.
 *
 * Kokoro returns WAV or MP3 depending on how it is asked, and the voice
 * session wants raw PCM, so this normalises whatever arrives.
 */
async function toPcm24Mono(bytes) {
  const { default: ffmpegPath } = await import('ffmpeg-static').catch(() => ({ default: 'ffmpeg' }));

  return new Promise((resolve, reject) => {
    const ff = spawn(ffmpegPath, [
      '-loglevel', 'error',
      '-i', 'pipe:0',
      '-f', 's16le', '-ar', '24000', '-ac', '1',
      'pipe:1',
    ]);

    const out = [];
    let err = '';
    ff.stdout.on('data', (d) => out.push(d));
    ff.stderr.on('data', (d) => (err += d));
    ff.on('error', (e) =>
      reject(new Error(`ffmpeg not available for TTS decoding: ${e.message}`)),
    );
    ff.on('close', (code) =>
      code === 0 && out.length
        ? resolve(Buffer.concat(out))
        : reject(new Error(`Could not decode TTS audio: ${err.trim().split('\n')[0] || 'empty output'}`)),
    );
    ff.stdin.on('error', () => {});
    ff.stdin.end(bytes);
  });
}

/** WAV from a known-good 24 kHz mono source needs no ffmpeg — strip the header. */
function unwrapWav24Mono(buf) {
  if (buf.length < 44 || buf.toString('ascii', 0, 4) !== 'RIFF') return null;
  const channels = buf.readUInt16LE(22);
  const rate = buf.readUInt32LE(24);
  const bits = buf.readUInt16LE(34);
  if (channels !== 1 || rate !== 24000 || bits !== 16) return null;

  // Walk the chunks rather than assuming data starts at byte 44.
  let off = 12;
  while (off + 8 <= buf.length) {
    const id = buf.toString('ascii', off, off + 4);
    const size = buf.readUInt32LE(off + 4);
    if (id === 'data') return buf.subarray(off + 8, off + 8 + size);
    off += 8 + size + (size % 2);
  }
  return null;
}

/* ------------------------------------------------------------------ */
/* Dialects                                                             */
/* ------------------------------------------------------------------ */

async function viaOpenAi(text) {
  const res = await fetch(`${BASE}/v1/audio/speech`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...authHeaders() },
    body: JSON.stringify({
      model: process.env.TTS_MODEL || 'kokoro',
      voice: VOICE,
      input: text,
      speed: SPEED,
      response_format: 'wav',
    }),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });

  if (!res.ok) {
    throw new Error(`TTS failed (HTTP ${res.status}): ${(await res.text()).slice(0, 200)}`);
  }
  return Buffer.from(await res.arrayBuffer());
}

/**
 * Gradio's API: POST to get an event id, then read an SSE stream for the
 * result, which is a reference to a file rather than the audio itself.
 */
async function viaGradio(text) {
  const roots = ['/gradio_api/call', '/call']; // Gradio 5, then 4
  let lastError;

  for (const root of roots) {
    try {
      const submit = await fetch(`${BASE}${root}/${FN}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...authHeaders() },
        body: JSON.stringify({ data: [text, VOICE, SPEED, 'WAV'] }),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      if (!submit.ok) {
        lastError = new Error(`Gradio submit failed (HTTP ${submit.status})`);
        continue;
      }

      const { event_id: eventId } = await submit.json();
      if (!eventId) {
        lastError = new Error('Gradio returned no event id.');
        continue;
      }

      const stream = await fetch(`${BASE}${root}/${FN}/${eventId}`, {
        headers: authHeaders(),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      const body = await stream.text();

      // The completed event carries a JSON array; the audio is a file ref.
      const line = body.split('\n').reverse().find((l) => l.startsWith('data: ['));
      if (!line) {
        lastError = new Error('Gradio produced no result payload.');
        continue;
      }

      const payload = JSON.parse(line.slice(6));
      const ref = JSON.stringify(payload);
      const url =
        payload?.[0]?.url ??
        payload?.[0]?.path ??
        (typeof payload?.[0] === 'string' ? payload[0] : null);
      if (!url) {
        lastError = new Error(`Gradio returned no audio file in ${ref.slice(0, 120)}`);
        continue;
      }

      const fileUrl = url.startsWith('http')
        ? url
        : `${BASE}/gradio_api/file=${url.replace(/^\/?file=?/, '')}`;
      const audio = await fetch(fileUrl, { signal: AbortSignal.timeout(TIMEOUT_MS) });
      if (!audio.ok) {
        lastError = new Error(`Could not fetch the generated audio (HTTP ${audio.status}).`);
        continue;
      }
      return Buffer.from(await audio.arrayBuffer());
    } catch (err) {
      lastError = err;
    }
  }
  throw lastError ?? new Error('Gradio TTS failed.');
}

/* ------------------------------------------------------------------ */

/**
 * @param {string} text
 * @returns {Promise<Buffer>} 24 kHz mono s16le PCM
 */
export async function speak(text) {
  const clean = String(text ?? '').trim();
  if (!clean) return Buffer.alloc(0);

  let bytes;
  try {
    bytes = MODE === 'gradio' ? await viaGradio(clean) : await viaOpenAi(clean);
  } catch (err) {
    if (/fetch failed|ECONNREFUSED|timeout|aborted/i.test(err.message)) {
      throw new Error(
        `Text-to-speech server unreachable at ${BASE}. Start Kokoro, or set TTS_URL.`,
      );
    }
    throw err;
  }

  return unwrapWav24Mono(bytes) ?? (await toPcm24Mono(bytes));
}
