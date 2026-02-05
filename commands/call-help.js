const { SlashCommandBuilder } = require("discord.js");
const { isModerator, MODERATOR_ROLES } = require("../utils/helpers");

module.exports = {
    data: new SlashCommandBuilder()
        .setName("call-help")
        .setDescription("Вызвать помощь модераторов"),
    async execute(interaction) {
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
};
