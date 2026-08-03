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

/** Root-mean-square level of a 16-bit PCM buffer, 0..32767. */
export function rms(buf) {
  const n = Math.floor(buf.length / 2);
  if (!n) return 0;
  let sum = 0;
  for (let i = 0; i < n; i++) {
    const s = buf.readInt16LE(i * 2);
    sum += s * s;
  }
  return Math.sqrt(sum / n);
}

/**
 * Speech gate for one person's microphone.
 *
 * Discord starts a stream for any noise at all — typing, breathing, a TV in the
 * background — and forwarding that to a speech model produces hallucinated
 * words and constant interruptions. Audio only passes once it has been loud
 * enough for long enough to be someone actually talking.
 *
 * Two details keep it from clipping real speech: a short pre-roll buffer so the
 * first syllable survives the decision, and a hangover so normal pauses between
 * words don't slam the gate shut.
 */
export class SpeechGate {
  #open = false;
  #loudSince = 0;
  #lastLoud = 0;
  #preRoll = [];
  #preRollBytes = 0;

  /**
   * @param {object} [opts]
   * @param {number} [opts.threshold]  RMS above which audio counts as speech
   * @param {number} [opts.minSpeechMs] how long it must stay loud to open
   * @param {number} [opts.hangoverMs]  how long it stays open after going quiet
   * @param {number} [opts.preRollMs]   audio kept back to prepend on opening
   */
  constructor(opts = {}) {
    this.threshold = opts.threshold ?? 500;
    this.minSpeechMs = opts.minSpeechMs ?? 120;
    this.hangoverMs = opts.hangoverMs ?? 700;
    this.preRollBytesMax = Math.floor(((opts.preRollMs ?? 300) / 1000) * 16000) * 2;
  }

  get isOpen() {
    return this.#open;
  }

  /**
   * @returns {Buffer|null} audio to forward, or null while gated
   */
  push(chunk, now = Date.now()) {
    const loud = rms(chunk) >= this.threshold;

    if (loud) {
      if (!this.#loudSince) this.#loudSince = now;
      this.#lastLoud = now;
      if (!this.#open && now - this.#loudSince >= this.minSpeechMs) {
        this.#open = true;
        const opening = Buffer.concat([...this.#preRoll, chunk]);
        this.#preRoll = [];
        this.#preRollBytes = 0;
        return opening;
      }
    } else {
      this.#loudSince = 0;
      if (this.#open && now - this.#lastLoud > this.hangoverMs) this.#open = false;
    }

    if (this.#open) return chunk;

    // Not open: keep a rolling tail so the attack isn't lost when it opens.
    this.#preRoll.push(chunk);
    this.#preRollBytes += chunk.length;
    while (this.#preRollBytes > this.preRollBytesMax && this.#preRoll.length > 1) {
      this.#preRollBytes -= this.#preRoll.shift().length;
    }
    return null;
  }

  reset() {
    this.#open = false;
    this.#loudSince = 0;
    this.#preRoll = [];
    this.#preRollBytes = 0;
  }
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
