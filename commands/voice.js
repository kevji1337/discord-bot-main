const { SlashCommandBuilder, ChannelType, PermissionFlagsBits } = require('discord.js');
const { isModerator, MODERATOR_ROLES } = require('../utils/helpers');
const { TICKET_CATEGORY_ID } = process.env;

function uniqSnowflakes(ids) {
    return [...new Set((ids || []).map(s => String(s).trim()).filter(Boolean).filter(s => /^\d+$/.test(s)))];
}

module.exports = {
    data: new SlashCommandBuilder()
        .setName('voice')
        .setDescription('Создать или управлять голосовым каналом тикета'),
    async execute(interaction) {
        if (!interaction.channel.name.startsWith('ticket-')) {
            return interaction.reply({ content: "❌ Эту команду можно использовать только в тикетах.", ephemeral: true });
        }

        const ticketOwnerId = interaction.channel.name.replace("ticket-", "");

        // Manual Mod Check (or logic to allow user?) - Defaulting to Mod/Admin or Ticket Owner
        // If we want ONLY mods to create it via command? No, let's allow participant.
        const isOwner = interaction.user.id === ticketOwnerId;
        const isMod = isModerator(interaction.member);

        if (!isOwner && !isMod) {
            return interaction.reply({ content: "❌ Нет прав доступа.", ephemeral: true });
        }

        // Check if voice exists in topic
        if (interaction.channel.topic && interaction.channel.topic.includes("VOICE:")) {
            return interaction.reply({ content: "⚠️ Голосовой канал для этого тикета уже создан.", ephemeral: true });
        }

        await interaction.deferReply();

        try {
            const botId = interaction.guild.members.me?.id || interaction.client.user.id;
            const modRoleIds = uniqSnowflakes(MODERATOR_ROLES).filter(id => id !== interaction.guild.id);
            const voice = await interaction.guild.channels.create({
                name: `Voice-${ticketOwnerId}`,
                type: ChannelType.GuildVoice,
                parent: TICKET_CATEGORY_ID,
                permissionOverwrites: [
                    { id: interaction.guild.id, deny: [PermissionFlagsBits.ViewChannel] },
                    { id: botId, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.Connect, PermissionFlagsBits.Speak, PermissionFlagsBits.ManageChannels] },
                    { id: ticketOwnerId, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.Connect, PermissionFlagsBits.Speak] },
                    ...modRoleIds.map(id => ({ id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.Connect, PermissionFlagsBits.Speak] }))
                ]
            });

            // Save Voice ID
            let currentTopic = interaction.channel.topic || "";
            await interaction.channel.setTopic(`${currentTopic} | VOICE:${voice.id}`);

            await interaction.editReply(`✅ Голосовой канал создан: ${voice}`);
        } catch (e) {
            console.error(e);
            await interaction.editReply("❌ Ошибка создания канала.");
        }
    }
};
