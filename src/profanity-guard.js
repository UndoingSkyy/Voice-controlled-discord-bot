import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Escalating auto-moderation for spoken profanity: warn once, mute on repeat.
 *
 * Two things make this deliberately conservative. Speech-to-text mishears words,
 * and the caller can only guess who spoke — so a false positive punishes an
 * innocent person with nobody in the loop to catch it. The caller must therefore
 * pass a confidently-attributed speaker, and strikes expire on their own.
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WORDS_FILE = path.join(HERE, '..', 'profanity.txt');

/** Deliberately mild default. Put your server's real list in profanity.txt. */
const DEFAULT_WORDS = [
  'fuck', 'fucking', 'fucker', 'motherfucker',
  'shit', 'bullshit', 'bitch', 'bastard',
  'asshole', 'dickhead', 'cunt', 'wanker', 'prick',
];

function loadWords() {
  if (process.env.PROFANITY_WORDS) {
    return process.env.PROFANITY_WORDS.split(',').map((w) => w.trim()).filter(Boolean);
  }
  if (fs.existsSync(WORDS_FILE)) {
    const fromFile = fs
      .readFileSync(WORDS_FILE, 'utf8')
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter((l) => l && !l.startsWith('#'));
    if (fromFile.length) return fromFile;
  }
  return DEFAULT_WORDS;
}

// Mostly relevant if you reuse this on typed text; speech-to-text spells normally.
const LEET = {
  0: 'o', 1: 'i', 3: 'e', 4: 'a', 5: 's', 7: 't',
  '@': 'a', $: 's', '!': 'i', '|': 'i',
};

/** Fold leetspeak and punctuation: "sh!t" and "5hit" both become "shit". */
function normalize(token) {
  return token
    .toLowerCase()
    .split('')
    .map((c) => LEET[c] ?? c)
    .join('')
    .replace(/[^a-z]/g, '');
}

/** Squash runs of a repeated letter, so "fuuuck" reduces to "fuck". */
const collapse = (s) => s.replace(/(.)\1+/g, '$1');

export class ProfanityGuard {
  #strikes = new Map(); // userId -> { count, lastAt }
  #words; // exact normalised forms
  #collapsed; // Map of collapsed form -> original length, for padded spellings

  constructor() {
    const words = loadWords().map(normalize).filter(Boolean);
    this.#words = new Set(words);
    this.#collapsed = new Map();
    for (const w of words) {
      const c = collapse(w);
      // Keep the shortest source word for each collapsed form.
      if (!this.#collapsed.has(c) || w.length < this.#collapsed.get(c)) {
        this.#collapsed.set(c, w.length);
      }
    }
    this.decayMs = Number(process.env.PROFANITY_DECAY_MIN ?? 60) * 60_000;
    this.muteMs = Number(process.env.PROFANITY_MUTE_MIN ?? 5) * 60_000;
  }

  get size() {
    return this.#words.size;
  }

  /** Every listed word present in an utterance. */
  findHits(text) {
    const hits = new Set();
    for (const token of String(text ?? '').split(/\s+/)) {
      const n = normalize(token);
      if (!n) continue;

      if (this.#words.has(n)) {
        hits.add(n);
        continue;
      }
      // Padded spelling ("fuuuck"). Require the token to be no shorter than the
      // word it collapses onto, so the ordinary word "as" never matches "ass".
      const c = collapse(n);
      const sourceLen = this.#collapsed.get(c);
      if (sourceLen !== undefined && n.length >= sourceLen) hits.add(c);
    }
    return [...hits];
  }

  /**
   * Record an utterance and decide what should happen.
   * @returns {{action:'warn'|'mute', hits:string[], count:number}|null}
   */
  evaluate(userId, text) {
    const hits = this.findHits(text);
    if (!hits.length) return null;

    const now = Date.now();
    const prior = this.#strikes.get(userId);
    // A clean stretch wipes the slate — one slip an hour ago shouldn't stack.
    const count = prior && now - prior.lastAt < this.decayMs ? prior.count + 1 : 1;
    this.#strikes.set(userId, { count, lastAt: now });

    return { action: count === 1 ? 'warn' : 'mute', hits, count };
  }

  clear(userId) {
    this.#strikes.delete(userId);
  }
}
