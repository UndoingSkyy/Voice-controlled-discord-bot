import { EventEmitter } from 'node:events';
import { GoogleGenAI, Modality } from '@google/genai';

const MODEL = process.env.GEMINI_MODEL || 'gemini-2.0-flash-live-001';

/**
 * A wrong voice name is a nasty failure: the socket opens normally and only
 * dies on the first reply, with "No matching speaker voice found". Catching the
 * typo here turns a mystery into a one-line message.
 */
const VOICES = [
  'Puck', 'Charon', 'Kore', 'Fenrir', 'Aoede',
  'Leda', 'Orus', 'Zephyr',
];

function resolveVoice() {
  const wanted = (process.env.GEMINI_VOICE || 'Puck').trim();
  const match = VOICES.find((v) => v.toLowerCase() === wanted.toLowerCase());
  if (match) return match;

  console.warn(
    `[gemini] GEMINI_VOICE="${wanted}" is not a known voice — falling back to Puck. ` +
      `Valid: ${VOICES.join(', ')}`,
  );
  return 'Puck';
}

const VOICE = resolveVoice();

/** Drive turn boundaries from our own noise gate instead of the server's VAD. */
const MANUAL_TURNS = process.env.MANUAL_TURNS === '1';

/**
 * One live WebSocket session with Gemini.
 *
 * Events:
 *   audio      (Buffer)  raw 24 kHz mono s16le chunk to play back
 *   text       (string)  transcript of what the model said
 *   interrupted()        model detected barge-in; drop queued audio
 *   turnComplete()
 *   closed     (reason)
 *   error      (err)
 */
export class GeminiLiveSession extends EventEmitter {
  #session = null;
  #closed = false;

  /**
   * @param {object} [opts]
   * @param {Array}  [opts.functionDeclarations] tools Gemini may call
   * @param {string} [opts.extraInstruction]     appended to the system prompt
   */
  constructor(opts = {}) {
    super();
    this.functionDeclarations = opts.functionDeclarations ?? [];
    this.extraInstruction = opts.extraInstruction ?? '';
    /** Let the model run Google searches and answer from live results. */
    this.enableSearch = opts.enableSearch ?? false;
    /** Latest resumption handle, or null until the server issues one. */
    this.resumeHandle = opts.resumeHandle ?? null;
  }

  /**
   * @param {string|null} resumeHandle handle from a previous session, to carry
   *   its conversation history across a reconnect
   */
  async connect(resumeHandle = null) {
    const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

    const base =
      process.env.SYSTEM_PROMPT ||
      'You are a friendly voice assistant in a Discord voice channel. Keep replies short.';

    this.#session = await ai.live.connect({
      model: MODEL,
      config: {
        responseModalities: [Modality.AUDIO],  
        speechConfig: {
          voiceConfig: { prebuiltVoiceConfig: { voiceName: VOICE } },
        },
        // Search grounding and our own functions can coexist in one tools list.
        ...(this.functionDeclarations.length || this.enableSearch
          ? {
              tools: [
                ...(this.enableSearch ? [{ googleSearch: {} }] : []),
                ...(this.functionDeclarations.length
                  ? [{ functionDeclarations: this.functionDeclarations }]
                  : []),
              ],
            }
          : {}),
        systemInstruction: [base, this.extraInstruction].filter(Boolean).join('\n\n'),
        // Ask for transcripts so we can mirror the conversation into text chat.
        inputAudioTranscription: {},
        outputAudioTranscription: {},
        /**
         * Turn detection.
         *
         * With server-side detection Gemini treats *any* audio it receives as
         * someone talking, so in a noisy channel it interrupts itself
         * constantly. We already know who is speaking and when — the noise gate
         * and floor control decide it locally — so with MANUAL_TURNS the server
         * is told to stop guessing and to trust explicit start/end markers.
         */
        realtimeInputConfig: MANUAL_TURNS
          ? { automaticActivityDetection: { disabled: true } }
          : {
              automaticActivityDetection: {
                silenceDurationMs: Number(process.env.VAD_SILENCE_MS ?? 350),
                prefixPaddingMs: Number(process.env.VAD_PREFIX_MS ?? 100),
              },
            },
        // Live sessions expire after ~10 minutes. With resumption enabled the
        // server hands out handles that let a new socket pick up the same
        // conversation, so a reconnect doesn't lose the last ten minutes.
        sessionResumption: resumeHandle ? { handle: resumeHandle } : {},
      },
      callbacks: {
        onopen: () => this.emit('open'),
        onmessage: (msg) => this.#onMessage(msg),
        onerror: (err) => this.emit('error', err),
        onclose: (evt) => {
          this.#closed = true;
          this.emit('closed', evt?.reason ?? 'connection closed');
        },
      },
    });

    return this;
  }

  #onMessage(msg) {
    // The server periodically hands out a handle for the conversation so far.
    if (msg.sessionResumptionUpdate) {
      const { newHandle, resumable } = msg.sessionResumptionUpdate;
      if (resumable && newHandle) {
        this.resumeHandle = newHandle;
        this.emit('resumable', newHandle);
      }
    }

    // Advance warning that this socket is about to be closed.
    if (msg.goAway) {
      this.emit('goAway', msg.goAway.timeLeft ?? null);
    }

    if (msg.toolCall?.functionCalls?.length) {
      this.emit('toolCall', msg.toolCall.functionCalls);
    }

    const sc = msg.serverContent;
    if (!sc) return;

    if (sc.interrupted) this.emit('interrupted');

    for (const part of sc.modelTurn?.parts ?? []) {
      const data = part.inlineData?.data;
      if (data) this.emit('audio', Buffer.from(data, 'base64'));
    }

    // Where a grounded answer came from, so the chat post can cite it.
    if (sc.groundingMetadata) {
      const meta = sc.groundingMetadata;
      const sources = (meta.groundingChunks ?? [])
        .map((c) => c.web)
        .filter((w) => w?.uri)
        .map((w) => ({ title: w.title || new URL(w.uri).hostname, uri: w.uri }));
      if (sources.length || meta.webSearchQueries?.length) {
        this.emit('grounding', { sources, queries: meta.webSearchQueries ?? [] });
      }
    }

    if (sc.inputTranscription?.text) {
      this.emit('text', sc.inputTranscription.text, 'user');
    }
    if (sc.outputTranscription?.text) {
      this.emit('text', sc.outputTranscription.text, 'model');
    }

    if (sc.turnComplete) this.emit('turnComplete');
  }

  /**
   * Mark the start of a real utterance. Only used with manual turn detection:
   * audio sent outside a start/end pair is not treated as someone speaking, so
   * background noise cannot interrupt the bot.
   */
  startActivity() {
    if (this.#closed || !this.#session || !MANUAL_TURNS) return;
    try {
      this.#session.sendRealtimeInput({ activityStart: {} });
    } catch (err) {
      this.emit('error', err);
    }
  }

  /** Mark the end of an utterance, which is what makes Gemini answer. */
  endActivity() {
    if (this.#closed || !this.#session || !MANUAL_TURNS) return;
    try {
      this.#session.sendRealtimeInput({ activityEnd: {} });
    } catch (err) {
      this.emit('error', err);
    }
  }

  /** Push a chunk of 16 kHz mono s16le microphone audio. */
  sendAudio(pcm16k) {
    if (this.#closed || !this.#session) return;
    try {
      this.#session.sendRealtimeInput({
        audio: {
          data: pcm16k.toString('base64'),
          mimeType: 'audio/pcm;rate=16000',
        },
      });
    } catch (err) {
      this.emit('error', err);
    }
  }

  /**
   * Tell Gemini the mic stream paused. Discord only delivers packets while
   * someone is actually talking, so without this the server-side VAD can sit
   * waiting for the silence that never arrives.
   */
  endAudio() {
    if (this.#closed || !this.#session) return;
    try {
      this.#session.sendRealtimeInput({ audioStreamEnd: true });
    } catch (err) {
      this.emit('error', err);
    }
  }

  /**
   * Announce who is about to talk.
   *
   * Everyone in the channel arrives as one audio stream, so without this the
   * model hears a single voice that keeps changing its mind. `turnComplete` is
   * false: this is context attached to the turn, not a prompt to answer.
   */
  sendSpeakerLabel(name) {
    if (this.#closed || !this.#session) return;
    try {
      this.#session.sendClientContent({
        turns: [{ role: 'user', parts: [{ text: `[${name} is now speaking]` }] }],
        turnComplete: false,
      });
    } catch (err) {
      this.emit('error', err);
    }
  }

  /** Hand tool results back so the model can speak the outcome. */
  sendToolResponse(functionResponses) {
    if (this.#closed || !this.#session) return;
    try {
      this.#session.sendToolResponse({ functionResponses });
    } catch (err) {
      this.emit('error', err);
    }
  }

  /** Inject a text turn (e.g. from a slash command) into the same conversation. */
  sendText(text) {
    if (this.#closed || !this.#session) return;
    this.#session.sendClientContent({
      turns: [{ role: 'user', parts: [{ text }] }],
      turnComplete: true,
    });
  }

  close() {
    this.#closed = true;
    try {
      this.#session?.close();
    } catch {
      /* already gone */
    }
  }
}
