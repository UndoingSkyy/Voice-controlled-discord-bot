import 'dotenv/config';
import { Client, GatewayIntentBits, Events, MessageFlags } from 'discord.js';

import { startSession, stopSession, getSession } from './voice-session.js';
import { claimSingleInstance } from './single-instance.js';

claimSingleInstance();

for (const key of ['DISCORD_TOKEN', 'DISCORD_CLIENT_ID', 'GEMINI_API_KEY']) {
  if (!process.env[key]) {
    console.error(`Missing ${key} — copy .env.example to .env and fill it in.`);
    process.exit(1);
  }
}

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildVoiceStates,
  ],
});

client.once(Events.ClientReady, (c) => {
  console.log(`Logged in as ${c.user.tag}. Use /join in a voice channel.`);
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

client.login(process.env.DISCORD_TOKEN);
