import { PermissionFlagsBits as P, ChannelType } from 'discord.js';
import { Type } from '@google/genai';

/**
 * The heavier administrative actions — kick, ban, channels, roles, server-wide
 * voice control.
 *
 * These follow the same rule as the rest: the *speaker's* permissions decide
 * what is allowed, never the bot's. The bot having Administrator means it can
 * carry an action out, not that anyone may ask for it.
 *
 * Helpers (resolveMember, hierarchy checks, the confirmation gate) live in
 * moderation-tools.js and are passed in through ctx.helpers to avoid a circular
 * import.
 */

const DRY_RUN = Boolean(process.env.MOD_DRY_RUN);

const S = (t) => ({ type: Type.STRING, description: t });
const N = (t) => ({ type: Type.NUMBER, description: t });
const B = (t) => ({ type: Type.BOOLEAN, description: t });
const obj = (properties, required = []) => ({ type: Type.OBJECT, properties, required });

export const adminDeclarations = [
  {
    name: 'kick_member',
    description: 'Remove a member from the server. They can rejoin with an invite. Destructive.',
    parameters: obj({ target: S('Member to kick'), reason: S('Why, for the audit log') }, ['target']),
  },
  {
    name: 'ban_member',
    description: 'Ban a member from the server. Destructive and hard to undo.',
    parameters: obj(
      {
        target: S('Member to ban'),
        reason: S('Why, for the audit log'),
        delete_message_days: N('Delete their messages from the last N days (0-7)'),
      },
      ['target'],
    ),
  },
  {
    name: 'unban_member',
    description: 'Lift a ban. Give the username of the banned account.',
    parameters: obj({ target: S('Username of the banned account') }, ['target']),
  },
  {
    name: 'list_bans',
    description: 'List accounts currently banned from the server.',
    parameters: obj({}),
  },
  {
    name: 'set_nickname',
    description: "Change a member's nickname, or clear it.",
    parameters: obj(
      { target: S('Member to rename'), nickname: S('New nickname, or empty to reset') },
      ['target'],
    ),
  },
  {
    name: 'manage_channel',
    description:
      'Create or delete a channel, or rename one. Use kind "text" or "voice" when creating.',
    parameters: obj(
      {
        action: S('create, delete, or rename'),
        name: S('Channel name to act on'),
        kind: S('For create: text or voice'),
        new_name: S('For rename: the new name'),
      },
      ['action', 'name'],
    ),
  },
  {
    name: 'set_slowmode',
    description: 'Set how many seconds members must wait between messages in a text channel.',
    parameters: obj(
      { seconds: N('0 to turn slowmode off, up to 21600'), channel: S('Channel name, default here') },
      ['seconds'],
    ),
  },
  {
    name: 'lock_channel',
    description:
      'Lock or unlock a channel for everyone: locking stops @everyone sending messages in a ' +
      'text channel, or speaking in a voice channel.',
    parameters: obj(
      { locked: B('true to lock, false to unlock'), channel: S('Channel name, default here') },
      ['locked'],
    ),
  },
  {
    name: 'manage_server_role',
    description: 'Create or delete a role on the server.',
    parameters: obj(
      { action: S('create or delete'), name: S('Role name'), colour: S('Optional hex colour like #ff0000') },
      ['action', 'name'],
    ),
  },
  {
    name: 'mute_everyone',
    description:
      'Server-mute or unmute everyone in a voice channel at once, except the person asking.',
    parameters: obj(
      { mute: B('true to mute all, false to unmute all'), channel: S('Voice channel, default yours') },
      ['mute'],
    ),
  },
  {
    name: 'move_everyone',
    description: 'Move every member of one voice channel into another.',
    parameters: obj({ from: S('Source voice channel'), to: S('Destination voice channel') }, ['to']),
  },
  {
    name: 'server_info',
    description: 'Summary of the server: member count, channels, roles, owner, boost level.',
    parameters: obj({}),
  },
  {
    name: 'member_info',
    description: 'Details about a member: roles, join date, account age, timeout status.',
    parameters: obj({ target: S('Member to look up') }, ['target']),
  },
];

/* ------------------------------------------------------------------ */

const norm = (s) => String(s ?? '').normalize('NFKD').toLowerCase().replace(/[^a-z0-9]/g, '');

function findChannel(ctx, name, voiceOnly = false) {
  if (!name) return voiceOnly ? ctx.voiceChannel : ctx.textChannel;
  const want = norm(name);
  const all = [...ctx.guild.channels.cache.values()].filter((c) =>
    voiceOnly ? c.isVoiceBased?.() : true,
  );
  return (
    all.find((c) => norm(c.name) === want) ??
    all.find((c) => norm(c.name).includes(want) || want.includes(norm(c.name))) ??
    null
  );
}

export const adminHandlers = {
  async kick_member(ctx, { target, reason }) {
    const { mustFind, assertPermission, assertHierarchy } = ctx.helpers;
    const member = mustFind(ctx, target);
    assertPermission(ctx, P.KickMembers, 'Kick Members', ctx.textChannel);
    assertHierarchy(ctx, member);
    if (!member.kickable) throw new Error(`Discord will not let me kick ${member.displayName}.`);

    if (!DRY_RUN) await member.kick(reason || `Kicked by ${ctx.requester.user.tag} via voice`);
    return { done: `Kicked ${member.displayName}` };
  },

  async ban_member(ctx, { target, reason, delete_message_days }) {
    const { mustFind, assertPermission, assertHierarchy } = ctx.helpers;
    const member = mustFind(ctx, target);
    assertPermission(ctx, P.BanMembers, 'Ban Members', ctx.textChannel);
    assertHierarchy(ctx, member);
    if (!member.bannable) throw new Error(`Discord will not let me ban ${member.displayName}.`);

    const days = Math.min(Math.max(Number(delete_message_days) || 0, 0), 7);
    if (!DRY_RUN) {
      await member.ban({
        reason: reason || `Banned by ${ctx.requester.user.tag} via voice`,
        deleteMessageSeconds: days * 86400,
      });
    }
    return { done: `Banned ${member.displayName}${days ? `, wiping ${days} day(s) of messages` : ''}` };
  },

  async unban_member(ctx, { target }) {
    const { assertPermission } = ctx.helpers;
    assertPermission(ctx, P.BanMembers, 'Ban Members', ctx.textChannel);

    const bans = await ctx.guild.bans.fetch();
    const want = norm(target);
    const ban = bans.find(
      (b) => norm(b.user.username) === want || norm(b.user.username).includes(want),
    );
    if (!ban) throw new Error(`"${target}" is not in the ban list.`);

    if (!DRY_RUN) await ctx.guild.bans.remove(ban.user.id, `Unbanned by ${ctx.requester.user.tag}`);
    return { done: `Unbanned ${ban.user.username}` };
  },

  async list_bans(ctx) {
    ctx.helpers.assertPermission(ctx, P.BanMembers, 'Ban Members', ctx.textChannel);
    const bans = await ctx.guild.bans.fetch();
    return {
      count: bans.size,
      banned: [...bans.values()].slice(0, 25).map((b) => ({
        user: b.user.username,
        reason: b.reason ?? 'no reason recorded',
      })),
    };
  },

  async set_nickname(ctx, { target, nickname }) {
    const { mustFind, assertPermission, assertHierarchy } = ctx.helpers;
    const member = mustFind(ctx, target);
    assertPermission(ctx, P.ManageNicknames, 'Manage Nicknames', ctx.textChannel);
    assertHierarchy(ctx, member);

    const name = (nickname ?? '').trim().slice(0, 32);
    if (!DRY_RUN) await member.setNickname(name || null, `Set by ${ctx.requester.user.tag}`);
    return { done: name ? `${member.user.username} is now "${name}"` : `Cleared ${member.displayName}'s nickname` };
  },

  async manage_channel(ctx, { action, name, kind, new_name }) {
    const { assertPermission } = ctx.helpers;
    assertPermission(ctx, P.ManageChannels, 'Manage Channels', ctx.textChannel);
    const verb = String(action).toLowerCase();

    if (verb === 'create') {
      const type = /voice/i.test(kind ?? '') ? ChannelType.GuildVoice : ChannelType.GuildText;
      if (!DRY_RUN) {
        await ctx.guild.channels.create({ name, type, reason: `Created by ${ctx.requester.user.tag}` });
      }
      return { done: `Created ${/voice/i.test(kind ?? '') ? 'voice' : 'text'} channel "${name}"` };
    }

    const channel = findChannel(ctx, name);
    if (!channel) throw new Error(`No channel called "${name}".`);

    if (verb === 'delete') {
      if (channel.id === ctx.textChannel?.id) throw new Error('I will not delete the channel we are using.');
      if (!DRY_RUN) await channel.delete(`Deleted by ${ctx.requester.user.tag}`);
      return { done: `Deleted "${channel.name}"` };
    }
    if (verb === 'rename') {
      if (!new_name) throw new Error('Give the new name.');
      if (!DRY_RUN) await channel.setName(new_name);
      return { done: `Renamed "${channel.name}" to "${new_name}"` };
    }
    throw new Error(`Unknown action "${action}". Use create, delete or rename.`);
  },

  async set_slowmode(ctx, { seconds, channel }) {
    const { assertPermission } = ctx.helpers;
    const ch = findChannel(ctx, channel);
    if (!ch?.setRateLimitPerUser) throw new Error('That is not a text channel.');
    assertPermission(ctx, P.ManageChannels, 'Manage Channels', ch);

    const secs = Math.min(Math.max(Math.floor(Number(seconds) || 0), 0), 21600);
    if (!DRY_RUN) await ch.setRateLimitPerUser(secs, `Set by ${ctx.requester.user.tag}`);
    return { done: secs ? `Slowmode in #${ch.name} set to ${secs}s` : `Slowmode off in #${ch.name}` };
  },

  async lock_channel(ctx, { locked, channel }) {
    const { assertPermission } = ctx.helpers;
    const ch = findChannel(ctx, channel);
    if (!ch) throw new Error(`No channel called "${channel}".`);
    assertPermission(ctx, P.ManageChannels, 'Manage Channels', ch);

    // Deny on @everyone is what "locked" means in practice.
    const flag = ch.isVoiceBased?.() ? P.Speak : P.SendMessages;
    if (!DRY_RUN) {
      await ch.permissionOverwrites.edit(ctx.guild.roles.everyone, { [flag]: locked ? false : null });
    }
    return { done: `${locked ? 'Locked' : 'Unlocked'} ${ch.isVoiceBased?.() ? '' : '#'}${ch.name}` };
  },

  async manage_server_role(ctx, { action, name, colour }) {
    const { assertPermission } = ctx.helpers;
    assertPermission(ctx, P.ManageRoles, 'Manage Roles', ctx.textChannel);
    const verb = String(action).toLowerCase();

    if (verb === 'create') {
      if (!DRY_RUN) {
        await ctx.guild.roles.create({
          name,
          color: /^#?[0-9a-f]{6}$/i.test(colour ?? '') ? colour.replace('#', '0x') : undefined,
          reason: `Created by ${ctx.requester.user.tag}`,
        });
      }
      return { done: `Created role "${name}"` };
    }

    if (verb === 'delete') {
      const want = norm(name);
      const role = ctx.guild.roles.cache.find((r) => norm(r.name) === want);
      if (!role) throw new Error(`No role called "${name}".`);
      if (role.managed) throw new Error(`"${role.name}" is managed by an integration.`);

      const me = ctx.guild.members.me;
      const isOwner = ctx.requester.id === ctx.guild.ownerId;
      if (!isOwner && ctx.requester.roles.highest.comparePositionTo(role) <= 0) {
        throw new Error(`"${role.name}" is at or above your highest role.`);
      }
      if (me.roles.highest.comparePositionTo(role) <= 0) {
        throw new Error(`"${role.name}" is above my role, so I cannot delete it.`);
      }
      if (!DRY_RUN) await role.delete(`Deleted by ${ctx.requester.user.tag}`);
      return { done: `Deleted role "${role.name}"` };
    }
    throw new Error(`Unknown action "${action}". Use create or delete.`);
  },

  async mute_everyone(ctx, { mute, channel }) {
    const { assertPermission } = ctx.helpers;
    const ch = findChannel(ctx, channel, true);
    if (!ch) throw new Error('I could not find that voice channel.');
    assertPermission(ctx, P.MuteMembers, 'Mute Members', ch);

    const me = ctx.guild.members.me;
    const targets = [...ch.members.values()].filter(
      (m) => m.id !== ctx.requester.id && m.id !== me.id && !m.user.bot,
    );

    let done = 0;
    for (const m of targets) {
      if (me.roles.highest.comparePositionTo(m.roles.highest) <= 0) continue;
      if (!DRY_RUN) await m.voice.setMute(Boolean(mute), `By ${ctx.requester.user.tag}`).catch(() => {});
      done++;
    }
    return { done: `${mute ? 'Muted' : 'Unmuted'} ${done} member(s) in ${ch.name}` };
  },

  async move_everyone(ctx, { from, to }) {
    const { assertPermission } = ctx.helpers;
    const src = findChannel(ctx, from, true) ?? ctx.voiceChannel;
    const dest = findChannel(ctx, to, true);
    if (!dest) throw new Error(`No voice channel called "${to}".`);
    if (src.id === dest.id) throw new Error('They are already in that channel.');
    assertPermission(ctx, P.MoveMembers, 'Move Members', src);
    assertPermission(ctx, P.MoveMembers, 'Move Members', dest);

    const me = ctx.guild.members.me;
    let moved = 0;
    for (const m of [...src.members.values()]) {
      if (m.id === me.id) continue;
      if (me.roles.highest.comparePositionTo(m.roles.highest) <= 0) continue;
      if (!DRY_RUN) await m.voice.setChannel(dest, `By ${ctx.requester.user.tag}`).catch(() => {});
      moved++;
    }
    return { done: `Moved ${moved} member(s) from ${src.name} to ${dest.name}` };
  },

  async server_info(ctx) {
    const g = ctx.guild;
    const owner = await g.fetchOwner().catch(() => null);
    const channels = [...g.channels.cache.values()];
    return {
      name: g.name,
      members: g.memberCount,
      owner: owner?.displayName ?? 'unknown',
      created: g.createdAt.toLocaleDateString(),
      text_channels: channels.filter((c) => c.type === ChannelType.GuildText).length,
      voice_channels: channels.filter((c) => c.isVoiceBased?.()).length,
      roles: g.roles.cache.size - 1,
      boost_level: g.premiumTier,
    };
  },

  member_info(ctx, { target }) {
    const m = ctx.helpers.mustFind(ctx, target);
    return {
      name: m.displayName,
      username: m.user.username,
      roles: m.roles.cache.filter((r) => r.name !== '@everyone').map((r) => r.name),
      highest_role: m.roles.highest.name,
      joined_server: m.joinedAt?.toLocaleDateString() ?? 'unknown',
      account_created: m.user.createdAt.toLocaleDateString(),
      in_voice: m.voice.channel?.name ?? null,
      timed_out_until: m.communicationDisabledUntil?.toLocaleString() ?? null,
      is_owner: m.id === ctx.guild.ownerId,
    };
  },
};
