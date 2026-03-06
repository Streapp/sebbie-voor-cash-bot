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
// PERSISTENTE AUDIT LOG
// -------------------------
const AUDIT_DIR =
  process.env.AUDIT_DIR ||
  (fs.existsSync("/var/data") ? "/var/data" : path.join(__dirname, "..", "data"));

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

function dateKeyNl() {
  const parts = new Intl.DateTimeFormat("nl-NL", {
    timeZone: "Europe/Amsterdam",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date());

  const y = parts.find((p) => p.type === "year")?.value;
  const m = parts.find((p) => p.type === "month")?.value;
  const d = parts.find((p) => p.type === "day")?.value;

  return `${y}-${m}-${d}`;
}

function auditFilePathForToday() {
  return path.join(AUDIT_DIR, `audit-${dateKeyNl()}.log`);
}

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

    const entry = [
      "----------------------------------------",
      `Tijdstip: ${nowNl()}`,
      (text || "").toString(),
      "",
    ].join("\n");

    fs.appendFileSync(auditFilePathForToday(), entry, { encoding: "utf8" });
  } catch (e) {
    console.error("⚠️ Kan audit log niet wegschrijven:", e);
  }
}

// -------------------------
// STATE
// -------------------------
// channelId -> {
//   approved: boolean,
//   adminUserId: string,
//   status: string,
//   closed?: boolean,
//   ticketName?: string,
//   ticketUrl?: string,
//   openedAt?: string,
//   meta?: { userId, euro, punten },
//   cancelReason?: string,
//   rejectReason?: string,
//   missingFields?: string[],
//   missingValues?: object,
//   adminDmChannelId?: string,
//   adminControlMessageId?: string,
//   missingDataAdminMessageId?: string,
//   missingDataTicketNoticeMessageId?: string
// }
const ticketState = new Map();

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

async function replyTemp(interaction, content, ms = 8000) {
  const safeTimeout = (fn) => setTimeout(() => fn().catch(() => {}), ms);

  try {
    if (interaction.deferred) {
      await interaction.editReply({ content });
      safeTimeout(() => interaction.deleteReply().catch(() => {}));
      return;
    }

    if (interaction.replied) {
      const msg = await interaction.followUp({ content, flags: MessageFlags.Ephemeral });
      safeTimeout(() => msg.delete().catch(() => {}));
      return;
    }

    await interaction.reply({ content, flags: MessageFlags.Ephemeral });
    safeTimeout(() => interaction.deleteReply().catch(() => {}));
  } catch (err) {
    if (err?.code === 10062) return;

    try {
      if (!interaction.deferred && !interaction.replied) {
        await interaction.deferReply({ flags: MessageFlags.Ephemeral }).catch(() => {});
        await interaction.editReply({ content }).catch(() => {});
        safeTimeout(() => interaction.deleteReply().catch(() => {}));
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

function safeForCodeBlock(text) {
  return (text || "").toString().replace(/```/g, "'''\n").replace(/`/g, "'");
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

async function logToChannel(guild, message) {
  appendAuditLog(message);

  if (!LOG_CHANNEL_ID) return;
  const logChannel = await guild.channels.fetch(LOG_CHANNEL_ID).catch(() => null);
  if (!logChannel) return;
  if (logChannel.type !== ChannelType.GuildText) return;
  await logChannel.send(message).catch(() => {});
}

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

function memberInitialRow() {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId("ticket_cancel").setLabel("Annuleren").setStyle(ButtonStyle.Secondary)
  );
}

function memberCancelDisabledRow() {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId("ticket_cancel")
      .setLabel("Annuleren")
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(true)
  );
}

function buildMemberFillRowActive() {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId("member_fill_missing_data").setLabel("Gegevens invullen").setStyle(ButtonStyle.Primary)
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

function missingFieldsSelectRow(ticketChannelId) {
  const select = new StringSelectMenuBuilder()
    .setCustomId(`select_missing_fields:${ticketChannelId}`)
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

function buildCopyButtonsRow(ticketChannelId, values) {
  const buttons = [];

  if (values.firstName) {
    buttons.push(
      new ButtonBuilder()
        .setCustomId(`copy_val_firstName:${ticketChannelId}`)
        .setLabel("Kopieer Voornaam")
        .setStyle(ButtonStyle.Primary)
        .setEmoji("📋")
    );
  }
  if (values.lastName) {
    buttons.push(
      new ButtonBuilder()
        .setCustomId(`copy_val_lastName:${ticketChannelId}`)
        .setLabel("Kopieer Achternaam")
        .setStyle(ButtonStyle.Primary)
        .setEmoji("📋")
    );
  }
  if (values.city) {
    buttons.push(
      new ButtonBuilder()
        .setCustomId(`copy_val_city:${ticketChannelId}`)
        .setLabel("Kopieer Woonplaats")
        .setStyle(ButtonStyle.Primary)
        .setEmoji("📋")
    );
  }
  if (values.iban) {
    buttons.push(
      new ButtonBuilder()
        .setCustomId(`copy_val_iban:${ticketChannelId}`)
        .setLabel("Kopieer Rekeningnr")
        .setStyle(ButtonStyle.Primary)
        .setEmoji("📋")
    );
  }

  if (!buttons.length) return null;
  return new ActionRowBuilder().addComponents(...buttons);
}

function adminWipeDataRow(ticketChannelId) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`admin_wipe_missing_data:${ticketChannelId}`)
      .setLabel("Aanvullende gegevens wissen")
      .setStyle(ButtonStyle.Danger)
      .setEmoji("🗑")
  );
}

function buildAdminControlRows(ticketChannelId, state) {
  const rows = [];

  if (state.closed) return rows;

  if (state.cancelReason) {
    rows.push(
      new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setCustomId(`admin_close_cancel:${ticketChannelId}`)
          .setLabel("Aanvraag annuleren")
          .setStyle(ButtonStyle.Danger)
      )
    );
    return rows;
  }

  if (!state.approved) {
    rows.push(
      new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId(`ticket_accept:${ticketChannelId}`).setLabel("Accepteren").setStyle(ButtonStyle.Success),
        new ButtonBuilder().setCustomId(`ticket_reject:${ticketChannelId}`).setLabel("Afkeuren").setStyle(ButtonStyle.Danger)
      )
    );
    return rows;
  }

  rows.push(
    new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId(`ticket_paid:${ticketChannelId}`)
        .setLabel("Betaald")
        .setStyle(ButtonStyle.Success)
        .setEmoji("💰"),
      new ButtonBuilder()
        .setCustomId(`ticket_missing_data:${ticketChannelId}`)
        .setLabel("Ontbrekende gegevens")
        .setStyle(ButtonStyle.Secondary)
        .setEmoji("📋")
    )
  );

  return rows;
}

function extractTicketId(customId, prefix) {
  if (!customId.startsWith(`${prefix}:`)) return null;
  return customId.slice(prefix.length + 1);
}

function getStatusLabel(state) {
  if (state.closed && state.status) return state.status;
  if (state.status) return state.status;
  if (state.cancelReason) return "Geannuleerd door lid";
  if (state.approved && state.missingFields?.length) return "Wachten op aanvullende gegevens";
  if (state.approved) return "Goedgekeurd";
  return "Openstaand";
}

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

async function disableMemberCancelButtonInChannel(channel) {
  const messages = await channel.messages.fetch({ limit: 50 }).catch(() => null);
  if (!messages) return;

  const target = messages.find((m) => {
    if (!m.components || !m.components.length) return false;
    return m.components.some((row) =>
      row.components?.some((c) => c.customId === "ticket_cancel" && c.disabled === false)
    );
  });

  if (!target) return;

  const newComponents = target.components.map((row) => {
    const hasCancel = row.components?.some((c) => c.customId === "ticket_cancel");
    if (!hasCancel) return row;
    return memberCancelDisabledRow();
  });

  await target.edit({ components: newComponents }).catch(() => {});
}

async function getTicketChannelById(ticketChannelId) {
  for (const guild of client.guilds.cache.values()) {
    const ch = await guild.channels.fetch(ticketChannelId).catch(() => null);
    if (ch) return ch;
  }
  return null;
}

async function getAdminDmChannel(userId) {
  const user = await client.users.fetch(userId).catch(() => null);
  if (!user) return null;
  return await user.createDM().catch(() => null);
}

function buildAdminStatusText(state) {
  const meta = state.meta || {};
  const ticketName = state.ticketName || "onbekend";
  const openedAt = state.openedAt || "onbekend";
  const ticketUrl = state.ticketUrl || "onbekend";

  const lines = [
    `🔐 **Adminbediening Sebbie voor Cash**`,
    `Geopend: **${openedAt}**`,
    `Ticketlink: ${ticketUrl}`,
    `Kanaal: **#${ticketName}**`,
    `Aanvrager: <@${meta.userId || "onbekend"}>`,
    `Bedrag: **€${meta.euro ?? "?"}**`,
    `Sebbie: **${meta.punten ?? "?"}**`,
    ``,
    `Status: **${getStatusLabel(state)}**`,
  ];

  if (state.cancelReason) {
    lines.push(`Reden annulering: ${state.cancelReason}`);
  }

  if (state.rejectReason) {
    lines.push(`Reden afkeuring: ${state.rejectReason}`);
  }

  return lines.join("\n");
}

async function upsertAdminControlPanelByState(ticketChannelId) {
  const state = ticketState.get(ticketChannelId);
  if (!state?.adminUserId) return;

  const dm = await getAdminDmChannel(state.adminUserId);
  if (!dm) return;

  const content = buildAdminStatusText(state);
  const components = buildAdminControlRows(ticketChannelId, state);

  let msg = null;
  if (state.adminControlMessageId) {
    msg = await dm.messages.fetch(state.adminControlMessageId).catch(() => null);
  }

  if (msg) {
    await msg.edit({ content, components }).catch(() => {});
    return;
  }

  const sent = await dm.send({ content, components }).catch(() => null);
  if (!sent) return;

  ticketState.set(ticketChannelId, {
    ...state,
    adminDmChannelId: dm.id,
    adminControlMessageId: sent.id,
  });
}

async function markTicketClosed(ticketChannelId, finalStatus, extra = {}) {
  const current = ticketState.get(ticketChannelId);
  if (!current) return;

  const next = {
    ...current,
    ...extra,
    status: finalStatus,
    closed: true,
    approved: current.approved,
  };

  ticketState.set(ticketChannelId, next);
  await upsertAdminControlPanelByState(ticketChannelId);
}

async function deleteAdminDetailMessage(ticketChannelId) {
  const state = ticketState.get(ticketChannelId);
  if (!state?.adminDmChannelId || !state?.missingDataAdminMessageId) return;

  const userDm = await client.channels.fetch(state.adminDmChannelId).catch(() => null);
  if (!userDm) return;

  const msg = await userDm.messages.fetch(state.missingDataAdminMessageId).catch(() => null);
  if (msg) await msg.delete().catch(() => {});
}

async function deleteMemberMissingNotice(ticketChannel) {
  const state = ticketState.get(ticketChannel.id);
  if (!state?.missingDataTicketNoticeMessageId) return;

  const msg = await ticketChannel.messages.fetch(state.missingDataTicketNoticeMessageId).catch(() => null);
  if (msg) await msg.delete().catch(() => {});
}

async function clearMissingDataMessages(ticketChannel) {
  await deleteAdminDetailMessage(ticketChannel.id);
  await deleteMemberMissingNotice(ticketChannel);

  const state = ticketState.get(ticketChannel.id) || {};
  const nextStatus = state.approved ? "Goedgekeurd" : state.cancelReason ? "Geannuleerd door lid" : "Openstaand";

  ticketState.set(ticketChannel.id, {
    ...state,
    status: state.closed ? state.status : nextStatus,
    missingFields: undefined,
    missingValues: undefined,
    missingDataAdminMessageId: undefined,
    missingDataTicketNoticeMessageId: undefined,
  });
}

client.once(Events.ClientReady, (c) => {
  console.log(`✅ Bot is online als: ${c.user.tag}`);
  if (!TICKETS_CATEGORY_ID) console.log("⚠️ Let op: TICKETS_CATEGORY_ID ontbreekt nog in .env");
  if (!LOG_CHANNEL_ID) console.log("⚠️ Let op: LOG_CHANNEL_ID ontbreekt nog in .env (logging werkt dan niet).");
  console.log(`🧾 Audit log map: ${AUDIT_DIR}`);
  console.log(`🧾 Audit log bestand vandaag: ${auditFilePathForToday()}`);
});

client.on(Events.InteractionCreate, async (interaction) => {
  try {
    // -------------------------
    // SLASH COMMANDS
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

        const meta = { userId: lid.id, euro, punten };
        const openedAt = nowNl();
        const ticketUrl = `https://discord.com/channels/${ticketChannel.guildId}/${ticketChannel.id}`;

        ticketState.set(ticketChannel.id, {
          approved: false,
          adminUserId: interaction.user.id,
          status: "Openstaand",
          closed: false,
          ticketName: ticketChannel.name,
          ticketUrl,
          openedAt,
          meta,
        });

        const bericht = [
          `Beste ${lid},`,
          ``,
          `Jij wilt **${punten} Sebbie** omwisselen voor **€${euro} cash**.`,
          `Dit ticket is de bevestiging dat wij jouw aanvraag in behandeling hebben genomen.`,
          ``,
          `Fijne dag,`,
          `**Team StreApp**`,
        ].join("\n");

        await ticketChannel.send({
          content: bericht,
          components: [memberInitialRow()],
        });

        await upsertAdminControlPanelByState(ticketChannel.id);

        await replyTemp(interaction, `✅ Ticket aangemaakt: ${ticketChannel}\n🔐 Adminbediening is naar je DM gestuurd.`);
        return;
      }
    }

    // -------------------------
    // TICKET BUTTONS (in kanaal)
    // -------------------------
    if (interaction.isButton()) {
      const channel = interaction.channel;

      if (interaction.customId === "ticket_cancel") {
        if (!channel || channel.type !== ChannelType.GuildText) {
          await replyTemp(interaction, "❌ Dit werkt alleen in een ticketkanaal.");
          return;
        }

        const meta = parseTicketTopic(channel.topic);
        if (!meta) {
          await replyTemp(interaction, "❌ Dit kanaal lijkt geen Sebbie-ticket te zijn.");
          return;
        }

        if (interaction.user.id !== meta.userId) {
          await replyTemp(interaction, "❌ Alleen de aanvrager kan annuleren.");
          return;
        }

        const state = ticketState.get(channel.id) || {};
        if (state.approved) {
          await replyTemp(interaction, "❌ Annuleren is niet meer mogelijk nadat de aanvraag is geaccepteerd.");
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

      if (interaction.customId === "member_fill_missing_data") {
        if (!channel || channel.type !== ChannelType.GuildText) {
          await replyTemp(interaction, "❌ Dit werkt alleen in het hoofd-ticket.");
          return;
        }

        const meta = parseTicketTopic(channel.topic);
        if (!meta) {
          await replyTemp(interaction, "❌ Dit kanaal lijkt geen Sebbie-ticket te zijn.");
          return;
        }

        if (interaction.user.id !== meta.userId) {
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
          components.push(
            new ActionRowBuilder().addComponents(
              new TextInputBuilder()
                .setCustomId("firstName")
                .setLabel("Voornaam")
                .setStyle(TextInputStyle.Short)
                .setRequired(true)
                .setMaxLength(80)
            )
          );
        }

        if (fields.includes("lastName")) {
          components.push(
            new ActionRowBuilder().addComponents(
              new TextInputBuilder()
                .setCustomId("lastName")
                .setLabel("Achternaam")
                .setStyle(TextInputStyle.Short)
                .setRequired(true)
                .setMaxLength(120)
            )
          );
        }

        if (fields.includes("city")) {
          components.push(
            new ActionRowBuilder().addComponents(
              new TextInputBuilder()
                .setCustomId("city")
                .setLabel("Woonplaats (alleen plaatsnaam)")
                .setStyle(TextInputStyle.Short)
                .setRequired(true)
                .setMaxLength(120)
            )
          );
        }

        if (fields.includes("iban")) {
          components.push(
            new ActionRowBuilder().addComponents(
              new TextInputBuilder()
                .setCustomId("iban")
                .setLabel("Rekeningnummer (IBAN)")
                .setPlaceholder("Bijv: NL00BANK0123456789")
                .setStyle(TextInputStyle.Short)
                .setRequired(true)
                .setMaxLength(34)
            )
          );
        }

        modal.addComponents(...components);
        await interaction.showModal(modal);
        return;
      }

      // -------------------------
      // ADMIN BUTTONS (via DM)
      // -------------------------
      const ticketAcceptId = extractTicketId(interaction.customId, "ticket_accept");
      const ticketRejectId = extractTicketId(interaction.customId, "ticket_reject");
      const ticketPaidId = extractTicketId(interaction.customId, "ticket_paid");
      const ticketMissingDataId = extractTicketId(interaction.customId, "ticket_missing_data");
      const adminCloseCancelId = extractTicketId(interaction.customId, "admin_close_cancel");
      const adminWipeId = extractTicketId(interaction.customId, "admin_wipe_missing_data");

      const copyKeys = ["firstName", "lastName", "city", "iban"];
      let copyField = null;
      let copyTicketId = null;
      for (const key of copyKeys) {
        const maybeId = extractTicketId(interaction.customId, `copy_val_${key}`);
        if (maybeId) {
          copyField = key;
          copyTicketId = maybeId;
          break;
        }
      }

      const adminTicketId =
        ticketAcceptId ||
        ticketRejectId ||
        ticketPaidId ||
        ticketMissingDataId ||
        adminCloseCancelId ||
        adminWipeId ||
        copyTicketId;

      if (adminTicketId) {
        const state = ticketState.get(adminTicketId);
        if (!state) {
          await replyTemp(interaction, "❌ Ticket niet gevonden.");
          return;
        }

        if (interaction.user.id !== state.adminUserId) {
          await replyTemp(interaction, "❌ Alleen de ticketadmin kan deze DM-bediening gebruiken.");
          return;
        }

        if (state.closed) {
          await replyTemp(interaction, `ℹ️ Dit ticket is al afgesloten met status: ${getStatusLabel(state)}.`);
          return;
        }

        const ticketChannel = await getTicketChannelById(adminTicketId);
        if (!ticketChannel || ticketChannel.type !== ChannelType.GuildText) {
          await replyTemp(interaction, "❌ Ticketkanaal niet gevonden.");
          return;
        }

        const meta = state.meta || parseTicketTopic(ticketChannel.topic);
        if (!meta) {
          await replyTemp(interaction, "❌ Ticketgegevens ongeldig.");
          return;
        }

        const aanvragerId = meta.userId;
        const euro = meta.euro;
        const punten = meta.punten;

        if (ticketAcceptId) {
          ticketState.set(ticketChannel.id, {
            ...state,
            approved: true,
            status: "Goedgekeurd",
            ticketName: ticketChannel.name,
            meta,
          });

          const user = await client.users.fetch(aanvragerId).catch(() => null);
          if (user) {
            const displayName = await getMemberDisplayName(ticketChannel.guild, aanvragerId);
            const ticketLink = `https://discord.com/channels/${ticketChannel.guildId}/${ticketChannel.id}`;
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

          await ticketChannel.send(tekst);
          await disableMemberCancelButtonInChannel(ticketChannel);
          await upsertAdminControlPanelByState(ticketChannel.id);
          await replyTemp(interaction, "✅ Aanvraag goedgekeurd.");
          return;
        }

        if (ticketRejectId) {
          const modal = new ModalBuilder()
            .setCustomId(`modal_reject_reason:${ticketChannel.id}`)
            .setTitle("Aanvraag afkeuren (reden verplicht)");

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

        if (adminCloseCancelId) {
          const reason = state.cancelReason || "Geen reden opgegeven.";

          const user = await client.users.fetch(aanvragerId).catch(() => null);
          if (user) {
            const displayName = await getMemberDisplayName(ticketChannel.guild, aanvragerId);
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
            ticketChannel.guild,
            [
              `🟡 **Ticket geannuleerd (door lid, afgesloten door admin)**`,
              `Lid: <@${aanvragerId}>`,
              `Ingewisseld: ${punten} Sebbie (aanvraag)`,
              `Bedrag: €${euro}`,
              `Reden: ${reason}`,
              `Tijdstip: ${nowNl()}`,
              `Admin: <@${interaction.user.id}>`,
              `Kanaal: #${ticketChannel.name}`,
            ].join("\n")
          );

          await clearMissingDataMessages(ticketChannel);
          await markTicketClosed(ticketChannel.id, "Geannuleerd door lid", {
            cancelReason: reason,
            ticketName: ticketChannel.name,
            meta,
          });

          await replyTemp(interaction, "✅ Ticket wordt afgesloten.");
          await ticketChannel.delete("Sebbie voor Cash: geannuleerd").catch(() => {});
          return;
        }

        if (ticketPaidId) {
          if (!state.approved) {
            await replyTemp(interaction, "❌ Je kunt pas op Betaald klikken nadat je de aanvraag hebt geaccepteerd.");
            return;
          }

          const modal = new ModalBuilder()
            .setCustomId(`modal_paid_agreement:${ticketChannel.id}`)
            .setTitle("Betaling afronden");

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

        if (ticketMissingDataId) {
          if (!state.approved) {
            await replyTemp(interaction, "❌ Gebruik Ontbrekende gegevens pas nadat je de aanvraag hebt geaccepteerd.");
            return;
          }

          await interaction.reply({
            content: `📋 Selecteer hieronder welke gegevens ontbreken:`,
            components: [missingFieldsSelectRow(ticketChannel.id)],
            flags: MessageFlags.Ephemeral,
          }).catch(() => {});

          setTimeout(() => interaction.deleteReply().catch(() => {}), 8000);
          return;
        }

        if (copyTicketId && copyField) {
          const values = state.missingValues;
          if (!values) {
            await replyTemp(interaction, "❌ Geen gegevens om te kopiëren (nog niet ingevuld of al gewist).");
            return;
          }

          const value = (values[copyField] || "").toString().trim();
          if (!value) {
            await replyTemp(interaction, "❌ Dit veld heeft geen waarde.");
            return;
          }

          await replyTemp(interaction, `\`\`\`\n${safeForCodeBlock(value)}\n\`\`\``, 15000);
          return;
        }

        if (adminWipeId) {
          await clearMissingDataMessages(ticketChannel);
          await upsertAdminControlPanelByState(ticketChannel.id);

          await replyTemp(interaction, "🗑 Aanvullende gegevens zijn gewist.");
          await sendTemp(ticketChannel, "🗑 **Aanvullende gegevens zijn door admin gewist (privacy).**", 10000).catch(() => {});
          return;
        }
      }
    }

    // -------------------------
    // SELECT MENU (admin via DM)
    // -------------------------
    if (interaction.isStringSelectMenu()) {
      const ticketChannelId = extractTicketId(interaction.customId, "select_missing_fields");
      if (!ticketChannelId) return;

      const state = ticketState.get(ticketChannelId);
      if (!state) {
        await replyTemp(interaction, "❌ Ticket niet gevonden.");
        return;
      }

      if (interaction.user.id !== state.adminUserId) {
        await replyTemp(interaction, "❌ Alleen de ticketadmin kan dit doen.");
        return;
      }

      if (state.closed) {
        await replyTemp(interaction, `ℹ️ Dit ticket is al afgesloten met status: ${getStatusLabel(state)}.`);
        return;
      }

      const ticketChannel = await getTicketChannelById(ticketChannelId);
      if (!ticketChannel || ticketChannel.type !== ChannelType.GuildText) {
        await replyTemp(interaction, "❌ Ticketkanaal niet gevonden.");
        return;
      }

      const selected = interaction.values;

      ticketState.set(ticketChannel.id, {
        ...state,
        missingFields: selected,
        status: "Wachten op aanvullende gegevens",
        ticketName: ticketChannel.name,
      });

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

      await ticketChannel.send({ content: requestText, components: [buildMemberFillRowActive()] });
      await upsertAdminControlPanelByState(ticketChannel.id);
      await replyTemp(interaction, "✅ Verzoek geplaatst in het ticket.");
      return;
    }

    // -------------------------
    // MODALS
    // -------------------------
    if (interaction.isModalSubmit()) {
      // Afkeuren via admin DM
      const rejectTicketId = extractTicketId(interaction.customId, "modal_reject_reason");
      if (rejectTicketId) {
        const state = ticketState.get(rejectTicketId);
        if (!state) {
          await replyTemp(interaction, "❌ Ticket niet gevonden.");
          return;
        }

        if (interaction.user.id !== state.adminUserId) {
          await replyTemp(interaction, "❌ Alleen de ticketadmin kan dit doen.");
          return;
        }

        if (state.closed) {
          await replyTemp(interaction, `ℹ️ Dit ticket is al afgesloten met status: ${getStatusLabel(state)}.`);
          return;
        }

        const ticketChannel = await getTicketChannelById(rejectTicketId);
        if (!ticketChannel || ticketChannel.type !== ChannelType.GuildText) {
          await replyTemp(interaction, "❌ Ticketkanaal niet gevonden.");
          return;
        }

        const meta = state.meta || parseTicketTopic(ticketChannel.topic);
        if (!meta) {
          await replyTemp(interaction, "❌ Ticketgegevens ongeldig.");
          return;
        }

        const reason = interaction.fields.getTextInputValue("reject_reason");

        await ticketChannel.send([`❌ **Aanvraag afgekeurd**`, `Reden: ${reason}`].join("\n"));

        const user = await client.users.fetch(meta.userId).catch(() => null);
        if (user) {
          const displayName = await getMemberDisplayName(ticketChannel.guild, meta.userId);
          await user
            .send(
              [
                `Beste ${displayName},`,
                ``,
                `Je aanvraag om **${meta.punten} Sebbie** om te wisselen voor **€${meta.euro} cash** is **afgekeurd**.`,
                `Reden: ${reason}`,
                ``,
                `Fijne dag,`,
                `Team StreApp`,
              ].join("\n")
            )
            .catch(() => {});
        }

        await logToChannel(
          ticketChannel.guild,
          [
            `🔴 **Ticket afgekeurd (afgesloten door admin)**`,
            `Lid: <@${meta.userId}>`,
            `Ingewisseld: ${meta.punten} Sebbie (aanvraag)`,
            `Bedrag: €${meta.euro}`,
            `Reden afkeuring: ${reason}`,
            `Tijdstip: ${nowNl()}`,
            `Admin: <@${interaction.user.id}>`,
            `Kanaal: #${ticketChannel.name}`,
          ].join("\n")
        );

        await clearMissingDataMessages(ticketChannel);
        await markTicketClosed(ticketChannel.id, "Afgekeurd", {
          rejectReason: reason,
          ticketName: ticketChannel.name,
          meta,
        });

        await replyTemp(interaction, "✅ Afkeuring verstuurd. Ticket wordt afgesloten.");
        await ticketChannel.delete("Sebbie voor Cash: afgekeurd").catch(() => {});
        return;
      }

      // Betaald via admin DM
      const paidTicketId = extractTicketId(interaction.customId, "modal_paid_agreement");
      if (paidTicketId) {
        const state = ticketState.get(paidTicketId);
        if (!state) {
          await replyTemp(interaction, "❌ Ticket niet gevonden.");
          return;
        }

        if (interaction.user.id !== state.adminUserId) {
          await replyTemp(interaction, "❌ Alleen de ticketadmin kan dit doen.");
          return;
        }

        if (state.closed) {
          await replyTemp(interaction, `ℹ️ Dit ticket is al afgesloten met status: ${getStatusLabel(state)}.`);
          return;
        }

        if (!state.approved) {
          await replyTemp(interaction, "❌ Je kunt pas afronden nadat je de aanvraag hebt geaccepteerd.");
          return;
        }

        const ticketChannel = await getTicketChannelById(paidTicketId);
        if (!ticketChannel || ticketChannel.type !== ChannelType.GuildText) {
          await replyTemp(interaction, "❌ Ticketkanaal niet gevonden.");
          return;
        }

        const meta = state.meta || parseTicketTopic(ticketChannel.topic);
        if (!meta) {
          await replyTemp(interaction, "❌ Ticketgegevens ongeldig.");
          return;
        }

        const agreementNo = (interaction.fields.getTextInputValue("agreement_no") || "").trim();
        if (!agreementNo.startsWith("K") || agreementNo.length < 5) {
          await replyTemp(interaction, "❌ Ongeldig koopovereenkomst nummer. Gebruik bv: K20260401");
          return;
        }

        const user = await client.users.fetch(meta.userId).catch(() => null);
        if (user) {
          const displayName = await getMemberDisplayName(ticketChannel.guild, meta.userId);
          await user
            .send(
              [
                `Beste ${displayName},`,
                ``,
                `Wij hebben jouw aanvraag verwerkt.`,
                `✅ Je hebt **${meta.punten} Sebbie** ingewisseld voor **€${meta.euro} cash**.`,
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
          ticketChannel.guild,
          [
            `💰 **Betaalde aanvraag**`,
            `Lid: <@${meta.userId}>`,
            `Ingewisseld: ${meta.punten} Sebbie`,
            `Bedrag: €${meta.euro}`,
            `Koopovereenkomst: ${agreementNo}`,
            `Tijdstip: ${nowNl()}`,
            `Admin: <@${interaction.user.id}>`,
            `Kanaal: #${ticketChannel.name}`,
          ].join("\n")
        );

        await clearMissingDataMessages(ticketChannel);
        await markTicketClosed(ticketChannel.id, "Betaald", {
          ticketName: ticketChannel.name,
          meta,
        });

        await replyTemp(interaction, "✅ Betaald geregistreerd. Ticket wordt gesloten.");
        await ticketChannel.delete(`Sebbie voor Cash: betaald (${agreementNo})`).catch(() => {});
        return;
      }

      // Annuleren door lid in ticket
      if (interaction.customId === "modal_cancel_reason") {
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

        if (interaction.user.id !== meta.userId) {
          await replyTemp(interaction, "❌ Alleen de aanvrager kan annuleren.");
          return;
        }

        const state = ticketState.get(channel.id) || {};
        if (state.approved) {
          await replyTemp(interaction, "❌ Annuleren is niet meer mogelijk nadat de aanvraag is geaccepteerd.");
          return;
        }

        const reason = interaction.fields.getTextInputValue("cancel_reason");

        ticketState.set(channel.id, {
          ...state,
          cancelReason: reason,
          status: "Geannuleerd door lid",
          ticketName: channel.name,
          meta: state.meta || meta,
        });

        await disableMemberCancelButtonInChannel(channel);

        await channel.send({
          content: [`🟡 **Aanvraag geannuleerd door lid**`, `Reden: ${reason}`].join("\n"),
        });

        await upsertAdminControlPanelByState(channel.id);
        await replyTemp(interaction, "✅ Annulering doorgegeven. Admin kan nu afsluiten.");
        return;
      }

      // Aanvullende gegevens door lid in ticket
      if (interaction.customId === "modal_member_missing_data") {
        const channel = interaction.channel;
        if (!channel || channel.type !== ChannelType.GuildText) {
          await replyTemp(interaction, "❌ Alleen de aanvrager kan dit in het hoofd-ticket invullen.");
          return;
        }

        const meta = parseTicketTopic(channel.topic);
        if (!meta) {
          await replyTemp(interaction, "❌ Dit kanaal lijkt geen Sebbie-ticket te zijn.");
          return;
        }

        if (interaction.user.id !== meta.userId) {
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

        await deleteMemberMissingNotice(channel);

        const ticketNotice = await channel.send([
          `📨 **Aanvullende gegevens ontvangen**`,
          ``,
          `✅ Dankjewel! We gaan hiermee verder in de administratie.`,
        ].join("\n"));

        await disableMemberFillButtonInChannel(channel);

        const dm = await getAdminDmChannel(state.adminUserId);
        let adminDetailMessageId;

        if (dm) {
          const human = fieldsToHumanList(fields);
          const lines = [
            `📨 **Aanvullende gegevens ontvangen**`,
            `Kanaal: **#${channel.name}**`,
            `Gevraagd: **${human.join(", ")}**`,
            ``,
            ...(values.firstName ? [`**Voornaam:** ${values.firstName}`] : []),
            ...(values.lastName ? [`**Achternaam:** ${values.lastName}`] : []),
            ...(values.city ? [`**Woonplaats:** ${values.city}`] : []),
            ...(values.iban ? [`**Rekeningnummer:** ${values.iban}`] : []),
            ``,
            `⚠️ Wis deze gegevens zodra ze zijn overgenomen (privacy).`,
          ].join("\n");

          const components = [];
          const copyRow = buildCopyButtonsRow(channel.id, values);
          if (copyRow) components.push(copyRow);
          components.push(adminWipeDataRow(channel.id));

          const dmMsg = await dm.send({ content: lines, components }).catch(() => null);
          if (dmMsg) adminDetailMessageId = dmMsg.id;
        }

        ticketState.set(channel.id, {
          ...state,
          status: "Wachten op aanvullende gegevens",
          missingValues: values,
          missingDataAdminMessageId: adminDetailMessageId,
          missingDataTicketNoticeMessageId: ticketNotice.id,
          ticketName: channel.name,
          meta: state.meta || meta,
        });

        await upsertAdminControlPanelByState(channel.id);
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