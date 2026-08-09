/**
 * Speech-to-text against a local Parakeet server.
 *
 * Parakeet exposes an OpenAI Whisper-compatible API, so this is a plain
 * multipart POST — the same shape any Whisper endpoint takes. That also means
 * STT_URL can point at anything speaking that dialect (a local whisper.cpp
 * server, faster-whisper-server, or a hosted one) without touching this file.
 */

const BASE = (process.env.STT_URL || 'http://localhost:5092').replace(/\/+$/, '');
const MODEL = process.env.STT_MODEL || 'parakeet';
const LANGUAGE = process.env.STT_LANGUAGE || 'en';
const TIMEOUT_MS = Number(process.env.STT_TIMEOUT_MS ?? 20_000);

/** Wrap raw PCM in a WAV container — the one format Parakeet always accepts. */
export function toWav(pcm, { sampleRate = 16000, channels = 1 } = {}) {
  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20); // PCM
  header.writeUInt16LE(channels, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * channels * 2, 28);
  header.writeUInt16LE(channels * 2, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36);
  header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}

const authHeaders = () =>
  process.env.STT_API_KEY ? { Authorization: `Bearer ${process.env.STT_API_KEY}` } : {};

/** Is the server up? Used for a clear message at startup rather than mid-call. */
export async function health() {
  try {
    const res = await fetch(`${BASE}/health`, { signal: AbortSignal.timeout(4000) });
    return res.ok;
  } catch {
    return false;
  }
}

/**
 * @param {Buffer} pcm16k 16 kHz mono signed-16-bit LE
 * @returns {Promise<string>} transcript, '' when nothing was said
 */
export async function transcribe(pcm16k) {
  const form = new FormData();
  form.append('file', new Blob([toWav(pcm16k)], { type: 'audio/wav' }), 'turn.wav');
  form.append('model', MODEL);
  form.append('language', LANGUAGE);
  form.append('response_format', 'json');

  let res;
  try {
    res = await fetch(`${BASE}/v1/audio/transcriptions`, {
      method: 'POST',
      headers: authHeaders(),
      body: form,
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (err) {
    throw new Error(
      `Speech-to-text server unreachable at ${BASE} (${err.name}). ` +
        'Start Parakeet, or point STT_URL somewhere else.',
    );
  }

  if (!res.ok) {
    throw new Error(`Speech-to-text failed (HTTP ${res.status}): ${(await res.text()).slice(0, 200)}`);
  }

  const body = await res.json();
  const text = String(body.text ?? '').trim();

  // ASR models emit these for near-silence; passing them on starts a phantom turn.
  return /^(you|thank you\.?|thanks for watching[.!]?|\.|\s*)$/i.test(text) ? '' : text;
}
