import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { EmbedBuilder } from 'discord.js';
import { Type } from '@google/genai';

/**
 * waifu.im integration — anime artwork posted into the channel /join was run in.
 *
 * https://api.waifu.im  •  no auth needed in principle, but see fetchImage()
 */

const BASE = 'https://api.waifu.im';
const UA = 'earshot/1.0';
const PREFS_FILE = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  'waifu-prefs.json',
);

/**
 * Tags the API serves only as NSFW. The /tags endpoint does not expose a usable
 * nsfw flag, so this list is explicit — an unknown tag is treated as safe only
 * because the request itself is pinned to is_nsfw=false unless the channel is
 * age-restricted.
 */
const NSFW_TAGS = new Set(['ero', 'ecchi', 'hentai', 'milf', 'oppai', 'ass', 'paizuri', 'oral']);

/** Minimum gap between images in one guild, to stay polite to a free API. */
const COOLDOWN_MS = Number(process.env.WAIFU_COOLDOWN_SEC ?? 3) * 1000;
const lastPost = new Map(); // guildId -> timestamp

/* ------------------------------------------------------------------ */
/* Tag catalogue                                                        */
/* ------------------------------------------------------------------ */

let tagCache = null;
let tagCacheAt = 0;

/** Used when the tag endpoint is unreachable, so naming a tag still works. */
const FALLBACK_TAGS = [
  'waifu', 'maid', 'uniform', 'selfies', 'neko', 'wallpaper',
  'genshin-impact', 'raiden-shogun', 'marin-kitagawa', 'mori-calliope',
  'ero', 'ecchi', 'hentai', 'milf', 'oppai', 'ass', 'paizuri', 'oral',
].map((slug) => ({
  name: slug.replace(/-/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase()),
  slug,
  nsfw: NSFW_TAGS.has(slug),
}));

async function getTags() {
  if (tagCache && Date.now() - tagCacheAt < 6 * 60 * 60 * 1000) return tagCache;

  let body;
  try {
    const res = await fetch(`${BASE}/tags?full=true`, {
      headers: { 'User-Agent': UA, Accept: 'application/json' },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    body = await res.json();
  } catch (err) {
    console.warn(`[waifu] tag list unavailable (${err.message}), using built-in list`);
    tagCache = FALLBACK_TAGS;
    tagCacheAt = Date.now();
    return tagCache;
  }

  tagCache = (body.items ?? []).map((t) => ({
    name: t.name,
    slug: t.slug,
    description: t.description,
    nsfw: NSFW_TAGS.has(t.slug),
  }));
  tagCacheAt = Date.now();
  return tagCache;
}

const norm = (s) => String(s ?? '').normalize('NFKD').toLowerCase().replace(/[^a-z0-9]/g, '');

/** Map a spoken tag ("Raiden Shogun", "maid") onto an API slug. */
async function resolveTag(spoken) {
  const want = norm(spoken);
  if (!want) return null;
  const tags = await getTags();
  return (
    tags.find((t) => norm(t.slug) === want || norm(t.name) === want) ??
    tags.find((t) => norm(t.name).includes(want) || want.includes(norm(t.slug))) ??
    null
  );
}

/* ------------------------------------------------------------------ */
/* Preferences                                                          */
/* ------------------------------------------------------------------ */

function loadPrefs() {
  try {
    return JSON.parse(fs.readFileSync(PREFS_FILE, 'utf8'));
  } catch {
    return {};
  }
}

function savePrefs(prefs) {
  try {
    fs.writeFileSync(PREFS_FILE, JSON.stringify(prefs, null, 2));
  } catch (err) {
    console.warn('[waifu] could not save preferences:', err.message);
  }
}

/* ------------------------------------------------------------------ */
/* API                                                                  */
/* ------------------------------------------------------------------ */

/**
 * Fallback source.
 *
 * waifu.im puts its image endpoints behind a Cloudflare challenge that refuses
 * every non-browser client (curl included), and some networks block the other
 * usual hosts at DNS. nekos.life answers plain HTTP requests, so it stands in
 * when the primary is unreachable — fewer tags, but a working feature.
 */
const NEKOSAPI = 'https://api.nekosapi.com/v4/images/random';
const NEKOS_LIFE = 'https://nekos.life/api/v2/img';

/** waifu.im slugs -> nekosapi tag names. Unmapped slugs are tried verbatim. */
const NEKOSAPI_TAGS = {
  waifu: 'girl', neko: 'catgirl', 'fox-girl': 'kitsunemimi',
  maid: 'maid', uniform: 'uniform', selfies: 'selfie', oppai: 'large_breasts',
  ass: 'ass', milf: 'milf', paizuri: 'paizuri', oral: 'oral',
};

/**
 * nekosapi: reachable, genuinely random, and carries rating + tags + artist.
 * Preferred over nekos.life, whose adult endpoint returns one identical image
 * every single time — technically "working" and completely useless.
 */
async function fetchFromNekosApi({ tags = [], nsfw = false }) {
  const mapped = tags.map((t) => NEKOSAPI_TAGS[t] ?? t).filter(Boolean);

  // Try with tags, then without: an unknown tag should not mean no image.
  for (const useTags of mapped.length ? [true, false] : [false]) {
    const qs = new URLSearchParams({ rating: nsfw ? 'explicit' : 'safe', limit: '1' });
    if (useTags) qs.set('tags', mapped.join(','));

    const res = await fetch(`${NEKOSAPI}?${qs}`, {
      headers: { 'User-Agent': UA, Accept: 'application/json' },
    });
    if (!res.ok) continue;

    const body = await res.json();
    const img = (Array.isArray(body) ? body : (body.items ?? []))[0];
    if (!img?.url) continue;

    return {
      url: img.url,
      tags: (img.tags ?? []).slice(0, 6).map((t) => ({ name: t.name ?? t })),
      is_nsfw: img.rating === 'explicit',
      artist: img.artist_name ? { name: img.artist_name } : undefined,
      source: img.source_url ?? undefined,
      dominant_color: img.color_dominant ?? undefined,
      provider: 'nekosapi',
    };
  }
  throw new Error('nekosapi returned no image.');
}

/** waifu.im tag -> nearest nekos.life category. */
const NEKOS_MAP = {
  waifu: 'waifu', neko: 'neko', catgirl: 'neko', 'fox-girl': 'fox_girl',
  selfies: 'waifu', maid: 'waifu', uniform: 'waifu', smug: 'smug',
  hug: 'hug', kiss: 'kiss', pat: 'pat', cuddle: 'cuddle', slap: 'slap',
  wallpaper: 'wallpaper',
  // Adult categories, still gated on an age-restricted channel.
  ero: 'lewd', ecchi: 'lewd', hentai: 'lewd', oppai: 'lewd',
  ass: 'lewd', milf: 'lewd', paizuri: 'lewd', oral: 'lewd',
};

const NEKOS_NSFW = new Set(['lewd', 'gasm', 'spank']);

async function fetchFromNekosLife({ tags = [], nsfw = false }) {
  const category =
    tags.map((t) => NEKOS_MAP[t]).find(Boolean) ?? (nsfw ? 'lewd' : 'waifu');
  if (NEKOS_NSFW.has(category) && !nsfw) throw new Error('That category is adult-only.');

  const res = await fetch(`${NEKOS_LIFE}/${category}`, {
    headers: { 'User-Agent': UA, Accept: 'application/json' },
  });
  if (!res.ok) throw new Error(`nekos.life returned HTTP ${res.status}.`);
  const body = await res.json();
  if (!body.url) throw new Error('nekos.life returned no image.');

  return {
    url: body.url,
    tags: [{ name: category }],
    is_nsfw: NEKOS_NSFW.has(category),
    provider: 'nekos.life',
  };
}

export async function fetchImage({ tags = [], nsfw = false, gif = null, orientation = null }) {
  const qs = new URLSearchParams();
  for (const t of tags) qs.append('included_tags', t);
  qs.set('is_nsfw', nsfw ? 'true' : 'false');
  if (gif !== null) qs.set('gif', String(gif));
  if (orientation) qs.set('orientation', orientation);
  qs.set('limit', '1');

  const headers = { 'User-Agent': UA, Accept: 'application/json' };
  // The docs describe X-Api-Key; older deployments accept a bearer token. Send
  // both when a token exists — the unused one is ignored.
  if (process.env.WAIFU_TOKEN) {
    headers['X-Api-Key'] = process.env.WAIFU_TOKEN;
    headers.Authorization = `Bearer ${process.env.WAIFU_TOKEN}`;
  }

  const res = await fetch(`${BASE}/search?${qs}`, { headers });

  if (res.status === 403 || res.status === 503) {
    const body = await res.text();
    if (/challenge|cf_chl|Just a moment/i.test(body)) {
      throw new Error(
        'waifu.im is serving a Cloudflare bot check to this machine rather than the API. ' +
          'An API token usually clears it — create one at https://waifu.im/dashboard and ' +
          'put it in WAIFU_TOKEN.',
      );
    }
    throw new Error(`waifu.im refused the request (HTTP ${res.status}).`);
  }
  if (res.status === 404) throw new Error('No image matched those tags.');
  if (res.status === 429) throw new Error('Rate limited by waifu.im — try again shortly.');
  if (!res.ok) throw new Error(`waifu.im returned HTTP ${res.status}.`);

  const body = await res.json();
  const image = (body.images ?? [])[0];
  if (!image) throw new Error('No image matched those tags.');
  return image;
}

/** Build the Discord embed for an image. */
export function buildEmbed(image, { requestedBy } = {}) {
  const embed = new EmbedBuilder()
    .setColor(image.dominant_color ?? '#ff69b4')
    .setImage(image.url)
    .setFooter({
      text: [
        image.tags?.map((t) => t.name).join(', '),
        requestedBy ? `for ${requestedBy}` : null,
        image.provider ?? 'waifu.im',
      ]
        .filter(Boolean)
        .join(' • ')
        .slice(0, 2048),
    });

  if (image.artist?.name) {
    embed.setAuthor({
      name: `Artist: ${image.artist.name}`.slice(0, 256),
      url: image.artist.deviant_art ?? image.artist.pixiv ?? image.artist.twitter ?? undefined,
    });
  }
  if (image.source) embed.setURL(image.source).setTitle('Source');
  return embed;
}

/**
 * Post an image into a channel.
 *
 * NSFW is gated on Discord's own age-restriction flag rather than a setting of
 * our own: that is the mechanism Discord requires, and it keeps the decision
 * with whoever configured the channel.
 */
export async function postImage(channel, { tags = [], nsfw = false, gif = null, orientation = null, requestedBy } = {}) {
  if (!channel) throw new Error('There is no text channel to post into.');

  const guildId = channel.guild?.id ?? 'dm';
  const since = Date.now() - (lastPost.get(guildId) ?? 0);
  if (since < COOLDOWN_MS) {
    throw new Error(`Slow down — ${Math.ceil((COOLDOWN_MS - since) / 1000)}s until the next image.`);
  }

  const resolved = [];
  for (const raw of tags) {
    const tag = await resolveTag(raw);
    if (!tag) {
      const all = (await getTags()).filter((t) => !t.nsfw).map((t) => t.name);
      throw new Error(`No tag called "${raw}". Available: ${all.join(', ')}.`);
    }
    resolved.push(tag);
  }

  const wantsNsfw = nsfw || resolved.some((t) => t.nsfw);
  if (wantsNsfw && !channel.nsfw) {
    throw new Error(
      `#${channel.name} is not age-restricted, so I can only post safe images here. ` +
        'To allow adult ones: Edit Channel, then turn on Age-Restricted Channel. ' +
        'Discord requires that for NSFW content.',
    );
  }

  const slugs = resolved.map((t) => t.slug);
  const provider = process.env.WAIFU_PROVIDER ?? 'auto';

  // Providers in preference order, filtered by the configured choice.
  const chain = {
    'waifu.im': [() => fetchImage({ tags: slugs, nsfw: wantsNsfw, gif, orientation })],
    nekosapi: [() => fetchFromNekosApi({ tags: slugs, nsfw: wantsNsfw })],
    'nekos.life': [() => fetchFromNekosLife({ tags: slugs, nsfw: wantsNsfw })],
    auto: [
      () => fetchImage({ tags: slugs, nsfw: wantsNsfw, gif, orientation }),
      () => fetchFromNekosApi({ tags: slugs, nsfw: wantsNsfw }),
      // Last resort, and only for safe images — its adult endpoint is a single
      // repeated picture, which is worse than admitting failure.
      () => (wantsNsfw ? Promise.reject(new Error('no adult source left')) : fetchFromNekosLife({ tags: slugs, nsfw: false })),
    ],
  }[provider] ?? [];

  let image, lastError;
  for (const attempt of chain) {
    try {
      image = await attempt();
      break;
    } catch (err) {
      lastError = err;
      if (chain.length > 1) console.warn(`[waifu] provider failed: ${err.message.split('.')[0]}`);
    }
  }
  if (!image) throw lastError ?? new Error('No image provider was reachable.');

  lastPost.set(guildId, Date.now());
  await channel.send({ embeds: [buildEmbed(image, { requestedBy })] });
  return {
    posted: `Sent a ${resolved.map((t) => t.name).join(' + ') || 'random'} image to #${channel.name}`,
  };
}

/* ------------------------------------------------------------------ */
/* Tools exposed to Gemini                                              */
/* ------------------------------------------------------------------ */

export const waifuDeclarations = [
  {
    name: 'send_waifu_image',
    description:
      'Post a random anime artwork into the text channel. Use when someone asks for a waifu, ' +
      'anime picture, or a specific character. Omit tags to use the requester saved preference. ' +
      'Set nsfw when they ask for adult, lewd or NSFW content — that only works in a channel ' +
      'Discord has marked age-restricted, and the tool says so plainly if it is not.',
    parameters: {
      type: Type.OBJECT,
      properties: {
        tags: {
          type: Type.ARRAY,
          items: { type: Type.STRING },
          description: 'Tags such as waifu, maid, uniform, selfies, raiden-shogun, marin-kitagawa',
        },
        nsfw: {
          type: Type.BOOLEAN,
          description: 'true when adult/NSFW content was explicitly asked for',
        },
        orientation: {
          type: Type.STRING,
          description: 'PORTRAIT, LANDSCAPE or SQUARE',
        },
        gif: { type: Type.BOOLEAN, description: 'true for animated only, false to exclude gifs' },
      },
    },
  },
  {
    name: 'set_waifu_preference',
    description:
      'Remember the tags this person likes, used whenever they later ask for an image ' +
      'without naming a tag.',
    parameters: {
      type: Type.OBJECT,
      properties: {
        tags: {
          type: Type.ARRAY,
          items: { type: Type.STRING },
          description: 'Tags to remember for this person',
        },
      },
      required: ['tags'],
    },
  },
  {
    name: 'list_waifu_tags',
    description: 'List the tags waifu.im supports, so you can offer real choices.',
    parameters: { type: Type.OBJECT, properties: {} },
  },
];

export const waifuHandlers = {
  async send_waifu_image(ctx, { tags, nsfw, orientation, gif }) {
    const prefs = loadPrefs();
    const chosen = tags?.length ? tags : (prefs[ctx.requester?.id]?.tags ?? []);

    return postImage(ctx.textChannel, {
      tags: chosen,
      nsfw: Boolean(nsfw),
      gif: gif ?? null,
      orientation: orientation ? String(orientation).toUpperCase() : null,
      requestedBy: ctx.requester?.displayName,
    });
  },

  async set_waifu_preference(ctx, { tags }) {
    if (!ctx.requester) throw new Error("I can't tell who is asking.");
    const resolved = [];
    for (const raw of tags ?? []) {
      const tag = await resolveTag(raw);
      if (!tag) throw new Error(`No tag called "${raw}".`);
      resolved.push(tag.slug);
    }
    if (!resolved.length) throw new Error('Name at least one tag.');

    const prefs = loadPrefs();
    prefs[ctx.requester.id] = { tags: resolved, name: ctx.requester.displayName };
    savePrefs(prefs);
    return { done: `Saved ${ctx.requester.displayName}'s preference: ${resolved.join(', ')}` };
  },

  async list_waifu_tags(ctx) {
    const tags = await getTags();
    const allowed = tags.filter((t) => !t.nsfw || ctx.textChannel?.nsfw);
    return {
      tags: allowed.map((t) => ({ name: t.name, slug: t.slug, images: t.imageCount })),
      note: ctx.textChannel?.nsfw ? undefined : 'Adult tags hidden: this channel is not age-restricted.',
    };
  },
};
