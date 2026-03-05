require("dotenv").config();

const fs = require("fs");
const path = require("path");

const {
  Client,
  GatewayIntentBits,
  Events,
  PermissionFlagsBits,
  ChannelType,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  StringSelectMenuBuilder,
  MessageFlags,
} = require("discord.js");

const token = process.env.DISCORD_TOKEN;
const TICKETS_CATEGORY_ID = process.env.TICKETS_CATEGORY_ID;
const LOG_CHANNEL_ID = process.env.LOG_CHANNEL_ID;

if (!token) {
  console.error("❌ DISCORD_TOKEN ontbreekt in .env");
  process.exit(1);
}

const client = new Client({
  intents: [GatewayIntentBits.Guilds],
});

// -------------------------
// ✅ PERSISTENTE AUDIT LOG (Render Disk)
// -------------------------
// Op Render mounten we een disk op /var/data.
// Lokaal bestaat dat pad niet, daarom gebruiken we lokaal ./data als fallback.
const AUDIT_DIR =
  process.env.AUDIT_DIR ||
  (fs.existsSync("/var/data") ? "/var/data" : path.join(__dirname, "..", "data"));

const AUDIT_FILE = path.join(AUDIT_DIR, "audit.log");

function ensureAuditDir() {
  try {
    if (!fs.existsSync(AUDIT_DIR)) {
      fs.mkdirSync(AUDIT_DIR, { recursive: true });
    }
  } catch (e) {
    console.error("⚠️ Kan audit map niet maken:", e);
  }
}

function appendAuditLog(text) {
  try {
    ensureAuditDir();

    const safeText = (text || "").toString();
    const entry = [
      "----------------------------------------",
      `Tijdstip: ${nowNl()}`,
      safeText,
      "",
    ].join("\n");

    fs.appendFileSync(AUDIT_FILE, entry, { encoding: "utf8" });
  } catch (e) {
    console.error("⚠️ Kan audit log niet wegschrijven:", e);
  }
}

// channelId -> state
// Let op: missingValues bevat tijdelijk gevoelige info (alleen in memory, niet in logs).
const ticketState = new Map(); // { approved, cancelReason?, rejectReason?, missingFields?, missingDataMessageId?, missingValues? }

function kaartNaarData(kaartValue) {
  const euro = Number(kaartValue);
  const puntenMap = { 10: 1000, 25: 2500, 50: 5000, 100: 10000 };
  const punten = puntenMap[euro];
  if (!punten) return null;
  return { euro, punten };
}

function parseTicketTopic(topic) {
  if (!topic || typeof topic !== "string") return null;

  const mUser = topic.match(/Aanvrager:\s.*\((\d{5,})\)/);
  const mEuro = topic.match(/Kaart:\s€(\d+)/);
  const mPunten = topic.match(/\((\d+)\sSebbie\)/);

  const userId = mUser ? mUser[1] : null;
  const euro = mEuro ? Number(mEuro[1]) : null;
  const punten = mPunten ? Number(mPunten[1]) : null;

  if (!userId || !euro || !punten) return null;
  return { userId, euro, punten };
}

function isAdmin(interaction) {
  return interaction.memberPermissions?.has(PermissionFlagsBits.ManageChannels);
}

function nowNl() {
  return new Date().toLocaleString("nl-NL", {
    timeZone: "Europe/Amsterdam",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

// ✅ FIX: voorkom "Unknown interaction" (10062) + ✅ geen ephemeral-deprecation warning meer (gebruik flags)
async function replyTemp(interaction, content, ms = 8000) {
  const safeTimeout = (fn) => setTimeout(() => fn().catch(() => {}), ms);

  try {
    if (interaction.deferred) {
      await interaction.editReply({ content });
      safeTimeout(() => interaction.deleteReply());
      return;
    }

    if (interaction.replied) {
      const msg = await interaction.followUp({ content, flags: MessageFlags.Ephemeral });
      safeTimeout(() => msg.delete());
      return;
    }

    await interaction.reply({ content, flags: MessageFlags.Ephemeral });
    safeTimeout(() => interaction.deleteReply());
  } catch (err) {
    if (err?.code === 10062) return;

    try {
      if (!interaction.deferred && !interaction.replied) {
        await interaction.deferReply({ flags: MessageFlags.Ephemeral }).catch(() => {});
        await interaction.editReply({ content }).catch(() => {});
        safeTimeout(() => interaction.deleteReply());
      }
    } catch {
      // niks
    }
  }
}

async function sendTemp(channel, content, ms = 10000) {
  const msg = await channel.send(content);
  setTimeout(() => msg.delete().catch(() => {}), ms);
  return msg;
}

function ticketActionRow() {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId("ticket_accept").setLabel("Accepteren").setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId("ticket_reject").setLabel("Afkeuren").setStyle(ButtonStyle.Danger),
    new ButtonBuilder().setCustomId("ticket_cancel").setLabel("Annuleren").setStyle(ButtonStyle.Secondary)
  );
}

function adminCancelRow() {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId("admin_close_cancel").setLabel("Aanvraag annuleren").setStyle(ButtonStyle.Danger)
  );
}

function adminAfterAcceptRow() {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId("ticket_paid").setLabel("Betaald").setStyle(ButtonStyle.Success).setEmoji("💰"),
    new ButtonBuilder()
      .setCustomId("ticket_missing_data")
      .setLabel("Ontbrekende gegevens")
      .setStyle(ButtonStyle.Secondary)
      .setEmoji("📋")
  );
}

function missingFieldsSelectRow() {
  const select = new StringSelectMenuBuilder()
    .setCustomId("select_missing_fields")
    .setPlaceholder("Selecteer welke gegevens ontbreken (1 of meer)")
    .setMinValues(1)
    .setMaxValues(4)
    .addOptions(
      { label: "Voornaam", value: "firstName" },
      { label: "Achternaam", value: "lastName" },
      { label: "Woonplaats", value: "city" },
      { label: "Rekeningnummer", value: "iban" }
    );

  return new ActionRowBuilder().addComponents(select);
}

function fieldsToHumanList(fields) {
  const map = {
    firstName: "Voornaam",
    lastName: "Achternaam",
    city: "Woonplaats",
    iban: "Rekeningnummer",
  };
  return fields.map((f) => map[f] || f);
}

function buildCopyButtonsRow(values) {
  const buttons = [];

  if (values.firstName) {
    buttons.push(
      new ButtonBuilder()
        .setCustomId("copy_val_firstName")
        .setLabel("Kopieer Voornaam")
        .setStyle(ButtonStyle.Primary)
        .setEmoji("📋")
    );
  }
  if (values.lastName) {
    buttons.push(
      new ButtonBuilder()
        .setCustomId("copy_val_lastName")
        .setLabel("Kopieer Achternaam")
        .setStyle(ButtonStyle.Primary)
        .setEmoji("📋")
    );
  }
  if (values.city) {
    buttons.push(
      new ButtonBuilder()
        .setCustomId("copy_val_city")
        .setLabel("Kopieer Woonplaats")
        .setStyle(ButtonStyle.Primary)
        .setEmoji("📋")
    );
  }
  if (values.iban) {
    buttons.push(
      new ButtonBuilder()
        .setCustomId("copy_val_iban")
        .setLabel("Kopieer Rekeningnr")
        .setStyle(ButtonStyle.Primary)
        .setEmoji("📋")
    );
  }

  if (!buttons.length) return null;
  return new ActionRowBuilder().addComponents(...buttons);
}

function adminWipeDataRow() {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId("admin_wipe_missing_data")
      .setLabel("Aanvullende gegevens wissen")
      .setStyle(ButtonStyle.Danger)
      .setEmoji("🗑")
  );
}

function buildMemberFillRowDisabled() {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId("member_fill_missing_data")
      .setLabel("Gegevens ontvangen ✅")
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(true)
  );
}

function buildMemberFillRowActive() {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId("member_fill_missing_data").setLabel("Gegevens invullen").setStyle(ButtonStyle.Primary)
  );
}

async function logToChannel(guild, message) {
  // ✅ 1) altijd naar audit log wegschrijven (ook als Discord kanaal niet bereikbaar is)
  appendAuditLog(message);

  // ✅ 2) daarnaast zoals altijd naar Discord log kanaal
  if (!LOG_CHANNEL_ID) return;
  const logChannel = await guild.channels.fetch(LOG_CHANNEL_ID).catch(() => null);
  if (!logChannel) return;
  if (logChannel.type !== ChannelType.GuildText) return;
  await logChannel.send(message).catch(() => {});
}

function safeForCodeBlock(text) {
  return (text || "").toString().replace(/```/g, "'''\n").replace(/`/g, "'");
}

// ✅ zoek het laatste bericht met de "Gegevens invullen" knop en disable deze
async function disableMemberFillButtonInChannel(channel) {
  const messages = await channel.messages.fetch({ limit: 50 }).catch(() => null);
  if (!messages) return;

  const target = messages.find((m) => {
    if (!m.components || !m.components.length) return false;
    return m.components.some((row) =>
      row.components?.some((c) => c.customId === "member_fill_missing_data" && c.disabled === false)
    );
  });

  if (!target) return;

  const newComponents = target.components.map((row) => {
    const hasFill = row.components?.some((c) => c.customId === "member_fill_missing_data");
    if (!hasFill) return row;
    return buildMemberFillRowDisabled();
  });

  await target.edit({ components: newComponents }).catch(() => {});
}

// ✅ haal de server-naam/nickname op voor DM-aanhef
async function getMemberDisplayName(guild, userId) {
  try {
    const member = await guild.members.fetch(userId);
    if (member?.displayName) return member.displayName;
    if (member?.user?.globalName) return member.user.globalName;
    if (member?.user?.username) return member.user.username;
  } catch {}

  try {
    const user = await client.users.fetch(userId);
    return user.globalName || user.username || "lid";
  } catch {}

  return "lid";
}

// ✅ maak een veilige channel-name slug van de servernaam / username
function slugifyChannelName(input) {
  return (input || "")
    .toString()
    .toLowerCase()
    .trim()
    .replace(/\s+/g, "-")
    .replace(/[^a-z0-9\-]/g, "")
    .replace(/\-+/g, "-")
    .replace(/^\-+|\-+$/g, "");
}

client.once(Events.ClientReady, (c) => {
  console.log(`✅ Bot is online als: ${c.user.tag}`);
  if (!TICKETS_CATEGORY_ID) console.log("⚠️ Let op: TICKETS_CATEGORY_ID ontbreekt nog in .env");
  if (!LOG_CHANNEL_ID) console.log("⚠️ Let op: LOG_CHANNEL_ID ontbreekt nog in .env (logging werkt dan niet).");

  // ✅ Laat zien waar audit logging naartoe schrijft (handig bij debug)
  console.log(`🧾 Audit log pad: ${AUDIT_FILE}`);
});

client.on(Events.InteractionCreate, async (interaction) => {
  try {
    // -------------------------
    // Slash commands
    // -------------------------
    if (interaction.isChatInputCommand()) {
      if (interaction.commandName === "ping") {
        await replyTemp(interaction, "Pong! ✅ Ik ben online.");
        return;
      }

      if (interaction.commandName === "openticket") {
        if (!isAdmin(interaction)) {
          await replyTemp(interaction, "❌ Je hebt geen rechten voor dit commando (Manage Channels nodig).");
          return;
        }
        if (!TICKETS_CATEGORY_ID) {
          await replyTemp(interaction, "❌ TICKETS_CATEGORY_ID staat nog niet in .env");
          return;
        }

        const lid = interaction.options.getUser("lid", true);
        const kaart = interaction.options.getString("kaart", true);
        const data = kaartNaarData(kaart);
        if (!data) {
          await replyTemp(interaction, "❌ Onbekende kaart.");
          return;
        }

        const { euro, punten } = data;
        const botId = interaction.client.user.id;

        const displayName = await getMemberDisplayName(interaction.guild, lid.id);
        const base = slugifyChannelName(displayName) || slugifyChannelName(lid.username) || "lid";
        const channelName = `cash-${euro}-${base}`.slice(0, 90);

        const ticketChannel = await interaction.guild.channels.create({
          name: channelName,
          type: ChannelType.GuildText,
          parent: TICKETS_CATEGORY_ID,
          topic: `Sebbie voor Cash | Aanvrager: ${lid.tag} (${lid.id}) | Kaart: €${euro} (${punten} Sebbie)`,
          permissionOverwrites: [
            { id: interaction.guild.id, deny: [PermissionFlagsBits.ViewChannel] },
            {
              id: botId,
              allow: [
                PermissionFlagsBits.ViewChannel,
                PermissionFlagsBits.SendMessages,
                PermissionFlagsBits.ReadMessageHistory,
                PermissionFlagsBits.ManageChannels,
              ],
            },
            {
              id: lid.id,
              allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory],
            },
            {
              id: interaction.user.id,
              allow: [
                PermissionFlagsBits.ViewChannel,
                PermissionFlagsBits.SendMessages,
                PermissionFlagsBits.ReadMessageHistory,
                PermissionFlagsBits.ManageChannels,
              ],
            },
          ],
        });

        ticketState.set(ticketChannel.id, { approved: false });

        const bericht = [
          `Beste ${lid},`,
          ``,
          `Jij wilt **${punten} Sebbie** omwisselen voor **€${euro} cash**.`,
          `Dit ticket is de bevestiging dat wij jouw aanvraag in behandeling hebben genomen.`,
          ``,
          `Fijne dag,`,
          `**Team StreApp**`,
        ].join("\n");

        await ticketChannel.send({ content: bericht, components: [ticketActionRow()] });
        await replyTemp(interaction, `✅ Ticket aangemaakt: ${ticketChannel}`);
        return;
      }
    }

    // -------------------------
    // Buttons
    // -------------------------
    if (interaction.isButton()) {
      const channel = interaction.channel;
      if (!channel || channel.type !== ChannelType.GuildText) {
        await replyTemp(interaction, "❌ Dit werkt alleen in een ticketkanaal.");
        return;
      }

      const meta = parseTicketTopic(channel.topic);
      if (!meta) {
        await replyTemp(interaction, "❌ Dit kanaal lijkt geen Sebbie-ticket te zijn.");
        return;
      }

      const aanvragerId = meta.userId;
      const euro = meta.euro;
      const punten = meta.punten;

      if (interaction.customId === "ticket_accept") {
        if (!isAdmin(interaction)) {
          await replyTemp(interaction, "❌ Alleen admin kan accepteren.");
          return;
        }

        const state = ticketState.get(channel.id) || {};
        ticketState.set(channel.id, { ...state, approved: true });

        const user = await client.users.fetch(aanvragerId).catch(() => null);
        if (user) {
          const displayName = await getMemberDisplayName(interaction.guild, aanvragerId);
          const ticketLink = `https://discord.com/channels/${channel.guildId}/${channel.id}`;
          await user
            .send(
              [
                `Beste ${displayName},`,
                ``,
                `We hebben je aanvraag in behandeling genomen. Via het geopende ticket kan je de voortgang volgen.`,
                `Het kan enige tijd duren voor je ticket helemaal is afgehandeld.`,
                ``,
                `Klik hier om direct naar jouw ticket te gaan: ${ticketLink}`,
                ``,
                `Fijne dag,`,
                `Team StreApp`,
              ].join("\n")
            )
            .catch(() => {});
        }

        const naam = `<@${aanvragerId}>`;
        const tekst = [
          `✅ **Aanvraag goedgekeurd**`,
          ``,
          `Beste ${naam}, je aanvraag om **${punten} Sebbie** om te wisselen voor **€${euro} cash** is goedgekeurd.`,
          ``,
          `**Wat gaat er nu gebeuren?**`,
          `Wij gaan jouw aanvraag zo snel mogelijk verwerken in onze administratie en vervolgens storten wij het geclaimde bedrag op je rekening.`,
          ``,
          `Zodra wij de betaling hebben uitgevoerd wordt het ticket gesloten.`,
          ``,
          `Fijne dag!`,
          `**Team StreApp**`,
        ].join("\n");

        await channel.send(tekst);
        await channel.send({ content: `🔐 **Admin acties** (na acceptatie):`, components: [adminAfterAcceptRow()] });

        await replyTemp(interaction, "✅ Goedgekeurd + admin knoppen geplaatst.");
        return;
      }

      if (interaction.customId === "ticket_reject") {
        if (!isAdmin(interaction)) {
          await replyTemp(interaction, "❌ Alleen admin kan afkeuren.");
          return;
        }

        const modal = new ModalBuilder().setCustomId("modal_reject_reason").setTitle("Aanvraag afkeuren (reden verplicht)");
        const reasonInput = new TextInputBuilder()
          .setCustomId("reject_reason")
          .setLabel("Reden (wordt naar het lid gestuurd)")
          .setStyle(TextInputStyle.Paragraph)
          .setRequired(true)
          .setMaxLength(1000);

        modal.addComponents(new ActionRowBuilder().addComponents(reasonInput));
        await interaction.showModal(modal);
        return;
      }

      if (interaction.customId === "ticket_cancel") {
        if (interaction.user.id !== aanvragerId) {
          await replyTemp(interaction, "❌ Alleen de aanvrager kan annuleren.");
          return;
        }

        const modal = new ModalBuilder().setCustomId("modal_cancel_reason").setTitle("Aanvraag annuleren (reden verplicht)");
        const reasonInput = new TextInputBuilder()
          .setCustomId("cancel_reason")
          .setLabel("Reden van annuleren")
          .setStyle(TextInputStyle.Paragraph)
          .setRequired(true)
          .setMaxLength(1000);

        modal.addComponents(new ActionRowBuilder().addComponents(reasonInput));
        await interaction.showModal(modal);
        return;
      }

      if (interaction.customId === "admin_close_cancel") {
        if (!isAdmin(interaction)) {
          await replyTemp(interaction, "❌ Alleen admin kan dit doen.");
          return;
        }

        const state = ticketState.get(channel.id) || {};
        const reason = state.cancelReason || "Geen reden opgegeven.";

        const user = await client.users.fetch(aanvragerId).catch(() => null);
        if (user) {
          const displayName = await getMemberDisplayName(interaction.guild, aanvragerId);
          await user
            .send(
              [
                `Beste ${displayName},`,
                ``,
                `Je hebt je aanvraag om **${punten} Sebbie** te wisselen voor **€${euro} cash** geannuleerd.`,
                `Je gaf hierbij op als reden: ${reason}`,
                ``,
                `Je ticket is afgesloten.`,
                `Fijne dag.`,
                `Team StreApp`,
              ].join("\n")
            )
            .catch(() => {});
        }

        await logToChannel(
          interaction.guild,
          [
            `🟡 **Ticket geannuleerd (door lid, afgesloten door admin)**`,
            `Lid: <@${aanvragerId}>`,
            `Ingewisseld: ${punten} Sebbie (aanvraag)`,
            `Bedrag: €${euro}`,
            `Reden: ${reason}`,
            `Tijdstip: ${nowNl()}`,
            `Admin: <@${interaction.user.id}>`,
            `Kanaal: #${channel.name}`,
          ].join("\n")
        );

        await replyTemp(interaction, "✅ Ticket wordt afgesloten.");
        ticketState.delete(channel.id);
        await channel.delete("Sebbie voor Cash: geannuleerd").catch(() => {});
        return;
      }

      if (interaction.customId === "ticket_paid") {
        if (!isAdmin(interaction)) {
          await replyTemp(interaction, "❌ Alleen admin kan dit doen.");
          return;
        }

        const state = ticketState.get(channel.id) || {};
        if (!state.approved) {
          await replyTemp(interaction, "❌ Je kunt pas op Betaald klikken nadat je de aanvraag hebt geaccepteerd.");
          return;
        }

        const modal = new ModalBuilder().setCustomId("modal_paid_agreement").setTitle("Betaling afronden");
        const koInput = new TextInputBuilder()
          .setCustomId("agreement_no")
          .setLabel("Koopovereenkomst nummer (verplicht)")
          .setPlaceholder("Bijv: K20260401")
          .setStyle(TextInputStyle.Short)
          .setRequired(true)
          .setMaxLength(30);

        modal.addComponents(new ActionRowBuilder().addComponents(koInput));
        await interaction.showModal(modal);
        return;
      }

      if (interaction.customId === "ticket_missing_data") {
        if (!isAdmin(interaction)) {
          await replyTemp(interaction, "❌ Alleen admin kan dit doen.");
          return;
        }

        const state = ticketState.get(channel.id) || {};
        if (!state.approved) {
          await replyTemp(interaction, "❌ Gebruik Ontbrekende gegevens pas nadat je de aanvraag hebt geaccepteerd.");
          return;
        }

        await interaction
          .reply({
            content: `📋 Selecteer hieronder welke gegevens ontbreken:`,
            components: [missingFieldsSelectRow()],
            flags: MessageFlags.Ephemeral,
          })
          .catch(() => {});
        setTimeout(() => interaction.deleteReply().catch(() => {}), 8000);
        return;
      }

      if (interaction.customId.startsWith("copy_val_")) {
        if (!isAdmin(interaction)) {
          await replyTemp(interaction, "❌ Alleen admin kan dit doen.");
          return;
        }

        const state = ticketState.get(channel.id) || {};
        const values = state.missingValues;
        if (!values) {
          await replyTemp(interaction, "❌ Geen gegevens om te kopiëren (nog niet ingevuld of al gewist).");
          return;
        }

        const key = interaction.customId.replace("copy_val_", "");
        const value = (values[key] || "").toString().trim();

        if (!value) {
          await replyTemp(interaction, "❌ Dit veld heeft geen waarde.");
          return;
        }

        const safe = safeForCodeBlock(value);
        await replyTemp(interaction, `\`\`\`\n${safe}\n\`\`\``, 15000);
        return;
      }

      if (interaction.customId === "admin_wipe_missing_data") {
        if (!isAdmin(interaction)) {
          await replyTemp(interaction, "❌ Alleen admin kan dit doen.");
          return;
        }

        const state = ticketState.get(channel.id) || {};
        const msgId = state.missingDataMessageId;

        if (msgId) {
          const msg = await channel.messages.fetch(msgId).catch(() => null);
          if (msg) await msg.delete().catch(() => {});
        }

        ticketState.set(channel.id, {
          ...state,
          missingFields: undefined,
          missingDataMessageId: undefined,
          missingValues: undefined,
        });

        await replyTemp(interaction, "🗑 Aanvullende gegevens zijn gewist uit dit ticket.");
        await sendTemp(channel, "🗑 **Aanvullende gegevens zijn door admin gewist (privacy).**", 10000).catch(() => {});
        return;
      }

      // Lid knop: Gegevens invullen -> modal
      if (interaction.customId === "member_fill_missing_data") {
        const meta2 = parseTicketTopic(channel.topic);
        if (!meta2) {
          await replyTemp(interaction, "❌ Dit kanaal lijkt geen Sebbie-ticket te zijn.");
          return;
        }

        const aanvragerId2 = meta2.userId;

        if (interaction.user.id !== aanvragerId2) {
          await replyTemp(interaction, "❌ Alleen de aanvrager kan dit invullen.");
          return;
        }

        const state = ticketState.get(channel.id) || {};
        const fields = state.missingFields || [];
        if (!fields.length) {
          await replyTemp(interaction, "❌ Er zijn geen ontbrekende velden aangevraagd.");
          return;
        }

        const modal = new ModalBuilder().setCustomId("modal_member_missing_data").setTitle("Aanvullende gegevens invullen");

        const components = [];

        if (fields.includes("firstName")) {
          const input = new TextInputBuilder()
            .setCustomId("firstName")
            .setLabel("Voornaam")
            .setStyle(TextInputStyle.Short)
            .setRequired(true)
            .setMaxLength(80);
          components.push(new ActionRowBuilder().addComponents(input));
        }

        if (fields.includes("lastName")) {
          const input = new TextInputBuilder()
            .setCustomId("lastName")
            .setLabel("Achternaam")
            .setStyle(TextInputStyle.Short)
            .setRequired(true)
            .setMaxLength(120);
          components.push(new ActionRowBuilder().addComponents(input));
        }

        if (fields.includes("city")) {
          const input = new TextInputBuilder()
            .setCustomId("city")
            .setLabel("Woonplaats (alleen plaatsnaam)")
            .setStyle(TextInputStyle.Short)
            .setRequired(true)
            .setMaxLength(120);
          components.push(new ActionRowBuilder().addComponents(input));
        }

        if (fields.includes("iban")) {
          const input = new TextInputBuilder()
            .setCustomId("iban")
            .setLabel("Rekeningnummer (IBAN)")
            .setPlaceholder("Bijv: NL00BANK0123456789")
            .setStyle(TextInputStyle.Short)
            .setRequired(true)
            .setMaxLength(34);
          components.push(new ActionRowBuilder().addComponents(input));
        }

        modal.addComponents(...components);
        await interaction.showModal(modal);
        return;
      }
    }

    // -------------------------
    // Select menu
    // -------------------------
    if (interaction.isStringSelectMenu()) {
      const channel = interaction.channel;
      if (!channel || channel.type !== ChannelType.GuildText) {
        await replyTemp(interaction, "❌ Dit werkt alleen in een ticketkanaal.");
        return;
      }

      const meta = parseTicketTopic(channel.topic);
      if (!meta) {
        await replyTemp(interaction, "❌ Dit kanaal lijkt geen Sebbie-ticket te zijn.");
        return;
      }

      if (interaction.customId === "select_missing_fields") {
        if (!isAdmin(interaction)) {
          await replyTemp(interaction, "❌ Alleen admin kan dit doen.");
          return;
        }

        const selected = interaction.values;
        const state = ticketState.get(channel.id) || {};
        ticketState.set(channel.id, { ...state, missingFields: selected });

        const human = fieldsToHumanList(selected);

        const requestText = [
          `📋 **Aanvullende gegevens vereist**`,
          ``,
          `Wij hebben aanvullende gegevens nodig om het door jou geclaimde bedrag op je rekening te storten.`,
          `We missen: **${human.join(", ")}**`,
          ``,
          `Klik op **"Gegevens invullen"** om de gevraagde gegevens aan te leveren.`,
          ``,
          `⚠️ Zorg dat je de ingevoerde gegevens goed controleert om vertraging te voorkomen en om te zorgen dat we het bedrag aan de juiste persoon overmaken.`,
        ].join("\n");

        await channel.send({ content: requestText, components: [buildMemberFillRowActive()] });
        await replyTemp(interaction, "✅ Verzoek geplaatst in het ticket.");
        return;
      }
    }

    // -------------------------
    // Modals
    // -------------------------
    if (interaction.isModalSubmit()) {
      const channel = interaction.channel;
      if (!channel || channel.type !== ChannelType.GuildText) {
        await replyTemp(interaction, "❌ Dit werkt alleen in een ticketkanaal.");
        return;
      }

      const meta = parseTicketTopic(channel.topic);
      if (!meta) {
        await replyTemp(interaction, "❌ Dit kanaal lijkt geen Sebbie-ticket te zijn.");
        return;
      }

      const aanvragerId = meta.userId;
      const euro = meta.euro;
      const punten = meta.punten;

      if (interaction.customId === "modal_reject_reason") {
        if (!isAdmin(interaction)) {
          await replyTemp(interaction, "❌ Alleen admin kan afkeuren.");
          return;
        }

        const reason = interaction.fields.getTextInputValue("reject_reason");
        ticketState.set(channel.id, { ...(ticketState.get(channel.id) || {}), rejectReason: reason });

        await channel.send([`❌ **Aanvraag afgekeurd**`, `Reden: ${reason}`].join("\n"));

        const user = await client.users.fetch(aanvragerId).catch(() => null);
        if (user) {
          const displayName = await getMemberDisplayName(interaction.guild, aanvragerId);
          await user
            .send(
              [
                `Beste ${displayName},`,
                ``,
                `Je aanvraag om **${punten} Sebbie** om te wisselen voor **€${euro} cash** is **afgekeurd**.`,
                `Reden: ${reason}`,
                ``,
                `Fijne dag,`,
                `Team StreApp`,
              ].join("\n")
            )
            .catch(() => {});
        }

        await logToChannel(
          interaction.guild,
          [
            `🔴 **Ticket afgekeurd (afgesloten door admin)**`,
            `Lid: <@${aanvragerId}>`,
            `Ingewisseld: ${punten} Sebbie (aanvraag)`,
            `Bedrag: €${euro}`,
            `Reden afkeuring: ${reason}`,
            `Tijdstip: ${nowNl()}`,
            `Admin: <@${interaction.user.id}>`,
            `Kanaal: #${channel.name}`,
          ].join("\n")
        );

        await replyTemp(interaction, "✅ Afkeuring verstuurd. Ticket wordt afgesloten.");

        ticketState.delete(channel.id);
        await channel.delete("Sebbie voor Cash: afgekeurd").catch(() => {});
        return;
      }

      if (interaction.customId === "modal_cancel_reason") {
        if (interaction.user.id !== aanvragerId) {
          await replyTemp(interaction, "❌ Alleen de aanvrager kan annuleren.");
          return;
        }

        const reason = interaction.fields.getTextInputValue("cancel_reason");
        ticketState.set(channel.id, { ...(ticketState.get(channel.id) || {}), cancelReason: reason });

        await channel.send({
          content: [`🟡 **Aanvraag geannuleerd door lid**`, `Reden: ${reason}`].join("\n"),
          components: [adminCancelRow()],
        });

        await replyTemp(interaction, "✅ Annulering doorgegeven. Admin kan nu afsluiten.");
        return;
      }

      if (interaction.customId === "modal_paid_agreement") {
        if (!isAdmin(interaction)) {
          await replyTemp(interaction, "❌ Alleen admin kan dit doen.");
          return;
        }

        const state = ticketState.get(channel.id) || {};
        if (!state.approved) {
          await replyTemp(interaction, "❌ Je kunt pas afronden nadat je de aanvraag hebt geaccepteerd.");
          return;
        }

        const agreementNo = (interaction.fields.getTextInputValue("agreement_no") || "").trim();
        if (!agreementNo.startsWith("K") || agreementNo.length < 5) {
          await replyTemp(interaction, "❌ Ongeldig koopovereenkomst nummer. Gebruik bv: K20260401");
          return;
        }

        const user = await client.users.fetch(aanvragerId).catch(() => null);
        if (user) {
          const displayName = await getMemberDisplayName(interaction.guild, aanvragerId);
          await user
            .send(
              [
                `Beste ${displayName},`,
                ``,
                `Wij hebben jouw aanvraag verwerkt.`,
                `✅ Je hebt **${punten} Sebbie** ingewisseld voor **€${euro} cash**.`,
                `Koopovereenkomst: **${agreementNo}**`,
                ``,
                `Je ticket is afgesloten.`,
                `Fijne dag!`,
                `Team StreApp`,
              ].join("\n")
            )
            .catch(() => {});
        }

        await logToChannel(
          interaction.guild,
          [
            `💰 **Betaalde aanvraag**`,
            `Lid: <@${aanvragerId}>`,
            `Ingewisseld: ${punten} Sebbie`,
            `Bedrag: €${euro}`,
            `Koopovereenkomst: ${agreementNo}`,
            `Tijdstip: ${nowNl()}`,
            `Admin: <@${interaction.user.id}>`,
            `Kanaal: #${channel.name}`,
          ].join("\n")
        );

        await replyTemp(interaction, "✅ Betaald geregistreerd. Ticket wordt gesloten.");

        ticketState.delete(channel.id);
        await channel.delete(`Sebbie voor Cash: betaald (${agreementNo})`).catch(() => {});
        return;
      }

      if (interaction.customId === "modal_member_missing_data") {
        if (interaction.user.id !== aanvragerId) {
          await replyTemp(interaction, "❌ Alleen de aanvrager kan dit invullen.");
          return;
        }

        const state = ticketState.get(channel.id) || {};
        const fields = state.missingFields || [];
        if (!fields.length) {
          await replyTemp(interaction, "❌ Er zijn geen ontbrekende velden aangevraagd.");
          return;
        }

        const values = {};
        if (fields.includes("firstName")) values.firstName = interaction.fields.getTextInputValue("firstName")?.trim();
        if (fields.includes("lastName")) values.lastName = interaction.fields.getTextInputValue("lastName")?.trim();
        if (fields.includes("city")) values.city = interaction.fields.getTextInputValue("city")?.trim();
        if (fields.includes("iban")) values.iban = interaction.fields.getTextInputValue("iban")?.trim();

        const human = fieldsToHumanList(fields);

        const lines = [
          `📨 **Aanvullende gegevens ontvangen (alleen in dit ticket zichtbaar)**`,
          `Gevraagd: **${human.join(", ")}**`,
          ``,
          ...(values.firstName ? [`**Voornaam:** ${values.firstName}`] : []),
          ...(values.lastName ? [`**Achternaam:** ${values.lastName}`] : []),
          ...(values.city ? [`**Woonplaats:** ${values.city}`] : []),
          ...(values.iban ? [`**Rekeningnummer:** ${values.iban}`] : []),
          ``,
          `✅ Dankjewel! We gaan hiermee verder in de administratie.`,
          `⚠️ Admin zal deze gegevens verwijderen zodra ze zijn overgenomen (privacy).`,
        ].join("\n");

        const copyRow = buildCopyButtonsRow(values);
        const components = [];
        if (copyRow) components.push(copyRow);
        components.push(adminWipeDataRow());

        const msg = await channel.send({ content: lines, components });

        ticketState.set(channel.id, {
          ...state,
          missingDataMessageId: msg.id,
          missingValues: values,
        });

        await disableMemberFillButtonInChannel(channel);

        await replyTemp(interaction, "✅ Je gegevens zijn opgeslagen in het ticket.");
        return;
      }
    }
  } catch (err) {
    if (err?.code === 10062) return;

    console.error("❌ Fout:", err);
    if (interaction.isRepliable()) {
      try {
        if (!interaction.replied && !interaction.deferred) {
          await replyTemp(interaction, "❌ Er ging iets mis. Check PowerShell output.");
        }
      } catch {
        // niks
      }
    }
  }
});

client.login(token);