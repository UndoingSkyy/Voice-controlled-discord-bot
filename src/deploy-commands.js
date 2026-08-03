import 'dotenv/config';
import { REST, Routes, SlashCommandBuilder } from 'discord.js';

const commands = [
  new SlashCommandBuilder()
    .setName('join')
    .setDescription('Join your voice channel and start a live Gemini conversation'),
  new SlashCommandBuilder()
    .setName('leave')
    .setDescription('End the conversation and leave the voice channel'),
  new SlashCommandBuilder()
    .setName('waifu')
    .setDescription('Post a random anime image from waifu.im')
    .addStringOption((o) =>
      o.setName('tag').setDescription('e.g. waifu, maid, uniform, raiden-shogun').setRequired(false),
    ),
  new SlashCommandBuilder()
    .setName('say')
    .setDescription('Send a typed message into the ongoing voice conversation')
    .addStringOption((o) =>
      o.setName('text').setDescription('What to say to Gemini').setRequired(true),
    ),
].map((c) => c.toJSON());

const rest = new REST().setToken(process.env.DISCORD_TOKEN);

// A guild id registers instantly; global registration can take up to an hour.
const guildId = process.argv[2] || process.env.DISCORD_GUILD_ID;
const route = guildId
  ? Routes.applicationGuildCommands(process.env.DISCORD_CLIENT_ID, guildId)
  : Routes.applicationCommands(process.env.DISCORD_CLIENT_ID);

await rest.put(route, { body: commands });
console.log(`Registered ${commands.length} commands ${guildId ? `to guild ${guildId}` : 'globally'}.`);
