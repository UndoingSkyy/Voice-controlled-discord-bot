import {
  PermissionFlagsBits as P,
  ChannelType,
  GuildScheduledEventPrivacyLevel,
  GuildScheduledEventEntityType,
} from 'discord.js';
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
  {
    name: 'send_channel_message',
    description:
      'Write a message in a text channel as the bot, prefixed with the requester name. ' +
      'Use this when asked to post something in chat.',
    parameters: obj(
      {
        message: S('The message to send'),
        channel: S('Optional channel name or ID. Defaults to the current text channel.'),
      },
      ['message'],
    ),
  },
  {
    name: 'read_channel_messages',
    description:
      'Read recent messages from a text channel, optionally only one person\'s. ' +
      'Use for "what did they say in chat", "read the last few messages".',
    parameters: obj({
      channel: S('Channel name or ID. Defaults to the current text channel.'),
      member: S('Only messages from this person'),
      limit: N('How many messages, newest last. Default 5, max 20.'),
    }),
  },
  {
    name: 'pin_message',
    description:
      'Pin or unpin a message in a text channel. Without a search phrase, acts on the ' +
      'most recent message.',
    parameters: obj(
      {
        pin: B('True to pin, false to unpin'),
        contains: S('Find the message containing this text'),
        channel: S('Channel name or ID. Defaults to the current text channel.'),
      },
      ['pin'],
    ),
  },
  {
    name: 'add_reaction',
    description: 'React to a message with an emoji.',
    parameters: obj(
      {
        emoji: S('The emoji to react with, e.g. 👍'),
        contains: S('Find the message containing this text. Defaults to the newest.'),
        channel: S('Channel name or ID. Defaults to the current text channel.'),
      },
      ['emoji'],
    ),
  },
  {
    name: 'create_poll',
    description: 'Post a poll in a text channel for people to vote on.',
    parameters: obj(
      {
        question: S('The question being asked'),
        options: S('Answers, comma-separated. Two to ten of them.'),
        hours: N('How long voting stays open. Default 24.'),
        channel: S('Channel name or ID. Defaults to the current text channel.'),
      },
      ['question', 'options'],
    ),
  },
  {
    name: 'create_invite',
    description: 'Create an invite link to the server.',
    parameters: obj({
      channel: S('Channel the invite points at. Defaults to the current voice channel.'),
      hours: N('Hours before it expires. 0 means never. Default 24.'),
      uses: N('Maximum number of uses. 0 means unlimited.'),
    }),
  },
  {
    name: 'audit_log',
    description:
      'Recent moderation actions from the server audit log: who kicked, banned, ' +
      'deleted or changed what. Use for "who banned them", "what happened".',
    parameters: obj({
      target: S('Only actions affecting this member'),
      limit: N('How many entries. Default 5, max 15.'),
    }),
  },
  {
    name: 'manage_thread',
    description: 'Create, archive, or lock a thread in a text channel.',
    parameters: obj(
      {
        action: S('create, archive, unarchive, or lock'),
        name: S('Thread name when creating, or the thread to act on'),
        channel: S('Parent channel. Defaults to the current text channel.'),
      },
      ['action', 'name'],
    ),
  },
  {
    name: 'manage_event',
    description: 'List, create, or cancel scheduled server events.',
    parameters: obj(
      {
        action: S('list, create, or cancel'),
        name: S('Event name, for create and cancel'),
        starts_in_minutes: N('Minutes from now the event starts. Create only.'),
        minutes_long: N('How long it runs. Default 60.'),
        channel: S('Voice channel it happens in. Defaults to the current one.'),
        description: S('What the event is about'),
      },
      ['action'],
    ),
  },
  {
    name: 'set_voice_status',
    description:
      'Set the status line shown on a voice channel, or clear it. Use for ' +
      '"set the channel status to ...".',
    parameters: obj({
      status: S('The status text. Leave empty to clear it.'),
      channel: S('Voice channel. Defaults to the current one.'),
    }),
  },
  {
    name: 'manage_emoji',
    description: 'List, rename, or delete the server\'s custom emoji.',
    parameters: obj(
      {
        action: S('list, rename, or delete'),
        name: S('The emoji to act on'),
        new_name: S('New name, when renaming'),
      },
      ['action'],
    ),
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

/**
 * Resolve a text channel argument, defaulting to where the request came from.
 */
function textTarget(ctx, channel) {
  const raw = String(channel ?? '').trim();
  const byId = raw ? ctx.guild.channels.cache.get(raw.replace(/[<#>]/g, '')) : null;
  const found = byId ?? findChannel(ctx, raw);
  const target = found ?? ctx.textChannel;
  if (!target?.isTextBased?.()) throw new Error('That is not a text channel I can read.');
  return target;
}

/**
 * Permission check that does not go through ctx.helpers.
 *
 * Same rule as everywhere else — the speaker has to be allowed, and so does the
 * bot — but these tools are reachable in contexts where helpers is not wired
 * up, so the check lives here instead.
 */
function allow(ctx, channel, flag, label) {
  if (!channel) return;
  if (!channel.permissionsFor?.(ctx.requester)?.has(flag)) {
    throw new Error(`You don't have the "${label}" permission, so I won't do that.`);
  }
  const me = ctx.guild?.members?.me;
  if (me && !channel.permissionsFor?.(me)?.has(flag)) {
    throw new Error(`I don't have the "${label}" permission here.`);
  }
}

/** Every name a message's author might be called by. */
const speakerNames = (m) =>
  [m.member?.displayName, m.author?.globalName, m.author?.username].filter(Boolean);

/** The newest message, or the newest one containing a phrase. */
async function findMessage(channel, contains) {
  const recent = await channel.messages.fetch({ limit: contains ? 50 : 1 });
  const list = [...recent.values()];
  if (!contains) {
    if (!list.length) throw new Error('There are no messages there.');
    return list[0];
  }
  const want = String(contains).toLowerCase();
  const hit = list.find((m) => String(m.content ?? '').toLowerCase().includes(want));
  if (!hit) throw new Error(`I can't find a message containing "${contains}".`);
  return hit;
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

  async send_channel_message(ctx, { message, channel }) {
    const { assertPermission } = ctx.helpers;
    const body = String(message ?? '').trim();
    if (!body) throw new Error('Give me a message to send.');

    const raw = String(channel ?? '').trim();
    const byId = raw ? ctx.guild.channels.cache.get(raw.replace(/[<#>]/g, '')) : null;
    const ch = byId ?? findChannel(ctx, raw);
    const target = ch ?? ctx.textChannel;

    if (!target?.isTextBased?.() || target.isVoiceBased?.()) {
      throw new Error('That is not a text channel I can write in.');
    }
    assertPermission(ctx, P.SendMessages, 'Send Messages', target);

    const who = ctx.requester?.displayName ?? ctx.requester?.user?.username ?? 'Unknown';
    if (!DRY_RUN) await target.send(`${who}: ${body}`.slice(0, 1900));
    return { done: `Sent message in #${target.name}` };
  },

  async read_channel_messages(ctx, { channel, member, limit }) {
    const target = textTarget(ctx, channel);
    allow(ctx, target, P.ReadMessageHistory, 'Read Message History');

    const want = Math.min(Math.max(Number(limit) || 5, 1), 20);
    // Over-fetch when filtering by person, or their messages may all sit
    // outside the window and come back empty for no obvious reason.
    const fetched = await target.messages.fetch({ limit: member ? 100 : want });
    let list = [...fetched.values()];

    if (member) {
      const who = norm(member);
      list = list.filter((m) => speakerNames(m).some((n) => norm(n) === who))
        || [];
      if (!list.length) {
        const loose = [...fetched.values()].filter((m) =>
          speakerNames(m).some((n) => norm(n).includes(who)),
        );
        list = loose;
      }
    }

    // Discord returns newest first; read them the way they were said.
    list = list.slice(0, want).reverse();
    if (!list.length) return { done: 'Nothing to read there.' };

    const lines = list.map((m, i) => {
      const name = m.member?.displayName ?? m.author?.globalName ?? m.author?.username ?? 'someone';
      const text = String(m.cleanContent ?? m.content ?? '').trim() || '[no text]';
      return `${i + 1}. ${name} says: ${text}`;
    });
    return { done: lines.join('\n') };
  },

  async pin_message(ctx, { pin, contains, channel }) {
    const target = textTarget(ctx, channel);
    allow(ctx, target, P.ManageMessages, 'Manage Messages');

    const msg = await findMessage(target, contains);
    if (!DRY_RUN) await (pin ? msg.pin() : msg.unpin());
    return { done: `${pin ? 'Pinned' : 'Unpinned'} that message in #${target.name}` };
  },

  async add_reaction(ctx, { emoji, contains, channel }) {
    const target = textTarget(ctx, channel);
    allow(ctx, target, P.AddReactions, 'Add Reactions');

    const mark = String(emoji ?? '').trim();
    if (!mark) throw new Error('Tell me which emoji to react with.');

    const msg = await findMessage(target, contains);
    try {
      if (!DRY_RUN) await msg.react(mark);
    } catch {
      throw new Error(`I can't react with "${mark}" — I may not have access to that emoji.`);
    }
    return { done: `Reacted ${mark} in #${target.name}` };
  },

  async create_poll(ctx, { question, options, hours, channel }) {
    const target = textTarget(ctx, channel);
    allow(ctx, target, P.SendMessages, 'Send Messages');

    const ask = String(question ?? '').trim();
    const answers = String(options ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean)
      .slice(0, 10);
    if (!ask) throw new Error('What should the poll ask?');
    if (answers.length < 2) throw new Error('A poll needs at least two options.');

    if (!DRY_RUN) {
      await target.send({
        poll: {
          question: { text: ask.slice(0, 300) },
          answers: answers.map((text) => ({ text: text.slice(0, 55) })),
          duration: Math.min(Math.max(Number(hours) || 24, 1), 768),
          allowMultiselect: false,
        },
      });
    }
    return { done: `Posted a poll in #${target.name}: ${ask}` };
  },

  async create_invite(ctx, { channel, hours, uses }) {
    const raw = String(channel ?? '').trim();
    const target =
      (raw ? ctx.guild.channels.cache.get(raw.replace(/[<#>]/g, '')) ?? findChannel(ctx, raw) : null) ??
      ctx.voiceChannel ??
      ctx.textChannel;
    if (!target) throw new Error('I need a channel to point the invite at.');
    allow(ctx, target, P.CreateInstantInvite, 'Create Instant Invite');

    const maxAge = hours === 0 ? 0 : Math.round((Number(hours) || 24) * 3600);
    const invite = await target.createInvite({
      maxAge,
      maxUses: Math.max(Number(uses) || 0, 0),
      reason: `Voice command by ${ctx.requester.user.tag}`,
    });
    return {
      done: `Invite to #${target.name}: ${invite.url}`,
      url: invite.url,
      expires: maxAge ? `${maxAge / 3600} hour(s)` : 'never',
    };
  },

  async audit_log(ctx, { target, limit }) {
    allow(ctx, ctx.textChannel, P.ViewAuditLog, 'View Audit Log');

    const logs = await ctx.guild.fetchAuditLogs({
      limit: Math.min(Math.max(Number(limit) || 5, 1), 15),
    });
    let entries = [...logs.entries.values()];

    if (target) {
      const want = norm(target);
      entries = entries.filter((e) => {
        const t = e.target;
        return [t?.username, t?.globalName, t?.name, t?.displayName]
          .filter(Boolean)
          .some((n) => norm(n).includes(want));
      });
    }
    if (!entries.length) return { done: 'Nothing in the audit log for that.' };

    return {
      entries: entries.map((e) => ({
        action: String(e.action),
        by: e.executor?.username ?? 'unknown',
        target: e.target?.username ?? e.target?.name ?? null,
        reason: e.reason ?? null,
        when: e.createdAt.toLocaleString(),
      })),
    };
  },

  async manage_thread(ctx, { action, name, channel }) {
    const parent = textTarget(ctx, channel);
    allow(ctx, parent, P.CreatePublicThreads, 'Create Public Threads');

    const what = String(action ?? '').toLowerCase();
    const label = String(name ?? '').trim();
    if (!label) throw new Error('Which thread?');

    if (what.startsWith('create')) {
      if (DRY_RUN) return { done: `[dry run] would open thread "${label}"` };
      const thread = await parent.threads.create({
        name: label.slice(0, 100),
        autoArchiveDuration: 1440,
        reason: `Voice command by ${ctx.requester.user.tag}`,
      });
      return { done: `Opened thread "${thread.name}" in #${parent.name}` };
    }

    const want = norm(label);
    const active = await parent.threads.fetchActive().catch(() => null);
    const archived = await parent.threads.fetchArchived().catch(() => null);
    const pool = [
      ...(active?.threads?.values() ?? []),
      ...(archived?.threads?.values() ?? []),
    ];
    const thread =
      pool.find((t) => norm(t.name) === want) ?? pool.find((t) => norm(t.name).includes(want));
    if (!thread) throw new Error(`I can't find a thread called "${label}".`);

    allow(ctx, parent, P.ManageThreads, 'Manage Threads');
    if (!DRY_RUN) {
      if (what.startsWith('lock')) await thread.setLocked(true);
      else if (what.startsWith('unarchive')) await thread.setArchived(false);
      else await thread.setArchived(true);
    }
    return { done: `${what} on thread "${thread.name}"` };
  },

  async manage_event(ctx, { action, name, starts_in_minutes, minutes_long, channel, description }) {
    const what = String(action ?? 'list').toLowerCase();
    const events = await ctx.guild.scheduledEvents.fetch();

    if (what.startsWith('list')) {
      if (!events.size) return { done: 'No events scheduled.' };
      return {
        events: [...events.values()].map((e) => ({
          name: e.name,
          starts: e.scheduledStartAt?.toLocaleString() ?? 'unknown',
          where: e.channel?.name ?? 'elsewhere',
          interested: e.userCount ?? 0,
        })),
      };
    }

    allow(ctx, ctx.textChannel, P.ManageEvents, 'Manage Events');
    const label = String(name ?? '').trim();
    if (!label) throw new Error('What is the event called?');

    if (what.startsWith('cancel')) {
      const want = norm(label);
      const found =
        [...events.values()].find((e) => norm(e.name) === want) ??
        [...events.values()].find((e) => norm(e.name).includes(want));
      if (!found) throw new Error(`No event called "${label}".`);
      if (!DRY_RUN) await found.delete();
      return { done: `Cancelled "${found.name}"` };
    }

    const where = findChannel(ctx, String(channel ?? ''), true) ?? ctx.voiceChannel;
    if (!where) throw new Error('Which voice channel is the event in?');

    const startsIn = Math.max(Number(starts_in_minutes) || 10, 1);
    const start = new Date(Date.now() + startsIn * 60_000);
    const end = new Date(start.getTime() + Math.max(Number(minutes_long) || 60, 5) * 60_000);

    if (DRY_RUN) return { done: `[dry run] would schedule "${label}"` };
    const made = await ctx.guild.scheduledEvents.create({
      name: label.slice(0, 100),
      description: String(description ?? '').slice(0, 900) || undefined,
      scheduledStartTime: start,
      scheduledEndTime: end,
      privacyLevel: GuildScheduledEventPrivacyLevel.GuildOnly,
      entityType: GuildScheduledEventEntityType.Voice,
      channel: where,
      reason: `Voice command by ${ctx.requester.user.tag}`,
    });
    return { done: `Scheduled "${made.name}" in ${where.name} at ${start.toLocaleTimeString()}` };
  },

  async set_voice_status(ctx, { status, channel }) {
    const target = findChannel(ctx, String(channel ?? ''), true) ?? ctx.voiceChannel;
    if (!target) throw new Error('Which voice channel?');
    allow(ctx, target, P.ManageChannels, 'Manage Channels');

    const text = String(status ?? '').trim().slice(0, 500);
    if (!DRY_RUN) {
      // setVoiceStatus is newer than the rest of the channel API; fall back to
      // the REST route so this still works on older discord.js builds.
      if (typeof target.setVoiceStatus === 'function') await target.setVoiceStatus(text || null);
      else {
        await ctx.guild.client.rest.put(`/channels/${target.id}/voice-status`, {
          body: { status: text || null },
        });
      }
    }
    return { done: text ? `Status on ${target.name}: ${text}` : `Cleared the status on ${target.name}` };
  },

  async manage_emoji(ctx, { action, name, new_name }) {
    const what = String(action ?? 'list').toLowerCase();
    const all = [...ctx.guild.emojis.cache.values()];

    if (what.startsWith('list')) {
      if (!all.length) return { done: 'This server has no custom emoji.' };
      return { emoji: all.map((e) => e.name), count: all.length };
    }

    allow(ctx, ctx.textChannel, P.ManageGuildExpressions, 'Manage Expressions');
    const want = norm(name);
    if (!want) throw new Error('Which emoji?');
    const found = all.find((e) => norm(e.name) === want) ?? all.find((e) => norm(e.name).includes(want));
    if (!found) throw new Error(`No emoji called "${name}".`);

    if (what.startsWith('delete')) {
      if (!DRY_RUN) await found.delete(`Voice command by ${ctx.requester.user.tag}`);
      return { done: `Deleted :${found.name}:` };
    }

    const fresh = String(new_name ?? '').trim().replace(/\W/g, '_');
    if (!fresh) throw new Error('What should it be called?');
    if (!DRY_RUN) await found.edit({ name: fresh });
    return { done: `Renamed :${found.name}: to :${fresh}:` };
  },
};
