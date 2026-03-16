const { SlashCommandBuilder, MessageFlags } = require("discord.js");
const {
    isModerator,
    isCurator,
    isAdmin,
    getSafeModeratorRoleIds,
    getSafePingRoleIds,
    isInTicketCategory,
    buildTicketTopic,
    getTicketChannelState,
    editOverwriteSafe
} = require("../utils/helpers");

const helpCooldown = new Map();

function hitCooldown(key, ms) {
    const now = Date.now();
    const last = helpCooldown.get(key) || 0;
    if (now - last < ms) return true;
    helpCooldown.set(key, now);
    return false;
}

module.exports = {
    data: new SlashCommandBuilder()
        .setName("call-help")
        .setDescription("Вызвать помощь модераторов"),
    async execute(interaction) {
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });

        if (!isModerator(interaction.member) && !isCurator(interaction.member) && !isAdmin(interaction.member))
            return interaction.editReply("❌ Нет прав");

        const channel = interaction.channel;
        if (!channel.name.startsWith("ticket-"))
            return interaction.editReply("❌ Это не тикет");
        if (!isInTicketCategory(channel))
            return interaction.editReply("❌ Этот канал не находится в категории тикетов.");

        const ticket = getTicketChannelState(channel);
        if (!ticket?.ownerId)
            return interaction.editReply("❌ Для этого тикета не найдены метаданные.");
        if ((ticket.category === 'moderator' || ticket.category === 'media') && !isCurator(interaction.member))
            return interaction.editReply("❌ Для этого типа тикета помощь модераторов не используется.");
        if (!ticket.takenById)
            return interaction.editReply("❌ Сначала возьмите тикет.");
        if (interaction.user.id !== ticket.takenById && !isAdmin(interaction.member) && !isCurator(interaction.member))
            return interaction.editReply("❌ Помощь может вызвать только модератор, который взял тикет.");
        if (ticket.helpOpen)
            return interaction.editReply("⚠️ Помощь уже вызвана для этого тикета.");
        if (hitCooldown(channel.id, 30_000))
            return interaction.editReply("⏳ Нельзя вызывать помощь чаще, чем раз в 30 секунд.");

        const modRoleIds = getSafeModeratorRoleIds(interaction.guild);
        for (const roleId of modRoleIds) {
            await editOverwriteSafe(channel, interaction.guild, roleId, {
                SendMessages: true,
                ViewChannel: true
            });
        }
        await channel.setTopic(buildTicketTopic({
            ...ticket,
            helpOpen: true
        })).catch(() => {
        });

        const pingRoleIds = getSafePingRoleIds(interaction.guild);
        const pings = pingRoleIds.map(id => `<@&${id}>`).join(" ");

        await channel.send({
            content: `🚨 **Вызвана помощь модераторов** ${pings}`,
            allowedMentions: {parse: [], roles: pingRoleIds, users: []}
        });
        return interaction.editReply("✅ Помощь вызвана");
    }
};
