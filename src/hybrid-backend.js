import { EventEmitter } from 'node:events';
import { GoogleGenAI } from '@google/genai';
import * as stt from './local-stt.js';
import * as tts from './local-tts.js';

/**
 * Hybrid backend: local ears and voice, Gemini's brain.
 *
 *   Discord audio → Parakeet (STT, local) → Gemini generateContent → Kokoro (TTS, local)
 *
 * The point is quota. Every limit hit in practice has been on the Live API's
 * `bidiGenerateContent`, which has a far smaller free-tier budget than plain
 * `generateContent`. Moving speech in and out onto the machine leaves only a
 * short text request per turn, against the roomier bucket — while keeping the
 * tool-calling quality that a small local model would not match.
 *
 * What is given up, exactly as with any STT→LLM→TTS chain: the model only ever
 * sees words, so tone and hesitation are gone, and barge-in has to be
 * reconstructed here rather than detected server-side.
 *
 * It exposes the same methods and events as GeminiLiveSession, so
 * voice-session.js cannot tell which one it is holding.
 */

const MODEL = process.env.HYBRID_MODEL || 'gemini-flash-lite-latest';
const MAX_HISTORY_TURNS = Number(process.env.HYBRID_HISTORY_TURNS ?? 12);
const MAX_TOKENS = Number(process.env.HYBRID_MAX_TOKENS ?? 600);
const MIN_UTTERANCE_BYTES = 16000 * 2 * 0.35; // ~350 ms of 16 kHz mono

export class HybridSession extends EventEmitter {
  #audio = [];
  #history = [];
  #closed = false;
  #busy = false;
  #speaking = false;
  #toolWaiter = null;
  #speaker = null;
  #ai = null;
  #system = '';

  constructor(opts = {}) {
    super();
    this.declarations = opts.functionDeclarations ?? [];
    this.extraInstruction = opts.extraInstruction ?? '';
    this.resumeHandle = null; // no equivalent; kept for interface parity
  }

  async connect() {
    if (!process.env.GEMINI_API_KEY) throw new Error('GEMINI_API_KEY is not set.');

    this.#ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
    this.#system = [process.env.SYSTEM_PROMPT, this.extraInstruction].filter(Boolean).join('\n\n');
    this.#history = [];

    // Fail loudly at /join rather than silently mid-conversation.
    const [sttUp, ttsUp] = await Promise.all([stt.health(), tts.health()]);
    if (!sttUp) {
      throw new Error(
        `Speech-to-text is not running at ${process.env.STT_URL || 'http://localhost:5092'}. ` +
          'Start Parakeet first, or set BACKEND=gemini to use the Live API.',
      );
    }
    if (!ttsUp) {
      throw new Error(
        `Text-to-speech is not running at ${process.env.TTS_URL || 'http://localhost:8880'}. ` +
          'Start Kokoro first, or set BACKEND=gemini to use the Live API.',
      );
    }

    console.log(`[hybrid] ready — STT local, ${MODEL} for thinking, TTS local`);
    this.emit('open');
    return this;
  }

  /* -------------------- audio in -------------------- */

  sendAudio(pcm16k) {
    if (this.#closed) return;

    // Someone talking over the reply is a barge-in. There is no server-side
    // detector here, so stop playback ourselves.
    if (this.#speaking) {
      this.#speaking = false;
      this.emit('interrupted');
    }
    this.#audio.push(pcm16k);
  }

  /** Discord went quiet: that is the end of the turn. */
  endAudio() {
    if (this.#closed || this.#busy) return;
    const pcm = Buffer.concat(this.#audio);
    this.#audio = [];
    if (pcm.length < MIN_UTTERANCE_BYTES) return; // a cough, not a sentence

    this.#handleTurn(pcm).catch((err) => this.emit('error', err));
  }

  sendSpeakerLabel(name) {
    this.#speaker = name;
  }

  sendText(text) {
    if (this.#closed || !text) return;
    this.#respond(text).catch((err) => this.emit('error', err));
  }

  sendToolResponse(functionResponses) {
    this.#toolWaiter?.(functionResponses);
    this.#toolWaiter = null;
  }

  close() {
    this.#closed = true;
    this.#speaking = false;
    this.emit('closed', 'session ended');
  }

  /* -------------------- the turn -------------------- */

  async #handleTurn(pcm) {
    this.#busy = true;
    try {
      const heard = await stt.transcribe(pcm);
      if (!heard) return;

      this.emit('text', heard, 'user');
      // Keep people apart the same way the Live backend does.
      await this.#respond(this.#speaker ? `${this.#speaker}: ${heard}` : heard, true);
    } finally {
      this.#busy = false;
    }
  }

  async #respond(userText, alreadyEmitted = false) {
    if (!alreadyEmitted) this.emit('text', userText, 'user');

    this.#history.push({ role: 'user', parts: [{ text: userText }] });
    this.#trim();

    // Loop so the model can call a tool, read the result, then speak.
    for (let hop = 0; hop < 4; hop++) {
      const response = await this.#think();
      const parts = response?.candidates?.[0]?.content?.parts ?? [];
      const calls = parts.filter((p) => p.functionCall).map((p) => p.functionCall);

      this.#history.push({ role: 'model', parts });

      if (calls.length) {
        const results = await new Promise((resolve) => {
          this.#toolWaiter = resolve;
          this.emit(
            'toolCall',
            calls.map((c, i) => ({ id: c.id ?? `call-${i}`, name: c.name, args: c.args ?? {} })),
          );
        });

        this.#history.push({
          role: 'user',
          parts: (results ?? []).map((r) => ({
            functionResponse: { name: r.name, response: r.response ?? {} },
          })),
        });
        continue;
      }

      const said = parts.map((p) => p.text).filter(Boolean).join(' ').trim();
      if (said) {
        this.emit('text', said, 'model');
        await this.#speak(said);
      }
      break;
    }

    this.emit('turnComplete');
  }

  async #think() {
    const config = {
      systemInstruction: this.#system,
      maxOutputTokens: MAX_TOKENS,
      temperature: 0.7,
    };
    if (this.declarations.length) {
      config.tools = [{ functionDeclarations: this.declarations }];
    }

    try {
      return await this.#ai.models.generateContent({
        model: MODEL,
        contents: this.#history,
        config,
      });
    } catch (err) {
      const msg = String(err?.message ?? err);
      if (/quota|RESOURCE_EXHAUSTED|429/i.test(msg)) {
        throw new Error(`Gemini rate limit on ${MODEL}: ${msg.slice(0, 160)}`);
      }
      throw new Error(`Gemini request failed: ${msg.slice(0, 200)}`);
    }
  }

  async #speak(text) {
    const pcm = await tts.speak(text);
    if (!pcm.length) return;

    this.#speaking = true;
    // Hand it over in slices so a barge-in can cut it short mid-sentence.
    const CHUNK = 4800; // 100 ms at 24 kHz mono
    for (let i = 0; i < pcm.length && this.#speaking; i += CHUNK) {
      this.emit('audio', pcm.subarray(i, i + CHUNK));
    }
    this.#speaking = false;
  }

  /** History is re-sent every turn, so it is capped rather than unbounded. */
  #trim() {
    const budget = MAX_HISTORY_TURNS * 2;
    if (this.#history.length <= budget) return;

    let kept = this.#history.slice(-budget);
    // A functionResponse with no matching call above it is rejected.
    while (kept.length && kept[0].parts?.some((p) => p.functionResponse)) kept.shift();
    this.#history = kept;
  }
}
