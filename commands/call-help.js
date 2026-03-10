const { SlashCommandBuilder } = require("discord.js");
const {getTicketState} = require("../utils/db");
const {
    isModerator,
    isCurator,
    isAdmin,
    getSafeModeratorRoleIds,
    getSafePingRoleIds,
    isInTicketCategory
} = require("../utils/helpers");

module.exports = {
    data: new SlashCommandBuilder()
        .setName("call-help")
        .setDescription("Вызвать помощь модераторов"),
    async execute(interaction) {
        await interaction.deferReply({ ephemeral: true });

        if (!isModerator(interaction.member) && !isCurator(interaction.member) && !isAdmin(interaction.member))
            return interaction.editReply("❌ Нет прав");

        const channel = interaction.channel;
        if (!channel.name.startsWith("ticket-"))
            return interaction.editReply("❌ Это не тикет");
        if (!isInTicketCategory(channel))
            return interaction.editReply("❌ Этот канал не находится в категории тикетов.");

        const ticket = getTicketState(channel.id);
        if (!ticket?.ownerId)
            return interaction.editReply("❌ Для этого тикета не найдены метаданные.");
        if ((ticket.category === 'moderator' || ticket.category === 'media') && !isCurator(interaction.member))
            return interaction.editReply("❌ Для этого типа тикета помощь модераторов не используется.");
        if (!ticket.takenById)
            return interaction.editReply("❌ Сначала возьмите тикет.");
        if (interaction.user.id !== ticket.takenById && !isAdmin(interaction.member) && !isCurator(interaction.member))
            return interaction.editReply("❌ Помощь может вызвать только модератор, который взял тикет.");

        const modRoleIds = getSafeModeratorRoleIds(interaction.guild);
        for (const roleId of modRoleIds) {
            await channel.permissionOverwrites.edit(roleId, {
                SendMessages: true,
                ViewChannel: true
            });
        }

        const pingRoleIds = getSafePingRoleIds(interaction.guild);
        const pings = pingRoleIds.map(id => `<@&${id}>`).join(" ");

        await channel.send({
            content: `🚨 **Вызвана помощь модераторов** ${pings}`,
            allowedMentions: {parse: [], roles: pingRoleIds, users: []}
        });
        return interaction.editReply("✅ Помощь вызвана");
    }
};
