import { EventEmitter } from 'node:events';
import { GoogleGenAI, Modality } from '@google/genai';

const MODEL = process.env.GEMINI_MODEL || 'gemini-2.0-flash-live-001';
const VOICE = process.env.GEMINI_VOICE || 'Puck';

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
  }

  async connect() {
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
        ...(this.functionDeclarations.length
          ? { tools: [{ functionDeclarations: this.functionDeclarations }] }
          : {}),
        systemInstruction: [base, this.extraInstruction].filter(Boolean).join('\n\n'),
        // Ask for transcripts so we can mirror the conversation into text chat.
        inputAudioTranscription: {},
        outputAudioTranscription: {},
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

    if (sc.inputTranscription?.text) {
      this.emit('text', sc.inputTranscription.text, 'user');
    }
    if (sc.outputTranscription?.text) {
      this.emit('text', sc.outputTranscription.text, 'model');
    }

    if (sc.turnComplete) this.emit('turnComplete');
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
