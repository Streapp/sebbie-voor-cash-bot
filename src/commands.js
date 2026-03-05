const { SlashCommandBuilder } = require("discord.js");

module.exports = [
  new SlashCommandBuilder()
    .setName("ping")
    .setDescription("Test of de bot online is."),

  new SlashCommandBuilder()
    .setName("openticket")
    .setDescription("Open een Sebbie-voor-Cash ticket voor een serverlid (admin).")
    .addUserOption(option =>
      option
        .setName("lid")
        .setDescription("Voor wie wil je een ticket openen?")
        .setRequired(true)
    )
    .addStringOption(option =>
      option
        .setName("kaart")
        .setDescription("Welke kaart is gekocht?")
        .setRequired(true)
        .addChoices(
          { name: "€10 (1000 Sebbie)", value: "10" },
          { name: "€25 (2500 Sebbie)", value: "25" },
          { name: "€50 (5000 Sebbie)", value: "50" },
          { name: "€100 (10000 Sebbie)", value: "100" }
        )
    ),
].map(cmd => cmd.toJSON());