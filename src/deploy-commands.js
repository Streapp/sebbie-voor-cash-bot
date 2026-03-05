require("dotenv").config();
const { REST, Routes } = require("discord.js");
const commands = require("./commands");

const token = process.env.DISCORD_TOKEN;
const clientId = process.env.CLIENT_ID;
const guildId = process.env.GUILD_ID;

if (!token || !clientId || !guildId) {
  console.error("❌ .env mist DISCORD_TOKEN, CLIENT_ID of GUILD_ID");
  process.exit(1);
}

const rest = new REST({ version: "10" }).setToken(token);

(async () => {
  try {
    console.log("⏳ Slash commands uploaden naar jouw server...");
    await rest.put(Routes.applicationGuildCommands(clientId, guildId), { body: commands });
    console.log("✅ Klaar! Slash commands staan nu in jouw Discord server.");
  } catch (error) {
    console.error("❌ Fout bij uploaden commands:", error);
  }
})();
