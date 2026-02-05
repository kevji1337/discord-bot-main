const { SlashCommandBuilder, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require("discord.js");
const { isModerator, collectMessages } = require("../utils/helpers");
const discordTranscripts = require('discord-html-transcripts');
const { GOOGLE_DRIVE_WEBAPP_URL, LOG_CHANNEL_ID } = process.env;

module.exports = {
    data: new SlashCommandBuilder()
        .setName("close-ticket")
        .setDescription("Закрыть тикет"),
    async execute(interaction) {
        await interaction.deferReply({ ephemeral: true });

        if (!isModerator(interaction.member))
            return interaction.editReply("❌ Нет прав");

        const channel = interaction.channel;
        if (!channel.name.startsWith("ticket-"))
            return interaction.editReply("❌ Это не тикет");

        // 1. Generate Transcript
        const attachment = await discordTranscripts.createTranscript(channel, {
            limit: -1,
            returnType: 'attachment',
            filename: `${channel.name}.html`,
            saveImages: true,
            footerText: "Exported by Troxill Bot",
            poweredBy: false
        });

        // 2. Log to Discord Channel
        const logChannel = interaction.guild.channels.cache.get(LOG_CHANNEL_ID) ||
            interaction.guild.channels.cache.find(c => c.name === "ticket-logs");

        if (logChannel) {
            const logEmbed = new EmbedBuilder()
                .setTitle("📝 Тикет закрыт")
                .addFields(
                    { name: "Тикет", value: channel.name, inline: true },
                    { name: "Закрыл", value: interaction.user.tag, inline: true },
                    { name: "Автор", value: `<@${channel.name.replace("ticket-", "")}>`, inline: true }
                )
                .setColor(0xe74c3c)
                .setTimestamp();

            await logChannel.send({ embeds: [logEmbed], files: [attachment] });
        } else {
            console.error("❌ Log channel not found (set LOG_CHANNEL_ID or create #ticket-logs)");
        }

        // 3. Google Drive (Legacy/Backup)
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
            const timeout = setTimeout(() => controller.abort(), 15000);

            fetch(GOOGLE_DRIVE_WEBAPP_URL, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify(payload),
                signal: controller.signal
            }).catch(e => console.error("GDrive Error:", e.message)); // Non-blocking

            clearTimeout(timeout);
        } catch (err) { }

        // 4. Feedback Request (DM)
        const userId = channel.name.replace("ticket-", "");
        try {
            const user = await interaction.guild.members.fetch(userId);
            if (user) {
                const feedbackEmbed = new EmbedBuilder()
                    .setTitle("⭐ Оцените качество поддержки")
                    .setDescription("Ваш тикет был закрыт. Пожалуйста, оцените работу модератора.")
                    .setColor(0xf1c40f);

                const row = new ActionRowBuilder().addComponents(
                    new ButtonBuilder().setCustomId('rate_1').setLabel('1').setStyle(ButtonStyle.Danger),
                    new ButtonBuilder().setCustomId('rate_2').setLabel('2').setStyle(ButtonStyle.Secondary),
                    new ButtonBuilder().setCustomId('rate_3').setLabel('3').setStyle(ButtonStyle.Primary),
                    new ButtonBuilder().setCustomId('rate_4').setLabel('4').setStyle(ButtonStyle.Success),
                    new ButtonBuilder().setCustomId('rate_5').setLabel('5').setStyle(ButtonStyle.Success)
                );

                await user.send({ embeds: [feedbackEmbed], components: [row] }).catch(() => { });
            }
        } catch (e) {
            console.log("Could not DM user for feedback");
        }

        await interaction.editReply("✅ Тикет закрыт, лог сохранен, отзыв запрошен.");
        setTimeout(() => channel.delete().catch(() => { }), 5000);
    }
};
