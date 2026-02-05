const { SlashCommandBuilder, EmbedBuilder, PermissionFlagsBits } = require('discord.js');
const { getStatuses, updateStatus, setStatusMessage, getStatusMessage } = require('../utils/statusManager');

const STATUS_COLORS = {
    "Undetected": 0x2ecc71, // Green
    "Detected": 0xe74c3c,   // Red
    "Maintenance": 0xf1c40f,// Yellow
    "Testing": 0x3498db,    // Blue
    "Online": 0x2ecc71,
    "Offline": 0xe74c3c
};

const STATUS_EMOJIS = {
    "Undetected": "🟢",
    "Detected": "🔴",
    "Maintenance": "🟡",
    "Testing": "🔵",
    "Online": "🟢",
    "Offline": "🔴"
};

function generateEmbed(statuses) {
    const embed = new EmbedBuilder()
        .setTitle("📊 System Status")
        .setDescription("Актуальный статус продуктов Troxill.\nАвтоматическое обновление.")
        .setColor(0x2b2d31)
        .setTimestamp()
        .setFooter({ text: "Last Updated" });

    for (const [product, status] of Object.entries(statuses)) {
        const emoji = STATUS_EMOJIS[status] || "⚪";
        // Use a code block or bold for better visibility
        embed.addFields({ name: product, value: `${emoji} **${status}**`, inline: true });
    }

    return embed;
}

module.exports = {
    data: new SlashCommandBuilder()
        .setName('status')
        .setDescription('Управление статус-панелью')
        .addSubcommand(subcommand =>
            subcommand
                .setName('panel')
                .setDescription('Создать или обновить сообщение со статусами')
        )
        .addSubcommand(subcommand =>
            subcommand
                .setName('update')
                .setDescription('Обновить статус продукта')
                .addStringOption(option =>
                    option.setName('product')
                        .setDescription('Продукт')
                        .setRequired(true)
                        .addChoices(
                            { name: 'Troxill Private', value: 'Troxill Private' },
                            { name: 'Troxill Spoofer', value: 'Troxill Spoofer' },
                            { name: 'Shop', value: 'Shop' }
                        )
                )
                .addStringOption(option =>
                    option.setName('status')
                        .setDescription('Новый статус')
                        .setRequired(true)
                        .addChoices(
                            { name: 'Undetected', value: 'Undetected' },
                            { name: 'Detected', value: 'Detected' },
                            { name: 'Maintenance', value: 'Maintenance' },
                            { name: 'Testing', value: 'Testing' },
                            { name: 'Online', value: 'Online' },
                            { name: 'Offline', value: 'Offline' }
                        )
                )
        ),
    async execute(interaction) {
        // MANUAL PERMISSION CHECK
        if (interaction.user.id !== '1259720749820940348' && !interaction.member.permissions.has(PermissionFlagsBits.Administrator)) {
            return interaction.reply({ content: '❌ У вас нет прав для использования этой команды.', ephemeral: true });
        }

        const subcommand = interaction.options.getSubcommand();

        if (subcommand === 'panel') {
            await interaction.deferReply({ ephemeral: true });

            const statuses = getStatuses();
            const embed = generateEmbed(statuses);

            // Send new panel
            const message = await interaction.channel.send({ embeds: [embed] });
            setStatusMessage(interaction.channel.id, message.id);

            return interaction.editReply("✅ Панель статусов создана. Она будет обновляться автоматически при использовании команды /status update");
        }

        if (subcommand === 'update') {
            await interaction.deferReply({ ephemeral: true });

            const product = interaction.options.getString('product');
            const status = interaction.options.getString('status');

            const newStatuses = updateStatus(product, status);

            // Update the live message
            const config = getStatusMessage();
            if (config) {
                try {
                    const channel = await interaction.client.channels.fetch(config.channelId);
                    if (channel) {
                        const message = await channel.messages.fetch(config.messageId);
                        if (message) {
                            await message.edit({ embeds: [generateEmbed(newStatuses)] });
                        }
                    }
                } catch (e) {
                    console.error("Failed to update status message:", e.message);
                    return interaction.editReply(`✅ Статус в базе обновлен (${product}: ${status}), но само сообщение не найдено. Создайте новую панель через \`/status panel\`.`);
                }
            } else {
                return interaction.editReply(`✅ Статус в базе обновлен (${product}: ${status}). Не забудьте создать панель через \`/status panel\`, чтобы пользователи видели это.`);
            }

            return interaction.editReply(`✅ Статус **${product}** изменен на **${status}**. Панель обновлена.`);
        }
    }
};
