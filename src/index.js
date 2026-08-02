import 'dotenv/config';
import { Client, GatewayIntentBits, Events, MessageFlags } from 'discord.js';

import { startSession, stopSession, getSession, activityKey } from './voice-session.js';
import { claimSingleInstance } from './single-instance.js';
import { postImage } from './waifu.js';
import { startReminderLoop } from './memory.js';

claimSingleInstance();

for (const key of ['DISCORD_TOKEN', 'DISCORD_CLIENT_ID', 'GEMINI_API_KEY']) {
  if (!process.env[key]) {
    console.error(`Missing ${key} — copy .env.example to .env and fill it in.`);
    process.exit(1);
  }
}

// Presence is a privileged intent: requesting it without enabling it in the
// Developer Portal makes login fail outright, so it stays opt-in.
const intents = [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates];
if (process.env.ENABLE_PRESENCE === '1') {
  intents.push(GatewayIntentBits.GuildPresences, GatewayIntentBits.GuildMembers);
}
if (process.env.READ_MESSAGES === '1') {
  // MessageContent is privileged too: without it every message arrives blank.
  intents.push(GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent);
}
if (process.env.WELCOME_VOICE === '1' && !intents.includes(GatewayIntentBits.GuildMembers)) {
  intents.push(GatewayIntentBits.GuildMembers); // needed for guildMemberAdd
}

const client = new Client({ intents });

/**
 * A malformed voice packet arrives on a UDP callback, so anything thrown there
 * is an uncaught exception with no owner. Losing one packet is not a reason to
 * drop everyone's call, so those are logged and survived; anything else is
 * genuinely unexpected and still terminates.
 */
const SURVIVABLE = /Failed to decrypt|DecryptionFailed|UnencryptedWhenPassthrough/i;

process.on('uncaughtException', (err) => {
  if (SURVIVABLE.test(err?.message ?? '')) {
    console.warn(`[voice] ignored bad packet: ${err.message.split('\n')[0]}`);
    return;
  }
  console.error('Fatal:', err);
  process.exit(1);
});

process.on('unhandledRejection', (err) => {
  if (SURVIVABLE.test(err?.message ?? '')) return;
  console.error('Unhandled rejection:', err);
});

client.once(Events.ClientReady, (c) => {
  console.log(`Logged in as ${c.user.tag}. Use /join in a voice channel.`);
  // Reminders outlive both the call and the process, so this runs whether or
  // not the bot is currently in a voice channel.
  startReminderLoop(c, getSession);
});

// Someone in a voice channel started a game / put music on. Only newly-started
// activities count, so an unchanged presence heartbeat doesn't trigger chatter.
client.on(Events.PresenceUpdate, (oldPresence, newPresence) => {
  if (process.env.PROACTIVE_ACTIVITY !== '1') return;
  const member = newPresence?.member;
  if (!member) return;

  const session = getSession(member.guild.id);
  if (!session) return;

  const before = new Set((oldPresence?.activities ?? []).map(activityKey));
  const started = (newPresence.activities ?? []).filter(
    (a) => a.type !== 4 && !before.has(activityKey(a)), // type 4 is a custom status
  );
  if (started.length) session.notePresenceChange(member, started[0]);
});

// Read messages typed in the /join channel out loud.
client.on(Events.MessageCreate, (message) => {
  if (process.env.READ_MESSAGES !== '1' || !message.guildId) return;
  getSession(message.guildId)?.speakMessage(message);
});

// Greet people arriving in the bot's voice channel.
client.on(Events.VoiceStateUpdate, (oldState, newState) => {
  if (process.env.WELCOME_VOICE !== '1') return;
  if (oldState.channelId === newState.channelId) return; // mute/deafen, not a move

  const session = getSession(newState.guild.id);
  if (!session || !newState.member) return;
  if (newState.channelId !== session.voiceChannel.id) return;
  if (newState.member.id === client.user.id) return; // that's us arriving

  session.welcome(newState.member);
});

// Greet people brand new to the server, if the bot is currently in voice.
client.on(Events.GuildMemberAdd, (member) => {
  if (process.env.WELCOME_VOICE !== '1') return;
  getSession(member.guild.id)?.welcome(member, { joinedServer: true });
});

client.on(Events.InteractionCreate, async (interaction) => {
  if (!interaction.isChatInputCommand()) return;

  if (process.env.DEBUG_VOICE) {
    // Discord discards an interaction 3s after it is created; if this age is
    // near or past that, acks will fail with 10062.
    const age = Date.now() - interaction.createdTimestamp;
    console.log(`[interaction] /${interaction.commandName} age=${age}ms`);
  }

  try {
    switch (interaction.commandName) {
      case 'join':
        return await handleJoin(interaction);
      case 'leave':
        return await handleLeave(interaction);
      case 'say':
        return await handleSay(interaction);
      case 'waifu':
        return await handleWaifu(interaction);
      case 'play':
      case 'stop':
      case 'skip':
        return await handleMusic(interaction);
    }
  } catch (err) {
    // 10062 = Discord already discarded this interaction (usually a duplicate
    // bot process answering first, or the 3s ack window elapsed). Nothing can
    // be sent on it, so don't spam the console with the full REST dump.
    if (err.code === 10062) {
      console.warn(
        `[warn] Interaction expired for /${interaction.commandName}. ` +
          'Is a second copy of the bot running?',
      );
      return;
    }

    console.error(err);
    const body = { content: `❌ ${err.message}`, flags: MessageFlags.Ephemeral };
    if (interaction.deferred || interaction.replied) {
      await interaction.followUp(body).catch(() => {});
    } else {
      await interaction.reply(body).catch(() => {});
    }
  }
});

async function handleJoin(interaction) {
  // Acknowledge first — Discord discards the interaction after 3 seconds, and
  // connecting to voice plus Gemini takes longer than that.
  await interaction.deferReply();

  const channel = interaction.member?.voice?.channel;
  if (!channel) {
    return interaction.editReply('Join a voice channel first, then run `/join`.');
  }

  const me = channel.guild.members.me;
  if (!channel.permissionsFor(me).has(['Connect', 'Speak'])) {
    return interaction.editReply('I need **Connect** and **Speak** permissions in that channel.');
  }

  await startSession(channel, interaction.channel);
  await interaction.editReply(
    `🎙️ Connected to **${channel.name}** — just start talking. \`/leave\` when you're done.`,
  );
}

async function handleLeave(interaction) {
  const stopped = await stopSession(interaction.guildId);
  await interaction.reply(stopped ? '👋 Left the voice channel.' : "I'm not in a voice channel.");
}

async function handleMusic(interaction) {
  const session = getSession(interaction.guildId);
  if (!session?.music) {
    return interaction.reply({
      content: 'Run `/join` first — I need to be in a voice channel to play anything.',
      flags: MessageFlags.Ephemeral,
    });
  }

  await interaction.deferReply();
  const { music } = session;
  try {
    if (interaction.commandName === 'stop') {
      music.stop();
      return await interaction.editReply('⏹️ Stopped.');
    }
    if (interaction.commandName === 'skip') {
      return await interaction.editReply(`⏭️ Skipped **${music.skip()}**.`);
    }
    const title = music.play(interaction.options.getString('query', true));
    await interaction.editReply(`▶️ Playing **${title}**`);
  } catch (err) {
    await interaction.editReply(`❌ ${err.message}`.slice(0, 1900));
  }
}

async function handleWaifu(interaction) {
  await interaction.deferReply();
  const tag = interaction.options.getString('tag');
  try {
    await postImage(interaction.channel, {
      tags: tag ? [tag] : [],
      requestedBy: interaction.member?.displayName,
    });
    await interaction.deleteReply().catch(() => {});
  } catch (err) {
    await interaction.editReply(`❌ ${err.message}`.slice(0, 1900));
  }
}

async function handleSay(interaction) {
  const session = getSession(interaction.guildId);
  if (!session) {
    return interaction.reply({
      content: 'Run `/join` first.',
      flags: MessageFlags.Ephemeral,
    });
  }
  const text = interaction.options.getString('text', true);
  session.gemini.sendText(text);
  await interaction.reply(`🗣️ ${text}`);
}

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, async () => {
    for (const guildId of client.guilds.cache.keys()) await stopSession(guildId);
    client.destroy();
    process.exit(0);
  });
}

client.login(process.env.DISCORD_TOKEN).catch((err) => {
  if (/disallowed intents/i.test(err.message)) {
    const needed = [
      process.env.ENABLE_PRESENCE === '1' && 'Presence Intent (ENABLE_PRESENCE)',
      (process.env.ENABLE_PRESENCE === '1' || process.env.WELCOME_VOICE === '1') &&
        'Server Members Intent (ENABLE_PRESENCE / WELCOME_VOICE)',
      process.env.READ_MESSAGES === '1' && 'Message Content Intent (READ_MESSAGES)',
    ].filter(Boolean);

    console.error(
      '\n❌ Discord rejected the privileged intents this bot asked for:\n' +
        needed.map((n) => `     - ${n}`).join('\n') +
        '\n\n   Enable them under Developer Portal -> your app -> Bot ->\n' +
        '   Privileged Gateway Intents, then start again. Or unset the\n' +
        '   matching variable in .env to run without that feature.\n',
    );
    process.exit(1);
  }
  throw err;
});
