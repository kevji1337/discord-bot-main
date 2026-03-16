const {SlashCommandBuilder, EmbedBuilder, PermissionFlagsBits, MessageFlags} = require('discord.js');
const {getStaffStats} = require('../utils/db');
const {isCurator, isAdmin} = require('../utils/helpers');

module.exports = {
    data: new SlashCommandBuilder()
        .setName('staff-stats')
        .setDescription('Статистика работы модераторов')
        .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),
    async execute(interaction) {
        if (!interaction.member.permissions.has(PermissionFlagsBits.Administrator) && !isCurator(interaction.member) && !isAdmin(interaction.member)) {
            return interaction.reply({content: '❌ Нет прав.', flags: MessageFlags.Ephemeral});
        }

        const stats = getStaffStats();
        const embed = new EmbedBuilder()
            .setTitle("📊 Staff Leaderboard")
            .setColor(0x3498db)
            .setTimestamp();

        let description = "";

        // Sort by tickets closed
        const sorted = Object.entries(stats).sort(([, a], [, b]) => b.ticketsClosed - a.ticketsClosed);

        for (const [userId, data] of sorted) {
            const avgRating = data.ratingCount > 0 ? (data.totalRating / data.ratingCount).toFixed(2) : "N/A";
            description += `<@${userId}>\n👮 **Тикетов:** ${data.ticketsClosed} | ⭐ **Рейтинг:** ${avgRating} (${data.ratingCount})\n\n`;
        }

        if (!description) description = "Нет данных.";

        embed.setDescription(description);
        return interaction.reply({embeds: [embed], flags: MessageFlags.Ephemeral});
    }
};
