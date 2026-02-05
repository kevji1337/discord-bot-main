const { SlashCommandBuilder } = require("discord.js");
const { isModerator, collectMessages } = require("../utils/helpers");
const { GOOGLE_DRIVE_WEBAPP_URL } = process.env;

module.exports = {
    data: new SlashCommandBuilder()
        .setName("close-ticket")
        .setDescription("Закрыть тикет"),
    async execute(interaction) {
        await interaction.deferReply({ ephemeral: true });

        if (!isModerator(interaction.member))
            return interaction.editReply("❌ Нет прав");

        const channel = interaction.channel;
        // Check if it's a ticket channel (starts with ticket-)
        if (!channel.name.startsWith("ticket-"))
            return interaction.editReply("❌ Это не тикет");

        const log = await collectMessages(channel);

        const payload = {
            action: "close_ticket",
            ticketChannel: channel.name,
            ticketId: channel.id,
            closedBy: interaction.user.tag,
            closedById: interaction.user.id,
            createdById: channel.name.replace("ticket-", ""), // Extracts ID roughly
            guildId: interaction.guild.id,
            logContent: log
        };

        // Send to Google Drive
        try {
            const controller = new AbortController();
            const timeout = setTimeout(() => controller.abort(), 15000);

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
                content: "📁 Лог сохранён, тикет закрывается...", // In future: add Discord logging here
                ephemeral: true
            });
        } catch { }

        setTimeout(() => channel.delete().catch(() => { }), 3000);
    }
};
