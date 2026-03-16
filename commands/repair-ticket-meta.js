const {SlashCommandBuilder, PermissionFlagsBits, ChannelType, MessageFlags} = require('discord.js');
const {
    isCurator,
    isAdmin,
    buildTicketTopic,
    getTicketChannelState
} = require('../utils/helpers');
const {
    getTicketState,
    getTicketsMeta,
    createTicketState,
    updateTicketState,
    setTicketActivity
} = require('../utils/db');

const ALLOWED_TICKET_CATEGORIES = new Set(['tech', 'question', 'moderator', 'media']);

function inferCategoryFromMessage(message) {
    const embedTitles = (message?.embeds ?? [])
        .map(embed => String(embed?.title ?? ''))
        .filter(Boolean)
        .join('\n');

    if (embedTitles.includes('Заявка на Модератора')) return 'moderator';
    if (embedTitles.includes('Заявка на Медиа') || embedTitles.includes('Заявка на Ютубера')) return 'media';
    if (embedTitles.includes('Вопрос')) return 'question';
    if (embedTitles.includes('Техническая проблема')) return 'tech';
    return null;
}

function isSeedMessage(message) {
    if (!message?.embeds?.length) return false;
    return message.embeds.some(embed => {
        const title = String(embed?.title ?? '');
        if (title.includes('Техническая проблема') || title.includes('Вопрос') || title.includes('Заявка на Модератора') || title.includes('Заявка на Медиа') || title.includes('Заявка на Ютубера')) {
            return true;
        }

        return (embed?.fields ?? []).some(field => /пользователь/i.test(String(field?.name ?? '')));
    });
}

async function findTicketSeedMessage(channel, maxBatches = 3) {
    let before;
    for (let batch = 0; batch < maxBatches; batch += 1) {
        const fetched = await channel.messages.fetch({limit: 100, before}).catch(() => null);
        if (!fetched?.size) break;

        for (const message of fetched.values()) {
            if (isSeedMessage(message)) return message;
        }

        before = fetched.last()?.id;
        if (!before) break;
    }

    return null;
}

async function getLatestActivityTimestamp(channel) {
    const latest = await channel.messages.fetch({limit: 1}).catch(() => null);
    const message = latest?.first?.();
    return message?.createdTimestamp || Date.now();
}

module.exports = {
    data: new SlashCommandBuilder()
        .setName('repair-ticket-meta')
        .setDescription('Восстановить metadata для всех тикетов'),
    async execute(interaction) {
        if (!interaction.member.permissions.has(PermissionFlagsBits.Administrator) && !isCurator(interaction.member) && !isAdmin(interaction.member)) {
            return interaction.reply({content: '❌ Нет прав.', flags: MessageFlags.Ephemeral});
        }

        await interaction.deferReply({flags: MessageFlags.Ephemeral});

        const ticketCategoryId = String(process.env.TICKET_CATEGORY_ID ?? '').trim();
        if (!/^\d{17,20}$/.test(ticketCategoryId)) {
            return interaction.editReply('❌ Не настроен TICKET_CATEGORY_ID.');
        }

        const channels = await interaction.guild.channels.fetch().catch(() => null);
        if (!channels) {
            return interaction.editReply('❌ Не удалось получить список каналов.');
        }

        const ticketChannels = [...channels.values()].filter(channel =>
            channel &&
            channel.type === ChannelType.GuildText &&
            String(channel.parentId ?? '') === ticketCategoryId
        );
        const currentMeta = getTicketsMeta();

        let scanned = 0;
        let repaired = 0;
        let unchanged = 0;
        let skipped = 0;
        let failed = 0;
        const notes = [];

        for (const channel of ticketChannels) {
            scanned += 1;
            try {
                const existingState = getTicketState(channel.id);
                const existingMetaTimestamp = currentMeta[channel.id] ?? null;
                const seedMessage = await findTicketSeedMessage(channel);
                const recoveredTicket = getTicketChannelState(channel, {message: seedMessage});
                if (!recoveredTicket?.ownerId) {
                    skipped += 1;
                    if (notes.length < 8) notes.push(`- ${channel}: не удалось определить владельца`);
                    continue;
                }

                const category = recoveredTicket.category || inferCategoryFromMessage(seedMessage) || 'question';
                const normalizedCategory = ALLOWED_TICKET_CATEGORIES.has(category) ? category : 'question';
                const latestActivity = existingState?.lastActive || await getLatestActivityTimestamp(channel);
                const desiredTopic = buildTicketTopic({
                    ownerId: recoveredTicket.ownerId,
                    category: normalizedCategory,
                    takenById: recoveredTicket.takenById,
                    voiceId: recoveredTicket.voiceId,
                    voiceLockId: recoveredTicket.voiceLockId,
                    helpOpen: recoveredTicket.helpOpen
                });

                let touched = false;
                if (String(channel.topic ?? '') !== desiredTopic) {
                    await channel.setTopic(desiredTopic);
                    touched = true;
                }

                if (existingState) {
                    const nextPatch = {
                        ownerId: recoveredTicket.ownerId,
                        category: normalizedCategory,
                        takenById: recoveredTicket.takenById,
                        takenAt: existingState.takenAt ?? (recoveredTicket.takenById ? latestActivity : null),
                        guildId: interaction.guild.id,
                        lastActive: latestActivity
                    };
                    const needsStateUpdate =
                        existingState.ownerId !== nextPatch.ownerId ||
                        existingState.category !== nextPatch.category ||
                        existingState.takenById !== nextPatch.takenById ||
                        existingState.guildId !== nextPatch.guildId ||
                        existingState.lastActive !== nextPatch.lastActive ||
                        existingState.takenAt !== nextPatch.takenAt;
                    if (needsStateUpdate) {
                        updateTicketState(channel.id, nextPatch);
                        touched = true;
                    }
                } else {
                    createTicketState(channel.id, {
                        ownerId: recoveredTicket.ownerId,
                        category: normalizedCategory,
                        takenById: recoveredTicket.takenById,
                        createdAt: latestActivity,
                        takenAt: recoveredTicket.takenById ? latestActivity : null,
                        lastActive: latestActivity,
                        guildId: interaction.guild.id
                    });
                    touched = true;
                }

                if (existingMetaTimestamp !== latestActivity) {
                    setTicketActivity(channel.id, latestActivity);
                    touched = true;
                }

                if (touched) {
                    repaired += 1;
                } else {
                    unchanged += 1;
                }
            } catch (error) {
                failed += 1;
                console.error(`repair-ticket-meta failed for ${channel.id}:`, error);
                if (notes.length < 8) notes.push(`- ${channel}: ${error?.message || error}`);
            }
        }

        const summary = [
            `✅ Проверено каналов: **${scanned}**`,
            `🛠️ Обновлено: **${repaired}**`,
            `➖ Без изменений: **${unchanged}**`,
            `⏭️ Пропущено: **${skipped}**`,
            `❌ Ошибок: **${failed}**`
        ];

        if (notes.length) {
            summary.push('', '**Детали:**', ...notes);
        }

        return interaction.editReply(summary.join('\n'));
    }
};
