const { SlashCommandBuilder, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, MessageFlags } = require("discord.js");
const {isModerator, isCurator, isAdmin} = require("../utils/helpers");

const TICKET_PANEL_OWNER_ID = String(process.env.TICKET_PANEL_OWNER_ID ?? '').trim();

module.exports = {
    data: new SlashCommandBuilder()
        .setName("ticket-panel")
        .setDescription("Создать панель тикетов"),
    async execute(interaction) {
        if (interaction.user.id !== TICKET_PANEL_OWNER_ID && !isModerator(interaction.member) && !isCurator(interaction.member) && !isAdmin(interaction.member))
            return interaction.reply({ content: "❌ Только для модераторов", flags: MessageFlags.Ephemeral }); // Changed to reply since we haven't deferred yet in execute usually, or use deferReply first.

        await interaction.deferReply({ flags: MessageFlags.Ephemeral });

        const embed = new EmbedBuilder()
            .setTitle("🎫 Troxill Support")
            .setDescription("Нажмите кнопку ниже, чтобы создать тикет.\nВам потребуется указать:\n- Никнейм\n- Причину обращения")
            .setColor(0x2ecc71)
            .setFooter({ text: "Troxill Support System" });

        const row = new ActionRowBuilder().addComponents(
            new ButtonBuilder()
                .setCustomId("create_ticket")
                .setLabel("Создать тикет") // Translated "Create ticket" to Russian as per persona context
                .setEmoji("📩")
                .setStyle(ButtonStyle.Primary)
        );

        await interaction.channel.send({ embeds: [embed], components: [row] });
        return interaction.editReply("✅ Панель отправлена");
    }
};
