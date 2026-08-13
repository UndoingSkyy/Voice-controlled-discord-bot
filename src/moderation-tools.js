import { PermissionFlagsBits } from 'discord.js';
import { Type } from '@google/genai';
import { waifuDeclarations, waifuHandlers } from './waifu.js';
import { memoryDeclarations, memoryHandlers } from './memory.js';
import { adminDeclarations, adminHandlers } from './admin-tools.js';

/**
 * Voice-driven moderation.
 *
 * Gemini decides *what* was asked; this module decides whether it is allowed.
 * Every action is authorised against the permissions of the person who spoke —
 * never the bot's own. Otherwise anyone who can join the voice channel could
 * borrow the bot's admin rights just by talking.
 */

const DRY_RUN = Boolean(process.env.MOD_DRY_RUN);

/** Tool schema handed to Gemini: moderation plus the waifu.im tools. */
export const moderationDeclarations = [
  ...memoryDeclarations,
  ...adminDeclarations,
  ...waifuDeclarations,
  {
    name: 'list_members',
    description:
      'List everyone in ALL voice channels of the server, grouped by channel, with their ' +
      'roles. You can act on members in any voice channel, not only your own. Use this to ' +
      'resolve an ambiguous or partially-heard name before acting on someone.',
    parameters: { type: Type.OBJECT, properties: {} },
  },
  {
    name: 'list_channels',
    description:
      'List every voice channel in the server, including empty ones, with how many people are ' +
      'in each. Call this before saying a channel does not exist — list_members only shows ' +
      'channels that currently have people in them.',
    parameters: { type: Type.OBJECT, properties: {} },
  },
  {
    name: 'mute_member',
    description: 'Server-mute or unmute a member in the voice channel.',
    parameters: {
      type: Type.OBJECT,
      properties: {
        target: { type: Type.STRING, description: 'Display name or username of the member' },
        mute: { type: Type.BOOLEAN, description: 'true to mute, false to unmute' },
      },
      required: ['target', 'mute'],
    },
  },
  {
    name: 'deafen_member',
    description: 'Server-deafen or undeafen a member in the voice channel.',
    parameters: {
      type: Type.OBJECT,
      properties: {
        target: { type: Type.STRING, description: 'Display name or username of the member' },
        deafen: { type: Type.BOOLEAN, description: 'true to deafen, false to undeafen' },
      },
      required: ['target', 'deafen'],
    },
  },
  {
    name: 'disconnect_member',
    description: 'Disconnect a member from the voice channel. Destructive — confirm out loud first.',
    parameters: {
      type: Type.OBJECT,
      properties: {
        target: { type: Type.STRING, description: 'Display name or username of the member' },
      },
      required: ['target'],
    },
  },
  {
    name: 'move_member',
    description:
      'Move a member from their current voice channel into a different one. Works for members ' +
      'in any voice channel — they do not need to be in the same channel as you.',
    parameters: {
      type: Type.OBJECT,
      properties: {
        target: { type: Type.STRING, description: 'Display name or username of the member' },
        channel: { type: Type.STRING, description: 'Name of the destination voice channel' },
      },
      required: ['target', 'channel'],
    },
  },
  {
    name: 'get_member_activity',
    description:
      "Report what a member is currently doing — the game they're playing, music they're " +
      'listening to, whether they are streaming, and their online status.',
    parameters: {
      type: Type.OBJECT,
      properties: {
        target: { type: Type.STRING, description: 'Display name or username of the member' },
      },
      required: ['target'],
    },
  },
  {
    name: 'timeout_member',
    description:
      'Time a member out so they cannot speak or message. Destructive — confirm out loud first.',
    parameters: {
      type: Type.OBJECT,
      properties: {
        target: { type: Type.STRING, description: 'Display name or username of the member' },
        minutes: { type: Type.NUMBER, description: 'Duration in minutes, 0 to clear the timeout' },
      },
      required: ['target', 'minutes'],
    },
  },
  {
    name: 'manage_role',
    description: 'Give a role to, or take a role from, a member.',
    parameters: {
      type: Type.OBJECT,
      properties: {
        target: { type: Type.STRING, description: 'Display name or username of the member' },
        role: { type: Type.STRING, description: 'Name of the role' },
        add: { type: Type.BOOLEAN, description: 'true to add the role, false to remove it' },
      },
      required: ['target', 'role', 'add'],
    },
  },
  {
    name: 'delete_messages',
    description:
      'Bulk-delete the most recent messages in the text channel. Destructive and irreversible — ' +
      'state the number out loud and get agreement before calling this.',
    parameters: {
      type: Type.OBJECT,
      properties: {
        count: { type: Type.NUMBER, description: 'How many recent messages to delete (1-100)' },
        from_member: {
          type: Type.STRING,
          description: 'Optional: only delete messages sent by this member',
        },
      },
      required: ['count'],
    },
  },
];

/* ------------------------------------------------------------------ */
/* Resolution helpers                                                   */
/* ------------------------------------------------------------------ */

/**
 * Fold a spoken or displayed name to a comparable key.
 *
 * NFKD matters more than it looks: Discord names are full of styled Unicode
 * ("𝖯𝖠𝖱𝖠𝖪𝖨𝖤𝖳", "ＴＨＥ ＰＵＢ"), and those letters are not ASCII. Without
 * decomposing them first, stripping non-alphanumerics leaves an empty string
 * and the channel or member can never be matched by name.
 */
const norm = (s) =>
  String(s ?? '')
    .normalize('NFKD')
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '');

/** Everyone in any voice channel of the guild, excluding a given channel. */
function voiceMembersElsewhere(ctx) {
  const out = [];
  for (const ch of ctx.guild.channels.cache.values()) {
    if (!ch.isVoiceBased?.() || ch.id === ctx.voiceChannel.id) continue;
    out.push(...ch.members.values());
  }
  return out;
}

/** Levenshtein distance, abandoned early once it exceeds `max`. */
function editDistance(a, b, max) {
  if (Math.abs(a.length - b.length) > max) return max + 1;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const row = [i];
    let best = i;
    for (let j = 1; j <= b.length; j++) {
      row[j] = Math.min(
        prev[j] + 1,
        row[j - 1] + 1,
        prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
      best = Math.min(best, row[j]);
    }
    if (best > max) return max + 1;
    prev = row;
  }
  return prev[b.length];
}

/** Normalised name forms for a member, with unusable (empty) ones dropped. */
function nameForms(m) {
  return [m.displayName, m.user?.username, m.nickname]
    .filter(Boolean)
    .map(norm)
    .filter((n) => n.length > 0);
}

/**
 * Find a member by spoken name.
 *
 * Speech-to-text mangles names, so matching has to be forgiving — but a loose
 * match that picks the wrong person gets someone muted by mistake, so looseness
 * is rationed: exact first, then prefix, then substring with a length floor.
 * Decorated Discord names normalise to nothing at all, and those are discarded
 * rather than allowed to match everything.
 */
function resolveMember(ctx, spoken) {
  const want = norm(spoken);
  if (!want) return null;

  // Prefer whoever is in the bot's channel, then anyone else in voice, then the
  // wider guild — a bot can act on members it isn't sitting next to.
  const pools = [
    [...ctx.voiceChannel.members.values()],
    voiceMembersElsewhere(ctx),
    [...ctx.guild.members.cache.values()],
  ];

  for (const pool of pools) {
    const exact = pool.find((m) => nameForms(m).some((n) => n === want));
    if (exact) return exact;

    // Nobody says "mute me" by naming themselves, and the bot isn't a target
    // either. Excluding both stops a sloppy match from landing on the speaker.
    const candidates = pool.filter(
      (m) => m.id !== ctx.requester?.id && m.id !== ctx.guild.members.me?.id,
    );

    const matches = (m) =>
      nameForms(m).some((n) => {
        if (n.startsWith(want) || want.startsWith(n)) return true;
        // Substring either way, but only for names long enough to be meaningful.
        const shorter = Math.min(n.length, want.length);
        return shorter >= 3 && (n.includes(want) || want.includes(n));
      });

    let partial = candidates.filter(matches);

    // Last resort for a misheard name ("rok" for "Rock"): allow a single
    // character of difference, and only when exactly one person is that close.
    if (partial.length === 0 && want.length >= 3) {
      partial = candidates.filter((m) =>
        nameForms(m).some((n) => n.length >= 3 && editDistance(n, want, 1) <= 1),
      );
    }

    if (partial.length === 1) return partial[0];
    if (partial.length > 1) {
      const err = new Error(
        `"${spoken}" could be ${partial.length} different people: ${partial
          .map((m) => m.displayName)
          .join(', ')}. Ask which one they mean.`,
      );
      err.ambiguous = true;
      throw err;
    }
  }
  return null;
}

function resolveVoiceChannel(ctx, spoken) {
  const want = norm(spoken);
  const channels = [...ctx.guild.channels.cache.values()].filter((c) => c.isVoiceBased?.());
  return (
    channels.find((c) => norm(c.name) === want) ??
    channels.find((c) => norm(c.name).includes(want) || want.includes(norm(c.name))) ??
    null
  );
}

function resolveRole(ctx, spoken) {
  const want = norm(spoken);
  const roles = [...ctx.guild.roles.cache.values()].filter((r) => r.name !== '@everyone');
  return (
    roles.find((r) => norm(r.name) === want) ??
    roles.find((r) => norm(r.name).includes(want) || want.includes(norm(r.name))) ??
    null
  );
}

/**
 * Discord's role hierarchy, enforced for both parties: you cannot act on
 * someone ranked at or above you, and neither can the bot.
 */
function assertHierarchy(ctx, target) {
  if (target.id === ctx.guild.ownerId) throw new Error('That is the server owner.');
  if (target.id === ctx.requester.id) throw new Error('That command targets yourself.');

  const isOwner = ctx.requester.id === ctx.guild.ownerId;
  if (!isOwner && ctx.requester.roles.highest.comparePositionTo(target.roles.highest) <= 0) {
    throw new Error(`${target.displayName} is ranked at or above you, so you cannot moderate them.`);
  }
  const me = ctx.guild.members.me;
  if (me.roles.highest.comparePositionTo(target.roles.highest) <= 0) {
    // Not a permissions problem — Discord blocks this even for administrators.
    throw new Error(
      `This is a role hierarchy problem, not a missing permission. My role ` +
        `"${me.roles.highest.name}" sits below ${target.displayName}'s role ` +
        `"${target.roles.highest.name}". Drag my role higher in Server Settings then Roles.`,
    );
  }
}

/**
 * Check the permission as it applies *in the relevant channel*, so per-channel
 * overwrites are honoured rather than only server-wide roles.
 */
function assertPermission(ctx, flag, label, channel = ctx.voiceChannel) {
  if (!channel.permissionsFor(ctx.requester)?.has(flag)) {
    throw new Error(`You don't have the "${label}" permission, so I won't do that.`);
  }
  if (!channel.permissionsFor(ctx.guild.members.me)?.has(flag)) {
    throw new Error(`I don't have the "${label}" permission here.`);
  }
}

/* ------------------------------------------------------------------ */
/* Execution                                                            */
/* ------------------------------------------------------------------ */

const reason = (ctx) => `Voice command by ${ctx.requester.user.tag}`;

const handlers = {
  ...adminHandlers,
  ...waifuHandlers,
  ...memoryHandlers,

  list_channels(ctx) {
    const me = ctx.guild.members.me;
    const channels = [];
    for (const ch of ctx.guild.channels.cache.values()) {
      if (!ch.isVoiceBased?.()) continue;
      channels.push({
        name: ch.name,
        people: ch.members?.size ?? 0,
        is_my_channel: ch.id === ctx.voiceChannel.id,
        can_move_people_here: Boolean(
          ch.permissionsFor(me)?.has(PermissionFlagsBits.MoveMembers),
        ),
      });
    }
    if (!channels.length) throw new Error('I cannot see any voice channels in this server.');
    return { voice_channels: channels };
  },

  list_members(ctx) {
    const describe = (m) => ({
      name: m.displayName,
      roles: m.roles.cache.filter((r) => r.name !== '@everyone').map((r) => r.name),
      muted: m.voice.serverMute ?? false,
    });

    // Report every voice channel, not just ours — members elsewhere can still
    // be moved, muted or disconnected.
    const channels = [];
    for (const ch of ctx.guild.channels.cache.values()) {
      if (!ch.isVoiceBased?.() || ch.members.size === 0) continue;
      channels.push({
        channel: ch.name,
        is_my_channel: ch.id === ctx.voiceChannel.id,
        members: [...ch.members.values()].map(describe),
      });
    }
    return { voice_channels: channels };
  },

  async mute_member(ctx, { target, mute }) {
    const member = mustFind(ctx, target);
    if (!member.voice.channel) throw new Error(`${member.displayName} is not in a voice channel.`);
    // The permission that matters is the one in *their* channel, not ours.
    assertPermission(ctx, PermissionFlagsBits.MuteMembers, 'Mute Members', member.voice.channel);
    assertHierarchy(ctx, member);

    if (!DRY_RUN) await member.voice.setMute(Boolean(mute), reason(ctx));
    return { done: `${mute ? 'Muted' : 'Unmuted'} ${member.displayName}` };
  },

  async deafen_member(ctx, { target, deafen }) {
    const member = mustFind(ctx, target);
    if (!member.voice.channel) throw new Error(`${member.displayName} is not in a voice channel.`);
    assertPermission(ctx, PermissionFlagsBits.DeafenMembers, 'Deafen Members', member.voice.channel);
    assertHierarchy(ctx, member);

    if (!DRY_RUN) await member.voice.setDeaf(Boolean(deafen), reason(ctx));
    return { done: `${deafen ? 'Deafened' : 'Undeafened'} ${member.displayName}` };
  },

  async disconnect_member(ctx, { target }) {
    const member = mustFind(ctx, target);
    if (!member.voice.channel) throw new Error(`${member.displayName} is not in a voice channel.`);
    assertPermission(ctx, PermissionFlagsBits.MoveMembers, 'Move Members', member.voice.channel);
    assertHierarchy(ctx, member);

    if (!DRY_RUN) await member.voice.disconnect(reason(ctx));
    return { done: `Disconnected ${member.displayName}` };
  },

  async move_member(ctx, { target, channel }) {
    const member = mustFind(ctx, target);
    if (!member.voice.channel) throw new Error(`${member.displayName} is not in a voice channel.`);
    // Moving needs the permission in the channel they're leaving and the one
    // they're arriving in.
    assertPermission(ctx, PermissionFlagsBits.MoveMembers, 'Move Members', member.voice.channel);
    assertHierarchy(ctx, member);

    const dest = resolveVoiceChannel(ctx, channel);
    if (!dest) {
      const available = [...ctx.guild.channels.cache.values()]
        .filter((c) => c.isVoiceBased?.())
        .map((c) => c.name);
      throw new Error(
        `No voice channel called "${channel}".` +
          (available.length ? ` The voice channels are: ${available.join(', ')}.` : ''),
      );
    }
    if (dest.id === member.voice.channelId) {
      throw new Error(`${member.displayName} is already in ${dest.name}.`);
    }
    // Moving someone somewhere they cannot be would just bounce them out.
    if (!dest.permissionsFor(member)?.has(PermissionFlagsBits.Connect)) {
      throw new Error(`${member.displayName} isn't allowed into ${dest.name}.`);
    }
    assertPermission(ctx, PermissionFlagsBits.MoveMembers, 'Move Members', dest);

    if (!DRY_RUN) await member.voice.setChannel(dest, reason(ctx));
    return { done: `Moved ${member.displayName} to ${dest.name}` };
  },

  get_member_activity(ctx, { target }) {
    const member = mustFind(ctx, target);
    const presence = member.presence;

    if (!presence) {
      // Either the intent is off, or Discord genuinely has nothing for them.
      if (!ctx.presenceEnabled) {
        throw new Error(
          'I cannot see activity — the presence intent is disabled. ' +
            'Set ENABLE_PRESENCE=1 and enable Presence Intent in the Developer Portal.',
        );
      }
      return { name: member.displayName, status: 'offline or invisible', activities: [] };
    }

    const activities = presence.activities.map((a) => {
      // Type 2 is Spotify/listening, where details/state carry track and artist.
      if (a.type === 2) return { listening: a.details, by: a.state, on: a.name };
      if (a.type === 1) return { streaming: a.name, url: a.url };
      return { [['playing', 'streaming', 'listening', 'watching', 'custom', 'competing'][a.type] ?? 'doing']: a.name, details: a.details ?? undefined, state: a.state ?? undefined };
    });

    return {
      name: member.displayName,
      status: presence.status, // online / idle / dnd / offline
      activities: activities.length ? activities : 'nothing right now',
    };
  },

  async timeout_member(ctx, { target, minutes }) {
    assertPermission(ctx, PermissionFlagsBits.ModerateMembers, 'Timeout Members');
    const member = mustFind(ctx, target);
    assertHierarchy(ctx, member);

    const mins = Number(minutes);
    if (!Number.isFinite(mins) || mins < 0 || mins > 40320) {
      throw new Error('Timeout must be between 0 and 40320 minutes (28 days).');
    }

    if (!DRY_RUN) await member.timeout(mins > 0 ? mins * 60_000 : null, reason(ctx));
    return {
      done: mins > 0 ? `Timed out ${member.displayName} for ${mins} min` : `Cleared ${member.displayName}'s timeout`,
    };
  },

  async manage_role(ctx, { target, role, add }) {
    assertPermission(ctx, PermissionFlagsBits.ManageRoles, 'Manage Roles');
    const member = mustFind(ctx, target);
    const r = resolveRole(ctx, role);
    if (!r) throw new Error(`No role called "${role}".`);
    if (r.managed) throw new Error(`"${r.name}" is managed by an integration and can't be assigned.`);

    // A role you don't outrank is a role you can't hand out.
    const isOwner = ctx.requester.id === ctx.guild.ownerId;
    if (!isOwner && ctx.requester.roles.highest.comparePositionTo(r) <= 0) {
      throw new Error(`"${r.name}" is ranked at or above your highest role.`);
    }
    if (ctx.guild.members.me.roles.highest.comparePositionTo(r) <= 0) {
      throw new Error(`"${r.name}" is above my highest role, so I can't assign it.`);
    }

    if (!DRY_RUN) {
      if (add) await member.roles.add(r, reason(ctx));
      else await member.roles.remove(r, reason(ctx));
    }
    return { done: `${add ? 'Gave' : 'Removed'} "${r.name}" ${add ? 'to' : 'from'} ${member.displayName}` };
  },

  async delete_messages(ctx, { count, from_member }) {
    assertPermission(ctx, PermissionFlagsBits.ManageMessages, 'Manage Messages', ctx.textChannel);
    const n = Math.floor(Number(count));
    if (!Number.isFinite(n) || n < 1 || n > 100) {
      throw new Error('I can delete between 1 and 100 messages at a time.');
    }
    if (!ctx.textChannel?.bulkDelete) throw new Error('This channel does not support bulk delete.');

    let targetId = null;
    if (from_member) targetId = mustFind(ctx, from_member).id;

    // Fetch a wider window when filtering, so we can still find n from one person.
    const fetched = await ctx.textChannel.messages.fetch({ limit: targetId ? 100 : n });
    const cutoff = Date.now() - 13.5 * 24 * 60 * 60 * 1000; // bulkDelete refuses >14d
    const doomed = [...fetched.values()]
      .filter((m) => (targetId ? m.author.id === targetId : true))
      .filter((m) => m.createdTimestamp > cutoff)
      .slice(0, n);

    if (!doomed.length) throw new Error('Found no deletable messages (they may be over 14 days old).');
    if (!DRY_RUN) await ctx.textChannel.bulkDelete(doomed, true);

    return { done: `Deleted ${doomed.length} message(s)${from_member ? ` from ${from_member}` : ''}` };
  },
};

function mustFind(ctx, spoken) {
  const member = resolveMember(ctx, spoken);
  if (!member) {
    // Name the people actually present, so the model can offer real options
    // instead of guessing again at a name it already misheard.
    const here = [...ctx.voiceChannel.members.values()]
      .filter((m) => m.id !== ctx.guild.members.me?.id)
      .map((m) => m.displayName);
    throw new Error(
      `I couldn't find anyone called "${spoken}".` +
        (here.length ? ` In this channel I can see: ${here.join(', ')}.` : ''),
    );
  }
  return member;
}

/**
 * Actions that cannot be undone, with a plain description for the prompt.
 *
 * These are enforced in two phases. Asking the model to "confirm first" is not
 * enough: it happily performs the action, then asks, then performs it a second
 * time when the person agrees — deleting ten messages when five were wanted.
 * The first call here never acts, so a double-run is impossible.
 */
const DESTRUCTIVE = {
  kick_member: (a) => `kick ${a.target} from the server`,
  ban_member: (a) => `BAN ${a.target} from the server`,
  manage_channel: (a) => (String(a.action).toLowerCase() === 'delete' ? `delete the channel "${a.name}"` : null),
  manage_server_role: (a) => (String(a.action).toLowerCase() === 'delete' ? `delete the role "${a.name}"` : null),
  mute_everyone: (a) => (a.mute ? `mute everyone in the voice channel` : null),
  move_everyone: (a) => `move everyone into ${a.to}`,
  delete_messages: (a) =>
    `delete the last ${a.count} message(s)${a.from_member ? ` from ${a.from_member}` : ''}`,
  disconnect_member: (a) => `disconnect ${a.target} from voice`,
  // A deleted emoji cannot be restored, and a cancelled event loses everyone
  // who had signed up for it.
  manage_emoji: (a) => (String(a.action).toLowerCase().startsWith('delete') ? `delete the emoji "${a.name}"` : null),
  manage_event: (a) => (String(a.action).toLowerCase().startsWith('cancel') ? `cancel the event "${a.name}"` : null),
  timeout_member: (a) =>
    Number(a.minutes) > 0 ? `time ${a.target} out for ${a.minutes} minute(s)` : null,
  // Someone may be relying on a stored number or reminder; deleting it silently
  // on a misheard word is the same class of mistake as over-deleting messages.
  forget_memory: (a) => `forget what was saved about "${a.query}"`,
};

/**
 * The permission each destructive action needs, checked *before* the
 * confirmation prompt. Handlers check it again when they actually run; this
 * copy exists only so an unauthorised request is refused rather than queued.
 */
const DESTRUCTIVE_PERMISSION = {
  kick_member: [PermissionFlagsBits.KickMembers, 'Kick Members'],
  ban_member: [PermissionFlagsBits.BanMembers, 'Ban Members'],
  disconnect_member: [PermissionFlagsBits.MoveMembers, 'Move Members'],
  timeout_member: [PermissionFlagsBits.ModerateMembers, 'Timeout Members'],
  delete_messages: [PermissionFlagsBits.ManageMessages, 'Manage Messages'],
  manage_channel: [PermissionFlagsBits.ManageChannels, 'Manage Channels'],
  manage_server_role: [PermissionFlagsBits.ManageRoles, 'Manage Roles'],
  mute_everyone: [PermissionFlagsBits.MuteMembers, 'Mute Members'],
  move_everyone: [PermissionFlagsBits.MoveMembers, 'Move Members'],
};

const CONFIRM_TTL_MS = Number(process.env.MOD_CONFIRM_TTL_SEC ?? 120) * 1000;
const CONFIRM_ENABLED = process.env.MOD_CONFIRM_DESTRUCTIVE !== '0';
const pendingConfirm = new Map(); // signature -> requested at

function confirmationGate(name, args, ctx) {
  if (!CONFIRM_ENABLED) return null;
  const describe = DESTRUCTIVE[name];
  if (!describe) return null;

  const what = describe(args ?? {});
  if (!what) return null; // e.g. clearing a timeout, which is not destructive

  const key = `${ctx.guild?.id}:${ctx.requester?.id}:${name}:${JSON.stringify(args ?? {})}`;
  const requestedAt = pendingConfirm.get(key);

  if (requestedAt && Date.now() - requestedAt <= CONFIRM_TTL_MS) {
    pendingConfirm.delete(key); // agreed to — let it through
    return null;
  }

  // Drop stale entries so an abandoned request cannot be "confirmed" much later.
  for (const [k, at] of pendingConfirm) {
    if (Date.now() - at > CONFIRM_TTL_MS) pendingConfirm.delete(k);
  }
  pendingConfirm.set(key, Date.now());

  return {
    needs_confirmation: true,
    about_to: what,
    instruction:
      `NOTHING HAS HAPPENED YET. Ask out loud whether to ${what}, then stop and wait. ` +
      'If they agree, call this tool again with exactly the same arguments and it will ' +
      'go ahead. If they decline or change the number, do not call it again with these ' +
      'arguments.',
  };
}

/**
 * Run one tool call. Never throws — Gemini gets the error text back so it can
 * explain the refusal out loud instead of the session dying.
 */
export async function executeTool(name, args, ctx) {
  const handler = handlers[name];
  if (!handler) return { error: `Unknown tool "${name}".` };

  // Read-only lookups and image posting are harmless without knowing exactly
  // who spoke; anything that changes a member's state is not.
  const NEEDS_IDENTITY = ![
    'list_members', 'list_channels', 'list_waifu_tags', 'send_waifu_image',
    'get_current_time', 'catch_up', 'search_conversation', 'server_info', 'member_info', 'list_bans', 'set_reply_language',
  ].includes(name);
  // read_channel_messages, audit_log and the list actions are read-only too,
  // but they still name people, so they keep the identity requirement.
  if (NEEDS_IDENTITY && !ctx.requester) {
    return { error: "I couldn't tell who asked, so I won't run that command." };
  }

  // Admin handlers live in another module; hand them the shared checks rather
  // than importing back into this one and creating a cycle.
  ctx.helpers = { mustFind, assertPermission, assertHierarchy, resolveMember };

  try {
    // Validate before asking, so "I can't find Rock" surfaces now rather than
    // after someone has already agreed to something.
    if (DESTRUCTIVE[name] && args?.target) mustFind(ctx, args.target);

    // And check they're allowed at all before asking them to confirm —
    // otherwise a user with no permission is invited to approve something that
    // was never going to happen.
    const needed = DESTRUCTIVE_PERMISSION[name];
    if (needed) assertPermission(ctx, needed[0], needed[1], ctx.textChannel);

    const gate = confirmationGate(name, args, ctx);
    if (gate) {
      console.log(`[mod] ${ctx.requester.user.tag}: ${name} awaiting confirmation — ${gate.about_to}`);
      return gate;
    }

    const result = await handler(ctx, args ?? {});
    if (result.posted) console.log(`[waifu] ${ctx.requester?.user?.tag ?? '?'}: ${result.posted}`);
    if (result.done) {
      console.log(`[mod] ${ctx.requester.user.tag}: ${name} -> ${result.done}`);
      if (DRY_RUN) result.done += ' (dry run — nothing actually changed)';
    }
    return result;
  } catch (err) {
    console.warn(`[mod] ${ctx.requester.user.tag}: ${name} refused — ${err.message}`);
    return { error: err.message };
  }
}
