const { Events, ChannelType, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, ModalBuilder, TextInputBuilder, TextInputStyle } = require('discord.js');
const { isModerator, MODERATOR_ROLES } = require('../utils/helpers');

const { TICKET_CATEGORY_ID, PING_ROLE_IDS } = process.env;
const PING_ROLES = PING_ROLE_IDS ? PING_ROLE_IDS.split(",") : [];

module.exports = {
    name: Events.InteractionCreate,
    async execute(interaction) {
        /* ===== SLASH COMMANDS ===== */
        if (interaction.isChatInputCommand()) {
            const command = interaction.client.commands.get(interaction.commandName);

            if (!command) {
                console.error(`No command matching ${interaction.commandName} was found.`);
                return;
            }

            try {
                await command.execute(interaction);
            } catch (error) {
                console.error(error);
                if (interaction.replied || interaction.deferred) {
                    await interaction.followUp({ content: 'There was an error while executing this command!', ephemeral: true });
                } else {
                    await interaction.reply({ content: 'There was an error while executing this command!', ephemeral: true });
                }
            }
        }

        /* ===== BUTTONS ===== */
        else if (interaction.isButton()) {

            /* CREATE TICKET INITIAL (SHOW MODAL) */
            if (interaction.customId === "create_ticket") {

                // Check if ticket exists
                const guild = interaction.guild;
                const user = interaction.user;
                const existing = guild.channels.cache.find(c => c.name === `ticket-${user.id}`);
                if (existing) {
                    return interaction.reply({ content: "❌ У вас уже есть тикет", ephemeral: true });
                }

                // Show Modal
                const modal = new ModalBuilder()
                    .setCustomId('ticket_modal')
                    .setTitle('Создание тикета');

                const usernameInput = new TextInputBuilder()
                    .setCustomId('ticket_username')
                    .setLabel("Ваш логин")
                    .setStyle(TextInputStyle.Short)
                    .setPlaceholder("Пример: TroxillUser")
                    .setRequired(true);

                const versionInput = new TextInputBuilder()
                    .setCustomId('ticket_version')
                    .setLabel("Ваша версия (1.21.1/1.21.4)")
                    .setStyle(TextInputStyle.Short)
                    .setPlaceholder("1.16.5")
                    .setRequired(true);

                const launcherInput = new TextInputBuilder()
                    .setCustomId('ticket_launcher')
                    .setLabel("Лаунчер")
                    .setStyle(TextInputStyle.Short)
                    .setPlaceholder("TLauncher, Legacy, etc.")
                    .setRequired(true);

                const javaInput = new TextInputBuilder()
                    .setCustomId('ticket_java')
                    .setLabel("Ваша версия джавы")
                    .setStyle(TextInputStyle.Short)
                    .setPlaceholder("Java 21...")
                    .setRequired(true);

                const avInput = new TextInputBuilder()
                    .setCustomId('ticket_av')
                    .setLabel("Антивирусы есть?")
                    .setStyle(TextInputStyle.Short)
                    .setPlaceholder("Нет / Kaspersky / DrWeb")
                    .setRequired(true);

                modal.addComponents(
                    new ActionRowBuilder().addComponents(usernameInput),
                    new ActionRowBuilder().addComponents(versionInput),
                    new ActionRowBuilder().addComponents(launcherInput),
                    new ActionRowBuilder().addComponents(javaInput),
                    new ActionRowBuilder().addComponents(avInput)
                );

                await interaction.showModal(modal);
            }

            /* TAKE TICKET */
            else if (interaction.customId === "take_ticket") {
                await interaction.deferReply({ ephemeral: true });

                if (!isModerator(interaction.member))
                    return interaction.editReply("❌ Только модератор");

                const channel = interaction.channel;

                // Lock button
                try {
                    await interaction.message.edit({ components: [] });
                } catch { }

                // Check topic
                if (channel.topic && channel.topic.startsWith("TAKEN_BY:")) {
                    const takenById = channel.topic.split(":")[1];
                    return interaction.editReply(
                        takenById === interaction.user.id
                            ? "⚠️ Вы уже взяли этот тикет"
                            : "❌ Этот тикет уже взял другой модератор"
                    );
                }

                // Set topic
                await channel.setTopic(`TAKEN_BY:${interaction.user.id}`);

                // Update permissions
                await channel.permissionOverwrites.edit(interaction.user.id, {
                    SendMessages: true,
                    ViewChannel: true
                });

                await channel.send(`🟢 **Тикет взял ${interaction.user.tag}**`);
                return interaction.editReply("✅ Вы взяли тикет");
            }

            /* FEEDBACK RATING */
            else if (interaction.customId.startsWith("rate_")) {
                const rating = interaction.customId.split("_")[1];

                await interaction.update({
                    content: `✅ Спасибо за оценку: ${rating} ⭐`,
                    components: [],
                    embeds: []
                });

                // Log rating
                try {
                    // Try to find the guild where the bot is (this is a DM interaction, so interaction.guild might be null)
                    // We need a way to send this to the specific guild.
                    // Since this is a simple bot for one guild, let's fetch the guild from env GUILD_ID.
                    const { GUILD_ID, LOG_CHANNEL_ID } = process.env;
                    if (GUILD_ID) {
                        const guild = await interaction.client.guilds.fetch(GUILD_ID);
                        if (guild) {
                            const logChannel = guild.channels.cache.get(LOG_CHANNEL_ID) ||
                                guild.channels.cache.find(c => c.name === "ticket-logs");

                            if (logChannel) {
                                const embed = new EmbedBuilder()
                                    .setTitle("⭐ Новая оценка")
                                    .setDescription(`Пользователь ${interaction.user} поставил **${rating} / 5**`)
                                    .setColor(0xf1c40f) // Yellow
                                    .setTimestamp();
                                await logChannel.send({ embeds: [embed] });
                            }
                        }
                    }
                } catch (e) {
                    console.error("Failed to log rating:", e);
                }
            }
        }

        /* ===== MODALS ===== */
        else if (interaction.isModalSubmit()) {
            if (interaction.customId === 'ticket_modal') {
                await interaction.deferReply({ ephemeral: true });

                const username = interaction.fields.getTextInputValue('ticket_username');
                const version = interaction.fields.getTextInputValue('ticket_version');
                const launcher = interaction.fields.getTextInputValue('ticket_launcher');
                const java = interaction.fields.getTextInputValue('ticket_java');
                const av = interaction.fields.getTextInputValue('ticket_av');

                const user = interaction.user;
                const guild = interaction.guild;

                // Double check existence (just in case)
                const existing = guild.channels.cache.find(c => c.name === `ticket-${user.id}`);
                if (existing) {
                    return interaction.editReply("❌ У вас уже есть тикет");
                }

                try {
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
                        .setTitle("🎫 Новый тикет")
                        .setColor(0x2ecc71)
                        .addFields(
                            { name: "Пользователь", value: `${user} (${user.tag})`, inline: true },
                            { name: "Никнейм", value: username, inline: true },
                            { name: "Версия игры", value: version, inline: true },
                            { name: "Лаунчер", value: launcher, inline: true },
                            { name: "Java", value: java, inline: true },
                            { name: "Антивирус", value: av, inline: true }
                        )
                        .setFooter({ text: "Ожидайте ответа модератора" });

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

                    await interaction.editReply({ content: `✅ Тикет создан: ${channel}` });

                } catch (error) {
                    console.error(error);
                    await interaction.editReply({ content: "❌ Ошибка при создании тикета. Проверьте права бота." });
                }
            }
        }
    },
};
