require("dotenv").config();
const {
  Client,
  GatewayIntentBits,
  Partials,
  SlashCommandBuilder,
  Routes,
  REST,
  PermissionFlagsBits,
  ChannelType,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder
} = require("discord.js");

/* ===== ENV ===== */
const {
  DISCORD_TOKEN,
  CLIENT_ID,
  GUILD_ID,
  TICKET_CATEGORY_ID,
  GOOGLE_DRIVE_WEBAPP_URL,
  MODERATOR_ROLE_IDS,
  PING_ROLE_IDS
} = process.env;

if (
  !DISCORD_TOKEN ||
  !CLIENT_ID ||
  !GUILD_ID ||
  !TICKET_CATEGORY_ID ||
  !MODERATOR_ROLE_IDS ||
  !GOOGLE_DRIVE_WEBAPP_URL
) {
  console.error("❌ ENV variables missing");
  process.exit(1);
}

const MODERATOR_ROLES = MODERATOR_ROLE_IDS.split(",");
const PING_ROLES = PING_ROLE_IDS ? PING_ROLE_IDS.split(",") : [];

/* ===== CLIENT ===== */
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent
  ],
  partials: [Partials.Channel]
});

/* ===== COMMANDS ===== */
const commands = [
  new SlashCommandBuilder()
    .setName("ticket-panel")
    .setDescription("Создать панель тикетов")
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),

  new SlashCommandBuilder()
    .setName("close-ticket")
    .setDescription("Закрыть тикет"),

  new SlashCommandBuilder()
    .setName("call-help")
    .setDescription("Вызвать помощь модераторов"),

  new SlashCommandBuilder()
    .setName("java")
    .setDescription("Java для использования Troxill Product")
].map(c => c.toJSON());

const rest = new REST({ version: "10" }).setToken(DISCORD_TOKEN);

/* ===== REGISTER ===== */
(async () => {
  await rest.put(
    Routes.applicationGuildCommands(CLIENT_ID, GUILD_ID),
    { body: commands }
  );
  console.log("✅ Slash-команды зарегистрированы");
})();

/* ===== READY ===== */
client.once("ready", () => {
  console.log(`🤖 Бот запущен как ${client.user.tag}`);
});

/* ===== HELPERS ===== */
function isModerator(member) {
  return member.roles.cache.some(r => MODERATOR_ROLES.includes(r.id));
}

async function collectMessages(channel) {
  let messages = [];
  let lastId;

  while (true) {
    const fetched = await channel.messages.fetch({ limit: 100, before: lastId });
    if (!fetched.size) break;

    fetched.forEach(m => {
      messages.push(
        `[${m.createdAt.toLocaleString()}] ${m.author.tag}: ${m.content}`
      );
    });

    lastId = fetched.last().id;
  }

  return messages.reverse().join("\n");
}

/* ===== INTERACTIONS ===== */
client.on("interactionCreate", async interaction => {

  /* ===== SLASH ===== */
  if (interaction.isChatInputCommand()) {

    /* PANEL */
    if (interaction.commandName === "ticket-panel") {
      await interaction.deferReply({ ephemeral: true });

      if (!isModerator(interaction.member))
        return interaction.editReply("❌ Только для модераторов");

      const embed = new EmbedBuilder()
        .setTitle("🎫 Troxill ticket")
        .setDescription("Нажмите кнопку ниже, чтобы создать тикет")
        .setColor(0x2ecc71);

      const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setCustomId("create_ticket")
          .setLabel("Create ticket")
          .setEmoji("📩")
          .setStyle(ButtonStyle.Primary)
      );

      await interaction.channel.send({ embeds: [embed], components: [row] });
      return interaction.editReply("✅ Панель отправлена");
    }

    /* CLOSE */
    if (interaction.commandName === "close-ticket") {
      await interaction.deferReply({ ephemeral: true });

      if (!isModerator(interaction.member))
        return interaction.editReply("❌ Нет прав");

      const channel = interaction.channel;
      if (!channel.name.startsWith("ticket-"))
        return interaction.editReply("❌ Это не тикет");

      const log = await collectMessages(channel);

      const payload = {
        action: "close_ticket",
        ticketChannel: channel.name,
        ticketId: channel.id,
        closedBy: interaction.user.tag,
        closedById: interaction.user.id,
        createdById: channel.name.replace("ticket-", ""),
        guildId: interaction.guild.id,
        logContent: log
      };

try {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15000); // 15 сек

  const res = await fetch(GOOGLE_DRIVE_WEBAPP_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
    signal: controller.signal
  });

  clearTimeout(timeout);

  if (!res.ok) {
    console.error("❌ Google WebApp response error:", res.status);
  }

} catch (err) {
  console.error("❌ Google WebApp fetch failed:", err.message);
}


     try {
  await interaction.followUp({
    content: "📁 Лог сохранён, тикет закрывается...",
    ephemeral: true
  });
} catch {}

setTimeout(() => channel.delete().catch(() => {}), 3000);
}

    /* CALL HELP */
    if (interaction.commandName === "call-help") {
      await interaction.deferReply({ ephemeral: true });

      if (!isModerator(interaction.member))
        return interaction.editReply("❌ Нет прав");

      const channel = interaction.channel;
      if (!channel.name.startsWith("ticket-"))
        return interaction.editReply("❌ Это не тикет");

      for (const roleId of MODERATOR_ROLES) {
        await channel.permissionOverwrites.edit(roleId, {
          SendMessages: true,
          ViewChannel: true
        });
      }

      await channel.send("🚨 **Вызвана помощь модераторов**");
      return interaction.editReply("✅ Помощь вызвана");
    }

    /* JAVA */
if (interaction.commandName === "java") {
  return interaction.reply({
    content:
`☕ **Java для использования Troxill Product**

**Java 21 (Для 1.21+)**
https://drive.google.com/file/d/1puv5qNHUZgczztWqmgmgIMdenoWW2cB4/view?usp=sharing`,
    ephemeral: false
  });
}

  }

  /* ===== BUTTONS ===== */
  if (interaction.isButton()) {

    /* CREATE */
    if (interaction.customId === "create_ticket") {
      await interaction.deferReply({ ephemeral: true });

      const guild = interaction.guild;
      const user = interaction.user;

      const existing = guild.channels.cache.find(
        c => c.name === `ticket-${user.id}`
      );
      if (existing)
        return interaction.editReply("❌ У вас уже есть тикет");

      const channel = await guild.channels.create({
        name: `ticket-${user.id}`,
        type: ChannelType.GuildText,
        parent: TICKET_CATEGORY_ID,
        permissionOverwrites: [
          { id: guild.id, deny: ["ViewChannel"] },
          {
            id: user.id,
            allow: ["ViewChannel", "SendMessages", "ReadMessageHistory"]
          },
          ...MODERATOR_ROLES.map(id => ({
            id,
            allow: ["ViewChannel"],
            deny: ["SendMessages"]
          }))
        ]
      });

      const ping = PING_ROLES.map(id => `<@&${id}>`).join(" ");

      const embed = new EmbedBuilder()
        .setTitle("🎫 Тикет создан")
        .setDescription("Опишите вашу проблему. Модератор возьмёт тикет.")
        .setColor(0x2ecc71);

      const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setCustomId("take_ticket")
          .setLabel("Взять тикет")
          .setEmoji("🟢")
          .setStyle(ButtonStyle.Success)
      );

      await channel.send({
        content: ping || null,
        embeds: [embed],
        components: [row]
      });

      return interaction.editReply("✅ Тикет создан");
    }

   /* TAKE */
/* TAKE */
if (interaction.customId === "take_ticket") {
  await interaction.deferReply({ ephemeral: true });

  if (!isModerator(interaction.member))
    return interaction.editReply("❌ Только модератор");

  const channel = interaction.channel;

  // ⛔ мгновенно блокируем кнопку (анти-спам / анти-рейс)
  try {
    await interaction.message.edit({ components: [] });
  } catch {}

  // 🔒 повторная проверка
  if (channel.topic && channel.topic.startsWith("TAKEN_BY:")) {
    const takenById = channel.topic.split(":")[1];
    return interaction.editReply(
      takenById === interaction.user.id
        ? "⚠️ Вы уже взяли этот тикет"
        : "❌ Этот тикет уже взял другой модератор"
    );
  }

  // 🔐 атомарная фиксация
  await channel.setTopic(`TAKEN_BY:${interaction.user.id}`);

  // даём права
  await channel.permissionOverwrites.edit(interaction.user.id, {
    SendMessages: true,
    ViewChannel: true
  });

  await channel.send(`🟢 **Тикет взял ${interaction.user.tag}**`);
  return interaction.editReply("✅ Вы взяли тикет");
    }
  }
});

/* ===== LOGIN ===== */
client.login(DISCORD_TOKEN);
