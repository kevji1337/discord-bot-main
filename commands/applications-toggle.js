const { SlashCommandBuilder, MessageFlags } = require("discord.js");
const { setSetting, getSettings } = require("../utils/db");
const { isCurator, isAdmin } = require("../utils/helpers");

module.exports = {
    data: new SlashCommandBuilder()
        .setName("applications-toggle")
        .setDescription("Переключить статус набора (открыт/закрыт)")
        .addStringOption(option =>
            option.setName("type")
                .setDescription("Тип набора")
                .setRequired(true)
                .addChoices(
                    { name: "Модерация", value: "moderator" },
                    { name: "Медиа/Ютуберы", value: "media" }
                )
        )
        .addStringOption(option =>
            option.setName("status")
                .setDescription("Новый статус")
                .setRequired(true)
                .addChoices(
                    { name: "Открыть", value: "open" },
                    { name: "Закрыть", value: "closed" }
                )
        ),
    async execute(interaction) {
        if (!isCurator(interaction.member) && !isAdmin(interaction.member)) {
            return interaction.reply({ content: "❌ У вас недостаточно прав для этой команды.", flags: MessageFlags.Ephemeral });
        }

        const type = interaction.options.getString("type");
        const status = interaction.options.getString("status");
        const settingKey = `${type}_recruitment`;

        setSetting(settingKey, status);

        const statusText = status === "open" ? "✅ Открыт" : "❌ Закрыт";
        const typeText = type === "moderator" ? "на модерацию" : "на медиа";

        await interaction.reply({ 
            content: `Статус набора **${typeText}** успешно изменен на **${statusText}**.`, 
            flags: MessageFlags.Ephemeral 
        });
    }
};
