import { ChannelType, PermissionFlagsBits, SlashCommandBuilder } from 'discord.js';

import { executeTool } from './moderation-tools.js';

const MODERATOR_PERMS =
  PermissionFlagsBits.KickMembers |
  PermissionFlagsBits.BanMembers |
  PermissionFlagsBits.ModerateMembers |
  PermissionFlagsBits.ManageMessages |
  PermissionFlagsBits.ManageChannels |
  PermissionFlagsBits.ManageRoles |
  PermissionFlagsBits.ManageNicknames |
  PermissionFlagsBits.MuteMembers |
  PermissionFlagsBits.DeafenMembers |
  PermissionFlagsBits.MoveMembers;

const userOption = (name, description, required = true) => (option) =>
  option.setName(name).setDescription(description).setRequired(required);

const stringOption = (name, description, required = true) => (option) =>
  option.setName(name).setDescription(description).setRequired(required);

const numberOption = (name, description, required = true) => (option) =>
  option.setName(name).setDescription(description).setRequired(required);

const boolOption = (name, description, required = true) => (option) =>
  option.setName(name).setDescription(description).setRequired(required);

const channelOption = (name, description, channelTypes, required = true) => (option) =>
  option.setName(name).setDescription(description).addChannelTypes(...channelTypes).setRequired(required);

const roleOption = (name, description, required = true) => (option) =>
  option.setName(name).setDescription(description).setRequired(required);

export const moderationCommand = new SlashCommandBuilder()
  .setName('moderate')
  .setDescription('Server moderation and admin actions')
  .setDMPermission(false)
  .setDefaultMemberPermissions(MODERATOR_PERMS)
  .addSubcommandGroup((group) =>
    group
      .setName('member')
      .setDescription('Moderate a member')
      .addSubcommand((sub) =>
        sub
          .setName('kick')
          .setDescription('Kick a member from the server')
          .addUserOption(userOption('target', 'Member to kick'))
          .addStringOption(stringOption('reason', 'Why, for the audit log', false)),
      )
      .addSubcommand((sub) =>
        sub
          .setName('ban')
          .setDescription('Ban a member from the server')
          .addUserOption(userOption('target', 'Member to ban'))
          .addStringOption(stringOption('reason', 'Why, for the audit log', false))
          .addNumberOption(
            numberOption('delete_message_days', 'Delete their messages from the last N days (0-7)', false),
          ),
      )
      .addSubcommand((sub) =>
        sub
          .setName('unban')
          .setDescription('Lift a ban')
          .addStringOption(stringOption('target', 'Username of the banned account')),
      )
      .addSubcommand((sub) =>
        sub
          .setName('timeout')
          .setDescription('Time a member out so they cannot speak or message')
          .addUserOption(userOption('target', 'Member to timeout'))
          .addNumberOption(numberOption('minutes', 'Duration in minutes, 0 to clear the timeout')),
      )
      .addSubcommand((sub) =>
        sub
          .setName('nickname')
          .setDescription('Change a member nickname, or clear it')
          .addUserOption(userOption('target', 'Member to rename'))
          .addStringOption(stringOption('nickname', 'New nickname, or leave blank to reset', false)),
      )
      .addSubcommand((sub) =>
        sub
          .setName('role')
          .setDescription('Give or remove a role from a member')
          .addUserOption(userOption('target', 'Member to change'))
          .addRoleOption(roleOption('role', 'Role to add or remove'))
          .addBooleanOption(boolOption('add', 'true to add the role, false to remove it')),
      )
      .addSubcommand((sub) =>
        sub
          .setName('info')
          .setDescription('Show member details')
          .addUserOption(userOption('target', 'Member to look up')),
      )
      .addSubcommand((sub) =>
        sub
          .setName('warn')
          .setDescription('Record a warning for a member')
          .addUserOption(userOption('target', 'Member to warn'))
          .addStringOption(stringOption('reason', 'Why the warning was issued'))
          .addNumberOption(numberOption('points', 'Warning points to add', false)),
      )
      .addSubcommand((sub) =>
        sub
          .setName('warnings')
          .setDescription('Show warnings for a member')
          .addUserOption(userOption('target', 'Member to inspect')),
      )
      .addSubcommand((sub) =>
        sub
          .setName('clear_warnings')
          .setDescription('Clear all warnings for a member')
          .addUserOption(userOption('target', 'Member to clear')),
      ),
  )
  .addSubcommandGroup((group) =>
    group
      .setName('voice')
      .setDescription('Moderate voice channels and voice members')
      .addSubcommand((sub) =>
        sub
          .setName('mute')
          .setDescription('Server-mute or unmute a member')
          .addUserOption(userOption('target', 'Member to mute or unmute'))
          .addBooleanOption(boolOption('mute', 'true to mute, false to unmute')),
      )
      .addSubcommand((sub) =>
        sub
          .setName('deafen')
          .setDescription('Server-deafen or undeafen a member')
          .addUserOption(userOption('target', 'Member to deafen or undeafen'))
          .addBooleanOption(boolOption('deafen', 'true to deafen, false to undeafen')),
      )
      .addSubcommand((sub) =>
        sub
          .setName('disconnect')
          .setDescription('Disconnect a member from voice')
          .addUserOption(userOption('target', 'Member to disconnect')),
      )
      .addSubcommand((sub) =>
        sub
          .setName('move')
          .setDescription('Move a member to another voice channel')
          .addUserOption(userOption('target', 'Member to move'))
          .addChannelOption(channelOption('channel', 'Destination voice channel', [ChannelType.GuildVoice, ChannelType.GuildStageVoice])),
      )
      .addSubcommand((sub) =>
        sub
          .setName('muteall')
          .setDescription('Mute or unmute everyone in a voice channel')
          .addBooleanOption(boolOption('mute', 'true to mute everyone, false to unmute everyone'))
          .addStringOption(stringOption('channel', 'Voice channel name, default here', false)),
      )
      .addSubcommand((sub) =>
        sub
          .setName('moveall')
          .setDescription('Move everyone from one voice channel into another')
          .addStringOption(stringOption('to', 'Destination voice channel'))
          .addStringOption(stringOption('from', 'Source voice channel', false)),
      ),
  )
  .addSubcommandGroup((group) =>
    group
      .setName('channel')
      .setDescription('Moderate text and voice channels')
      .addSubcommand((sub) =>
        sub
          .setName('create')
          .setDescription('Create a text or voice channel')
          .addStringOption(stringOption('name', 'Channel name'))
          .addStringOption(stringOption('kind', 'text or voice')),
      )
      .addSubcommand((sub) =>
        sub
          .setName('delete')
          .setDescription('Delete a channel')
          .addStringOption(stringOption('name', 'Channel name')),
      )
      .addSubcommand((sub) =>
        sub
          .setName('rename')
          .setDescription('Rename a channel')
          .addStringOption(stringOption('name', 'Channel to rename'))
          .addStringOption(stringOption('new_name', 'New channel name')),
      )
      .addSubcommand((sub) =>
        sub
          .setName('slowmode')
          .setDescription('Set slowmode in a text channel')
          .addNumberOption(numberOption('seconds', '0 to turn slowmode off, up to 21600'))
          .addStringOption(stringOption('channel', 'Channel name, default here', false)),
      )
      .addSubcommand((sub) =>
        sub
          .setName('lock')
          .setDescription('Lock a channel for everyone')
          .addStringOption(stringOption('channel', 'Channel name, default here', false)),
      )
      .addSubcommand((sub) =>
        sub
          .setName('unlock')
          .setDescription('Unlock a channel for everyone')
          .addStringOption(stringOption('channel', 'Channel name, default here', false)),
      )
      .addSubcommand((sub) =>
        sub
          .setName('purge')
          .setDescription('Bulk-delete the most recent messages in this channel')
          .addNumberOption(numberOption('count', 'How many messages to delete (1-100)'))
          .addUserOption(userOption('from_member', 'Only delete messages from this member', false)),
      )
      .addSubcommand((sub) =>
        sub
          .setName('topic')
          .setDescription('Set or clear the topic of a channel')
          .addStringOption(stringOption('channel', 'Channel name, default here', false))
          .addStringOption(stringOption('topic', 'New channel topic, or leave blank to clear', false)),
      )
      .addSubcommand((sub) =>
        sub
          .setName('invite')
          .setDescription('Create an invite for a channel')
          .addChannelOption(
            channelOption('channel', 'Channel to invite people to', [ChannelType.GuildText, ChannelType.GuildVoice, ChannelType.GuildAnnouncement, ChannelType.GuildForum], false),
          )
          .addNumberOption(numberOption('max_age', 'Invite lifetime in seconds, 0 for no expiry', false))
          .addNumberOption(numberOption('max_uses', 'Maximum uses, 0 for unlimited', false))
          .addBooleanOption(boolOption('temporary', 'Whether the invite is temporary', false)),
      ),
  )
  .addSubcommandGroup((group) =>
    group
      .setName('role')
      .setDescription('Create or delete a server role')
      .addSubcommand((sub) =>
        sub
          .setName('create')
          .setDescription('Create a role')
          .addStringOption(stringOption('name', 'Role name'))
          .addStringOption(stringOption('colour', 'Optional hex colour like #ff0000', false)),
      )
      .addSubcommand((sub) =>
        sub
          .setName('delete')
          .setDescription('Delete a role')
          .addStringOption(stringOption('name', 'Role name')),
      ),
  )
  .addSubcommandGroup((group) =>
    group
      .setName('server')
      .setDescription('Server-wide moderation helpers')
      .addSubcommand((sub) => sub.setName('info').setDescription('Show server details'))
      .addSubcommand((sub) => sub.setName('bans').setDescription('List banned accounts')),
  );

function ctxFor(interaction) {
  return {
    guild: interaction.guild,
    voiceChannel: interaction.member?.voice?.channel ?? null,
    textChannel: interaction.channel,
    requester: interaction.member,
    presenceEnabled: process.env.ENABLE_PRESENCE === '1',
    session: null,
  };
}

function formatList(items, render) {
  return items.length ? items.map((item, index) => `${index + 1}. ${render(item)}`).join('\n') : 'None.';
}

function renderResponse(toolName, response) {
  if (response?.error) return `❌ ${response.error}`;
  if (response?.needs_confirmation) {
    return `⚠️ Nothing has happened yet.\n${response.about_to ? `About to ${response.about_to}.\n` : ''}${response.instruction}`;
  }
  if (response?.done) return `✅ ${response.done}`;

  if (toolName === 'server_info' && response) {
    return [
      `**${response.name ?? 'Server'}**`,
      `Members: ${response.members ?? 'unknown'}`,
      `Owner: ${response.owner ?? 'unknown'}`,
      `Created: ${response.created ?? 'unknown'}`,
      `Text channels: ${response.text_channels ?? 'unknown'}`,
      `Voice channels: ${response.voice_channels ?? 'unknown'}`,
      `Roles: ${response.roles ?? 'unknown'}`,
      `Boost level: ${response.boost_level ?? 'unknown'}`,
    ].join('\n');
  }

  if (toolName === 'member_info' && response) {
    return [
      `**${response.name ?? 'Member'}**`,
      `Username: ${response.username ?? 'unknown'}`,
      `Roles: ${Array.isArray(response.roles) && response.roles.length ? response.roles.join(', ') : 'none'}`,
      `Highest role: ${response.highest_role ?? 'unknown'}`,
      `Joined server: ${response.joined_server ?? 'unknown'}`,
      `Account created: ${response.account_created ?? 'unknown'}`,
      `In voice: ${response.in_voice ?? 'none'}`,
      `Timed out until: ${response.timed_out_until ?? 'none'}`,
      `Server owner: ${response.is_owner ? 'yes' : 'no'}`,
    ].join('\n');
  }

  if (toolName === 'list_bans' && response) {
    const lines = formatList(response.banned ?? [], (entry) => `${entry.user} — ${entry.reason}`);
    return [`**Bans:** ${response.count ?? 0}`, lines].join('\n');
  }

  if (response && typeof response === 'object') {
    return `✅ ${JSON.stringify(response, null, 2).slice(0, 1800)}`;
  }

  return '✅ Done.';
}

export async function handleModeration(interaction) {
  await interaction.deferReply({ ephemeral: true });

  const group = interaction.options.getSubcommandGroup();
  const subcommand = interaction.options.getSubcommand();
  const ctx = ctxFor(interaction);

  let toolName = null;
  let args = {};

  if (group === 'member') {
    const target = interaction.options.getUser('target', true).id;
    if (subcommand === 'kick') {
      toolName = 'kick_member';
      args = { target, reason: interaction.options.getString('reason') ?? undefined };
    } else if (subcommand === 'ban') {
      toolName = 'ban_member';
      args = {
        target,
        reason: interaction.options.getString('reason') ?? undefined,
        delete_message_days: interaction.options.getNumber('delete_message_days') ?? undefined,
      };
    } else if (subcommand === 'unban') {
      toolName = 'unban_member';
      args = { target: interaction.options.getString('target', true) };
    } else if (subcommand === 'timeout') {
      toolName = 'timeout_member';
      args = { target, minutes: interaction.options.getNumber('minutes', true) };
    } else if (subcommand === 'nickname') {
      toolName = 'set_nickname';
      args = { target, nickname: interaction.options.getString('nickname') ?? undefined };
    } else if (subcommand === 'role') {
      toolName = 'manage_role';
      args = {
        target,
        role: interaction.options.getRole('role', true).id,
        add: interaction.options.getBoolean('add', true),
      };
    } else if (subcommand === 'info') {
      toolName = 'member_info';
      args = { target };
    } else if (subcommand === 'warn') {
      toolName = 'warn_member';
      args = {
        target,
        reason: interaction.options.getString('reason') ?? undefined,
        points: interaction.options.getNumber('points') ?? undefined,
      };
    } else if (subcommand === 'warnings') {
      toolName = 'list_warnings';
      args = { target };
    } else if (subcommand === 'clear_warnings') {
      toolName = 'clear_warnings';
      args = { target };
    }
  } else if (group === 'voice') {
    const target = interaction.options.getUser('target', true).id;
    if (subcommand === 'mute') {
      toolName = 'mute_member';
      args = { target, mute: interaction.options.getBoolean('mute', true) };
    } else if (subcommand === 'deafen') {
      toolName = 'deafen_member';
      args = { target, deafen: interaction.options.getBoolean('deafen', true) };
    } else if (subcommand === 'disconnect') {
      toolName = 'disconnect_member';
      args = { target };
    } else if (subcommand === 'move') {
      toolName = 'move_member';
      args = { target, channel: interaction.options.getChannel('channel', true).id };
    } else if (subcommand === 'muteall') {
      toolName = 'mute_everyone';
      args = {
        mute: interaction.options.getBoolean('mute', true),
        channel: interaction.options.getString('channel') ?? undefined,
      };
    } else if (subcommand === 'moveall') {
      toolName = 'move_everyone';
      args = {
        to: interaction.options.getString('to', true),
        from: interaction.options.getString('from') ?? undefined,
      };
    }
  } else if (group === 'channel') {
    if (subcommand === 'create') {
      toolName = 'manage_channel';
      args = {
        action: 'create',
        name: interaction.options.getString('name', true),
        kind: interaction.options.getString('kind', true),
      };
    } else if (subcommand === 'delete') {
      toolName = 'manage_channel';
      args = { action: 'delete', name: interaction.options.getString('name', true) };
    } else if (subcommand === 'rename') {
      toolName = 'manage_channel';
      args = {
        action: 'rename',
        name: interaction.options.getString('name', true),
        new_name: interaction.options.getString('new_name', true),
      };
    } else if (subcommand === 'slowmode') {
      toolName = 'set_slowmode';
      args = {
        seconds: interaction.options.getNumber('seconds', true),
        channel: interaction.options.getString('channel') ?? interaction.channel?.name ?? undefined,
      };
    } else if (subcommand === 'lock') {
      toolName = 'lock_channel';
      args = { locked: true, channel: interaction.options.getString('channel') ?? interaction.channel?.name ?? undefined };
    } else if (subcommand === 'unlock') {
      toolName = 'lock_channel';
      args = { locked: false, channel: interaction.options.getString('channel') ?? interaction.channel?.name ?? undefined };
    } else if (subcommand === 'purge') {
      toolName = 'delete_messages';
      args = {
        count: interaction.options.getNumber('count', true),
        from_member: interaction.options.getUser('from_member')?.id ?? undefined,
      };
    } else if (subcommand === 'topic') {
      toolName = 'set_channel_topic';
      args = {
        channel: interaction.options.getString('channel') ?? interaction.channel?.name ?? undefined,
        topic: interaction.options.getString('topic') ?? undefined,
      };
    } else if (subcommand === 'invite') {
      toolName = 'create_invite';
      args = {
        channel: interaction.options.getChannel('channel')?.id ?? interaction.channel?.id ?? undefined,
        max_age: interaction.options.getNumber('max_age') ?? undefined,
        max_uses: interaction.options.getNumber('max_uses') ?? undefined,
        temporary: interaction.options.getBoolean('temporary') ?? undefined,
      };
    }
  } else if (group === 'role') {
    if (subcommand === 'create') {
      toolName = 'manage_server_role';
      args = {
        action: 'create',
        name: interaction.options.getString('name', true),
        colour: interaction.options.getString('colour') ?? undefined,
      };
    } else if (subcommand === 'delete') {
      toolName = 'manage_server_role';
      args = { action: 'delete', name: interaction.options.getString('name', true) };
    }
  } else if (group === 'server') {
    toolName = subcommand === 'info' ? 'server_info' : 'list_bans';
  }

  if (!toolName) {
    await interaction.editReply('❌ I could not route that moderation command.');
    return;
  }

  const response = await executeTool(toolName, args, ctx);
  await interaction.editReply({ content: renderResponse(toolName, response) });
}