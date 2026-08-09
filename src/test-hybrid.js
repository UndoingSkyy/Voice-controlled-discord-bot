/**
 * Checks the three legs of the hybrid pipeline independently, so a failure
 * points at one service rather than "it doesn't work".
 *
 * Run with: npm run test:hybrid
 */
import 'dotenv/config';
import * as stt from './local-stt.js';
import * as tts from './local-tts.js';
import { GoogleGenAI } from '@google/genai';
import { moderationDeclarations } from './moderation-tools.js';

const STT_URL = process.env.STT_URL || 'http://localhost:5092';
const TTS_URL = process.env.TTS_URL || 'http://localhost:8880';
const MODEL = process.env.HYBRID_MODEL || 'gemini-flash-lite-latest';

console.log(`STT : ${STT_URL}`);
console.log(`LLM : ${MODEL} (Gemini text API)`);
console.log(`TTS : ${TTS_URL} (mode: ${process.env.TTS_MODE || 'openai'})\n`);

let failures = 0;

/* 1. Speech to text ------------------------------------------------- */
process.stdout.write('1. speech-to-text  ... ');
if (!(await stt.health())) {
  console.log(`❌ not reachable at ${STT_URL}`);
  console.log('     Parakeet is a Go server — build it and download the model, then run it.');
  failures++;
} else {
  try {
    // One second of near-silence: a valid request that should transcribe to nothing.
    const silence = Buffer.alloc(16000 * 2);
    const text = await stt.transcribe(silence);
    console.log(`✅ responding (silence -> ${JSON.stringify(text)})`);
  } catch (err) {
    console.log(`❌ ${err.message}`);
    failures++;
  }
}

/* 2. The brain ------------------------------------------------------ */
process.stdout.write('2. Gemini + tools  ... ');
try {
  const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
  const t0 = Date.now();
  const r = await ai.models.generateContent({
    model: MODEL,
    contents: [{ role: 'user', parts: [{ text: 'Mute Rock in the voice channel.' }] }],
    config: {
      systemInstruction: 'Discord voice bot. One short sentence. Use tools to act.',
      tools: [{ functionDeclarations: moderationDeclarations }],
      maxOutputTokens: 300,
    },
  });
  const call = (r.candidates?.[0]?.content?.parts ?? []).find((p) => p.functionCall)?.functionCall;
  console.log(
    call
      ? `✅ ${Date.now() - t0}ms — chose ${call.name}(${JSON.stringify(call.args)})`
      : `⚠️  ${Date.now() - t0}ms — replied with text instead of calling a tool`,
  );
} catch (err) {
  console.log(`❌ ${String(err.message).slice(0, 120)}`);
  failures++;
}

/* 3. Text to speech ------------------------------------------------- */
process.stdout.write('3. text-to-speech  ... ');
if (!(await tts.health())) {
  console.log(`❌ not reachable at ${TTS_URL}`);
  console.log('     Start Kokoro. For the OpenAI-style API use kokoro-fastapi;');
  console.log('     for the Pinokio Gradio app set TTS_MODE=gradio and TTS_URL=http://localhost:7860');
  failures++;
} else {
  try {
    const t0 = Date.now();
    const pcm = await tts.speak('Testing the local voice pipeline.');
    const seconds = (pcm.length / 2 / 24000).toFixed(1);
    console.log(`✅ ${Date.now() - t0}ms — ${pcm.length} bytes (${seconds}s of audio)`);
  } catch (err) {
    console.log(`❌ ${err.message}`);
    failures++;
  }
}

console.log(
  failures === 0
    ? '\n✅ All three legs work. Set BACKEND=hybrid and run /join.'
    : `\n${failures} leg(s) not ready. The bot still runs on BACKEND=live meanwhile.`,
);
process.exit(failures ? 1 : 0);
