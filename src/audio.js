import { Readable } from 'node:stream';

/**
 * Discord voice speaks 48 kHz stereo signed-16-bit LE.
 * Gemini Live wants 16 kHz mono in, and hands back 24 kHz mono out.
 * Both conversions are integer ratios, so we can do them in plain JS
 * and avoid dragging ffmpeg into the process.
 */

/** 48 kHz stereo s16le -> 16 kHz mono s16le (average 3 frames, mix channels). */
export function pcm48StereoTo16Mono(buf) {
  const frames = Math.floor(buf.length / 4); // 4 bytes per stereo frame
  const outFrames = Math.floor(frames / 3);
  const out = Buffer.allocUnsafe(outFrames * 2);

  for (let i = 0; i < outFrames; i++) {
    let sum = 0;
    for (let j = 0; j < 3; j++) {
      const off = (i * 3 + j) * 4;
      sum += buf.readInt16LE(off) + buf.readInt16LE(off + 2);
    }
    out.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(sum / 6))), i * 2);
  }
  return out;
}

/** 24 kHz mono s16le -> 48 kHz stereo s16le (linear interpolation, duplicated channels). */
export function pcm24MonoTo48Stereo(buf) {
  const samples = Math.floor(buf.length / 2);
  const out = Buffer.allocUnsafe(samples * 8); // 2x rate, 2 channels

  for (let i = 0; i < samples; i++) {
    const cur = buf.readInt16LE(i * 2);
    const next = i + 1 < samples ? buf.readInt16LE((i + 1) * 2) : cur;
    const mid = (cur + next) >> 1;

    const off = i * 8;
    out.writeInt16LE(cur, off);
    out.writeInt16LE(cur, off + 2);
    out.writeInt16LE(mid, off + 4);
    out.writeInt16LE(mid, off + 6);
  }
  return out;
}

const FRAME_BYTES = 3840; // 20 ms of 48 kHz stereo s16le
const SILENCE = Buffer.alloc(FRAME_BYTES);

/**
 * A never-ending 48 kHz stereo PCM stream. Feed it Gemini audio with write();
 * it emits silence whenever the queue is empty so the Discord player never
 * transitions to Idle (which would end the subscription mid-conversation).
 */
export class SpeakerStream extends Readable {
  #queue = [];
  #pending = Buffer.alloc(0);

  constructor() {
    // Keep the read buffer tiny: anything buffered ahead is silence that would
    // otherwise sit in front of real speech and add latency.
    super({ highWaterMark: FRAME_BYTES });
  }

  write(chunk) {
    this.#queue.push(chunk);
  }

  /** Drop everything still queued — used when the user barges in. */
  clear() {
    this.#queue.length = 0;
    this.#pending = Buffer.alloc(0);
  }

  get idle() {
    return this.#queue.length === 0 && this.#pending.length === 0;
  }

  _read() {
    while (this.#pending.length < FRAME_BYTES && this.#queue.length > 0) {
      this.#pending = Buffer.concat([this.#pending, this.#queue.shift()]);
    }

    if (this.#pending.length >= FRAME_BYTES) {
      const frame = this.#pending.subarray(0, FRAME_BYTES);
      this.#pending = this.#pending.subarray(FRAME_BYTES);
      this.push(frame);
    } else {
      this.push(SILENCE);
    }
  }
}
