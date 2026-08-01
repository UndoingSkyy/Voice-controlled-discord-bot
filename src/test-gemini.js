/**
 * Standalone check of the Gemini Live connection — no Discord involved.
 * Run with: node src/test-gemini.js
 */
import 'dotenv/config';
import { GeminiLiveSession } from './gemini-live.js';

const key = process.env.GEMINI_API_KEY ?? '';
console.log(`Model : ${process.env.GEMINI_MODEL || 'gemini-2.0-flash-live-001'}`);
console.log(`Key   : ${key.slice(0, 4)}... (${key.length} chars)`);

const session = new GeminiLiveSession();
let audioBytes = 0;

session.on('open', () => console.log('✅ WebSocket open — connection accepted'));
session.on('audio', (buf) => {
  audioBytes += buf.length;
});
session.on('text', (t, who) => process.stdout.write(`[${who}] ${t}`));
session.on('turnComplete', () => {
  console.log(`\n✅ Turn complete — received ${audioBytes} bytes of audio.`);
  console.log('Gemini side works. Any /join failure is on the Discord side.');
  session.close();
  process.exit(0);
});
session.on('error', (err) => {
  console.error('❌ Error:', err?.message ?? err);
});
session.on('closed', (reason) => {
  console.error(`❌ Closed: ${reason}`);
  process.exit(1);
});

try {
  await session.connect();
  session.sendText('Say hello in one short sentence.');
} catch (err) {
  console.error('❌ connect() threw:', err?.message ?? err);
  process.exit(1);
}

setTimeout(() => {
  console.error('❌ Timed out after 30s with no complete response.');
  process.exit(1);
}, 30_000);
