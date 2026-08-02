import { PermissionFlagsBits } from 'discord.js';
import { Type } from '@google/genai';

/**
 * Voice-driven moderation.
 *
 * Gemini decides *what* was asked; this module decides whether it is allowed.
 * Every action is authorised against the permissions of the person who spoke —
 * never the bot's own. Otherwise anyone who can join the voice channel could
 * borrow the bot's admin rights just by talking.
 */

const DRY_RUN = Boolean(process.env.MOD_DRY_RUN);

/** Tool schema handed to Gemini. */
export const moderationDeclarations = [
  {
    name: 'list_members',
    description:
      'List members currently in the voice channel, with their roles. Use this to resolve ' +
      'an ambiguous or partially-heard name before acting on someone.',
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
    description: 'Move a member from their current voice channel into a different one.',
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

const norm = (s) => String(s ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');

/**
 * Find a member by spoken name. Speech-to-text mangles names, so we try
 * progressively looser matches, and we prefer people in the voice channel
 * because that's who a voice command is almost always about.
 */
function resolveMember(ctx, spoken) {
  const want = norm(spoken);
  if (!want) return null;

  const inVoice = [...ctx.voiceChannel.members.values()];
  const pools = [inVoice, [...ctx.guild.members.cache.values()]];

  for (const pool of pools) {
    const names = (m) => [m.displayName, m.user.username, m.nickname].filter(Boolean);

    const exact = pool.find((m) => names(m).some((n) => norm(n) === want));
    if (exact) return exact;

    const partial = pool.filter((m) =>
      names(m).some((n) => norm(n).includes(want) || want.includes(norm(n))),
    );
    if (partial.length === 1) return partial[0];
    if (partial.length > 1) {
      const err = new Error(
        `"${spoken}" matches ${partial.length} people: ${partial
          .map((m) => m.displayName)
          .join(', ')}. Ask which one.`,
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
  if (ctx.guild.members.me.roles.highest.comparePositionTo(target.roles.highest) <= 0) {
    throw new Error(`My role is below ${target.displayName}'s, so Discord won't let me act.`);
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
  list_members(ctx) {
    const members = [...ctx.voiceChannel.members.values()].map((m) => ({
      name: m.displayName,
      roles: m.roles.cache.filter((r) => r.name !== '@everyone').map((r) => r.name),
      muted: m.voice.serverMute ?? false,
    }));
    return { members };
  },

  async mute_member(ctx, { target, mute }) {
    assertPermission(ctx, PermissionFlagsBits.MuteMembers, 'Mute Members');
    const member = mustFind(ctx, target);
    assertHierarchy(ctx, member);
    if (!member.voice.channel) throw new Error(`${member.displayName} is not in a voice channel.`);

    if (!DRY_RUN) await member.voice.setMute(Boolean(mute), reason(ctx));
    return { done: `${mute ? 'Muted' : 'Unmuted'} ${member.displayName}` };
  },

  async deafen_member(ctx, { target, deafen }) {
    assertPermission(ctx, PermissionFlagsBits.DeafenMembers, 'Deafen Members');
    const member = mustFind(ctx, target);
    assertHierarchy(ctx, member);
    if (!member.voice.channel) throw new Error(`${member.displayName} is not in a voice channel.`);

    if (!DRY_RUN) await member.voice.setDeaf(Boolean(deafen), reason(ctx));
    return { done: `${deafen ? 'Deafened' : 'Undeafened'} ${member.displayName}` };
  },

  async disconnect_member(ctx, { target }) {
    assertPermission(ctx, PermissionFlagsBits.MoveMembers, 'Move Members');
    const member = mustFind(ctx, target);
    assertHierarchy(ctx, member);
    if (!member.voice.channel) throw new Error(`${member.displayName} is not in a voice channel.`);

    if (!DRY_RUN) await member.voice.disconnect(reason(ctx));
    return { done: `Disconnected ${member.displayName}` };
  },

  async move_member(ctx, { target, channel }) {
    assertPermission(ctx, PermissionFlagsBits.MoveMembers, 'Move Members');
    const member = mustFind(ctx, target);
    assertHierarchy(ctx, member);
    if (!member.voice.channel) throw new Error(`${member.displayName} is not in a voice channel.`);

    const dest = resolveVoiceChannel(ctx, channel);
    if (!dest) throw new Error(`No voice channel called "${channel}".`);
    if (dest.id === member.voice.channelId) {
      throw new Error(`${member.displayName} is already in ${dest.name}.`);
    }
    // Moving someone somewhere they cannot be would just bounce them out.
    if (!dest.permissionsFor(member)?.has(PermissionFlagsBits.Connect)) {
      throw new Error(`${member.displayName} isn't allowed into ${dest.name}.`);
    }
    if (!dest.permissionsFor(ctx.guild.members.me)?.has(PermissionFlagsBits.MoveMembers)) {
      throw new Error(`I can't move people into ${dest.name}.`);
    }

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

/**
 * Mute applied by the bot itself rather than on someone's instruction, so it
 * checks only the bot's own capability. Auto-unmutes so a mistake expires
 * without needing anyone to notice it.
 */
export async function autoMute(member, ms, why) {
  const me = member.guild.members.me;
  if (!member.voice.channel) throw new Error('not in a voice channel');
  if (!member.voice.channel.permissionsFor(me)?.has(PermissionFlagsBits.MuteMembers)) {
    throw new Error('I lack the Mute Members permission');
  }
  if (me.roles.highest.comparePositionTo(member.roles.highest) <= 0) {
    throw new Error('their role is above mine');
  }
  if (member.id === member.guild.ownerId) throw new Error('they are the server owner');

  if (DRY_RUN) return { dryRun: true };

  await member.voice.setMute(true, why);
  setTimeout(() => {
    member.voice.setMute(false, 'Automatic mute expired').catch(() => {});
  }, ms).unref?.();
  return { dryRun: false };
}

function mustFind(ctx, spoken) {
  const member = resolveMember(ctx, spoken);
  if (!member) throw new Error(`I couldn't find anyone called "${spoken}".`);
  return member;
}

/**
 * Run one tool call. Never throws — Gemini gets the error text back so it can
 * explain the refusal out loud instead of the session dying.
 */
export async function executeTool(name, args, ctx) {
  const handler = handlers[name];
  if (!handler) return { error: `Unknown tool "${name}".` };

  if (!ctx.requester) {
    return { error: "I couldn't tell who asked, so I won't run a moderation command." };
  }

  try {
    const result = await handler(ctx, args ?? {});
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
