const {
    Events,
    ChannelType,
    EmbedBuilder,
    ActionRowBuilder,
    ButtonBuilder,
    ButtonStyle,
    ModalBuilder,
    TextInputBuilder,
    TextInputStyle,
    StringSelectMenuBuilder,
    StringSelectMenuOptionBuilder,
    PermissionFlagsBits,
    MessageFlags
} = require('discord.js');

const {
    isModerator,
    isCurator,
    isMediaManager,
    isAdmin,
    getSafeModeratorRoleIds,
    getSafePingRoleIds,
    getTicketViewRoleIds,
    editOverwriteSafe,
    allowedMentionsNone,
    isTicketChannel,
    buildTicketTopic,
    getTicketChannelState,
    parseTicketTopic
} = require('../utils/helpers');

const {
    getBannedUsers,
    updateTicketActivity,
    createTicketState,
    getTicketState,
    updateTicketState,
    setTicketTakenBy,
    hasTicketFeedback,
    setTicketFeedback,
    addStaffAction,
    getSettings
} = require('../utils/db');

const {TICKET_CATEGORY_ID, LOG_CHANNEL_ID} = process.env;

const CURATOR_ROLE_ID = String(process.env.CURATOR_ROLE_ID ?? '').trim();
const MEDIA_MANAGER_ROLE_ID = String(process.env.MEDIA_MANAGER_ROLE_ID ?? '').trim();
const ALLOWED_TICKET_CATEGORIES = new Set(['tech', 'question', 'moderator', 'media']);

const voiceCreateCooldown = new Map();
const voiceCreateInFlight = new Set();
const createTicketCooldown = new Map();
const takeTicketInFlight = new Set();
const ticketSubmitInFlight = new Set();
const helpCooldown = new Map();

function uniqSnowflakes(ids) {
    return [...new Set((ids || []).map(s => String(s).trim()).filter(Boolean).filter(s => /^\d{17,20}$/.test(s)))];
}

function isInTicketCategory(channel) {
    const cat = String(TICKET_CATEGORY_ID ?? '').trim();
    if (!/^\d{17,20}$/.test(cat)) return false;
    return String(channel?.parentId ?? '') === cat;
}

function getMskHour() {
    const now = new Date();
    return (now.getUTCHours() + 3) % 24;
}

function isWorkingHours() {
    const h = getMskHour();
    return h >= 10 && h < 22;
}

async function findExistingTicketVoiceChannel(channel, ticketOwnerId) {
    const catId = String(TICKET_CATEGORY_ID ?? '').trim();
    const topicState = getTicketChannelState(channel);
    if (topicState?.voiceId) {
        const v = await channel.guild.channels.fetch(topicState.voiceId).catch(() => null);
        if (v && v.type === ChannelType.GuildVoice) return v;
    }

    if (!/^\d{17,20}$/.test(catId)) return null;
    const candidates = channel.guild.channels.cache.filter(c =>
        c &&
        c.type === ChannelType.GuildVoice &&
        String(c.parentId ?? '') === catId &&
        (
            c.permissionOverwrites?.cache?.get(ticketOwnerId)?.allow?.has(PermissionFlagsBits.ViewChannel)
        )
    );
    return candidates.first() || null;
}

function sanitizeVoiceNamePart(s) {
    return String(s ?? '')
        .replace(/[\r\n\t]+/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}

function buildVoiceName(moderatorName, ownerName) {
    const a = sanitizeVoiceNamePart(moderatorName) || 'moder';
    const b = sanitizeVoiceNamePart(ownerName) || 'user';
    let name = `Voice${a}-${b}`;
    if (name.length <= 100) return name;
    const max = 100 - 'Voice'.length - 1;
    const half = Math.max(10, Math.floor(max / 2));
    const a2 = a.slice(0, half);
    const b2 = b.slice(0, max - a2.length);
    name = `Voice${a2}-${b2}`.slice(0, 100);
    return name;
}

async function acquireVoiceLock(channel, interactionId) {
    const current = getTicketChannelState(channel);
    if (current?.voiceId) return {ok: false, reason: 'exists'};
    if (current?.voiceLockId) return {ok: false, reason: 'locked'};
    await channel.setTopic(buildTicketTopic({
        ...current,
        voiceLockId: interactionId
    })).catch(() => {
    });
    const fresh = await channel.fetch().catch(() => channel);
    return getTicketChannelState(fresh)?.voiceLockId === String(interactionId) ? {ok: true} : {ok: false, reason: 'race'};
}

async function releaseVoiceLock(channel, interactionId) {
    const fresh = await channel.fetch().catch(() => channel);
    const current = getTicketChannelState(fresh);
    if (!current?.voiceLockId || String(current.voiceLockId) !== String(interactionId) || current.voiceId) return;
    await fresh.setTopic(buildTicketTopic({
        ...current,
        voiceLockId: null
    })).catch(() => {
    });
}

function hitCooldown(map, key, ms) {
    const now = Date.now();
    const last = map.get(key) || 0;
    if (now - last < ms) return true;
    map.set(key, now);
    return false;
}

function buildCategoryModal(category) {
    const modal = new ModalBuilder().setCustomId(`ticket_modal_${category}`).setTitle('Детали тикета');

    if (category === 'tech') {
        modal.addComponents(
            new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('ticket_nick').setLabel("Никнейм").setStyle(TextInputStyle.Short).setRequired(true)),
            new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('ticket_desc').setLabel("Описание проблемы").setStyle(TextInputStyle.Paragraph).setRequired(true)),
            new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('ticket_version').setLabel("Версия игры и Лаунчер").setStyle(TextInputStyle.Short).setPlaceholder("1.16.5 / TLauncher").setRequired(true)),
            new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('ticket_env').setLabel("Версия Java и Антивирус").setStyle(TextInputStyle.Short).setPlaceholder("Java 17 / Kaspersky").setRequired(true))
        );
    } else if (category === 'question') {
        modal.addComponents(
            new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('ticket_nick').setLabel("Никнейм").setStyle(TextInputStyle.Short).setRequired(true)),
            new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('ticket_desc').setLabel("Ваш вопрос").setStyle(TextInputStyle.Paragraph).setRequired(true))
        );
    } else if (category === 'moderator') {
        modal.setTitle('Заявка на Модератора');
        modal.addComponents(
            new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('app_name_age').setLabel("Имя / Возраст").setStyle(TextInputStyle.Short).setRequired(true)),
            new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('app_exp').setLabel("Опыт работы").setStyle(TextInputStyle.Paragraph).setRequired(true)),
            new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('app_time').setLabel("Часовой пояс / Прайм-тайм").setStyle(TextInputStyle.Short).setRequired(true)),
            new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('app_why').setLabel("Почему именно вы?").setStyle(TextInputStyle.Paragraph).setRequired(true))
        );
    } else if (category === 'media') {
        modal.setTitle('Заявка на Медиа');
        modal.addComponents(
            new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('media_link').setLabel("Ссылка на канал / аккаунт").setStyle(TextInputStyle.Short).setRequired(true)),
            new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('media_stats').setLabel("Количество подписчиков").setStyle(TextInputStyle.Short).setRequired(true)),
            new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('media_views').setLabel("Среднее кол-во просмотров").setStyle(TextInputStyle.Short).setRequired(true)),
            new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('media_desc').setLabel("Формат сотрудничества").setStyle(TextInputStyle.Paragraph).setRequired(true))
        );
    }

    return modal;
}

function getTicketStateFromChannel(channel, message) {
    return getTicketChannelState(channel, {message});
}

async function backfillLegacyTicketMetadata(channel, ticket, category, guildId) {
    if (!ticket?.ownerId) return ticket;

    const topicState = parseTicketTopic(channel);
    const nextCategory = ticket.category || category || 'question';
    const repaired = {
        ...ticket,
        ownerId: ticket.ownerId,
        category: nextCategory
    };

    if (!topicState.ownerId || !topicState.category) {
        await channel.setTopic(buildTicketTopic({
            ...repaired,
            helpOpen: ticket.helpOpen,
            voiceId: ticket.voiceId,
            voiceLockId: ticket.voiceLockId
        })).catch(() => {
        });
    }

    const existingState = getTicketState(channel.id);
    if (existingState) {
        try {
            updateTicketState(channel.id, {
                ownerId: repaired.ownerId,
                category: nextCategory,
                guildId: guildId || existingState.guildId || null
            });
        } catch {
            // noop
        }
    } else {
        try {
            createTicketState(channel.id, {
                ownerId: repaired.ownerId,
                category: nextCategory,
                createdAt: Date.now(),
                lastActive: Date.now(),
                guildId: guildId || null
            });
        } catch {
            // noop
        }
    }

    return repaired;
}

function inferTicketCategory(ticket, message) {
    if (ticket?.category && ALLOWED_TICKET_CATEGORIES.has(ticket.category)) return ticket.category;

    const embedTitle = message?.embeds?.[0]?.title || '';
    if (embedTitle.includes('Заявка на Модератора')) return 'moderator';
    if (embedTitle.includes('Заявка на Медиа') || embedTitle.includes('Заявка на Ютубера')) return 'media';
    if (embedTitle.includes('Вопрос')) return 'question';
    if (embedTitle.includes('Техническая проблема')) return 'tech';
    return 'question';
}

function canTakeTicket(member, category) {
    if (isCurator(member) || isAdmin(member)) return true;
    if (category === 'moderator') {
        return isCurator(member) || isAdmin(member);
    }
    if (category === 'media') {
        return isMediaManager(member) || isAdmin(member);
    }
    return isModerator(member) || isAdmin(member);
}

function findExistingTicketChannelForUser(guild, userId) {
    return guild?.channels?.cache?.find(channel => {
        if (!channel) return false;
        return getTicketChannelState(channel)?.ownerId === userId;
    }) || null;
}

function buildTicketEmbed(category, interaction, user) {
    const embed = new EmbedBuilder().setTimestamp().setFooter({text: "Ожидайте ответа."});

    if (category === 'tech') {
        embed.setTitle('🛠️ Техническая проблема')
            .setColor(0xe74c3c)
            .addFields(
                {name: "Пользователь", value: `${user} (${user.tag})`, inline: true},
                {name: "Никнейм", value: interaction.fields.getTextInputValue('ticket_nick'), inline: true},
                {name: "Описание", value: interaction.fields.getTextInputValue('ticket_desc')},
                {name: "Версия/Лаунчер", value: interaction.fields.getTextInputValue('ticket_version'), inline: true},
                {name: "Java/AV", value: interaction.fields.getTextInputValue('ticket_env'), inline: true}
            );
    } else if (category === 'question') {
        embed.setTitle('❓ Вопрос')
            .setColor(0x3498db)
            .addFields(
                {name: "Пользователь", value: `${user} (${user.tag})`, inline: true},
                {name: "Никнейм", value: interaction.fields.getTextInputValue('ticket_nick'), inline: true},
                {name: "Вопрос", value: interaction.fields.getTextInputValue('ticket_desc')}
            );
    } else if (category === 'moderator') {
        embed.setTitle('👮‍♂️ Заявка на Модератора')
            .setColor(0x9b59b6)
            .addFields(
                {name: "Кандидат", value: `${user} (${user.tag})`, inline: true},
                {name: "Имя / Возраст", value: interaction.fields.getTextInputValue('app_name_age'), inline: true},
                {name: "Пояс / Прайм", value: interaction.fields.getTextInputValue('app_time'), inline: true},
                {name: "Опыт", value: interaction.fields.getTextInputValue('app_exp')},
                {name: "Мотивация", value: interaction.fields.getTextInputValue('app_why')}
            );
    } else if (category === 'media') {
        embed.setTitle('📹 Заявка на Медиа')
            .setColor(0xf1c40f)
            .addFields(
                {name: "Кандидат", value: `${user} (${user.tag})`, inline: true},
                {name: "Канал / аккаунт", value: interaction.fields.getTextInputValue('media_link')},
                {name: "Подписчики", value: interaction.fields.getTextInputValue('media_stats'), inline: true},
                {name: "Просмотры", value: interaction.fields.getTextInputValue('media_views'), inline: true},
                {name: "Формат", value: interaction.fields.getTextInputValue('media_desc')}
            );
    }

    return embed;
}

module.exports = {
    name: Events.InteractionCreate,
    async execute(interaction) {
        try {
            if (isTicketChannel(interaction.channel) && interaction.user && !interaction.user.bot) {
                updateTicketActivity(interaction.channel.id);
            }

            if (interaction.isAutocomplete()) {
                const command = interaction.client.commands.get(interaction.commandName);
                if (!command || !command.autocomplete) return;
                try {
                    await command.autocomplete(interaction);
                } catch (e) {
                    console.error(e);
                }
                return;
            }

            if (interaction.isChatInputCommand()) {
                const command = interaction.client.commands.get(interaction.commandName);
                if (!command) return;
                try {
                    await command.execute(interaction);
                } catch (error) {
                    console.error(error);
                    if (interaction.replied || interaction.deferred) await interaction.followUp({
                        content: 'Error!',
                        flags: MessageFlags.Ephemeral
                    });
                    else await interaction.reply({content: 'Error!', flags: MessageFlags.Ephemeral});
                }
                return;
            }

            if (interaction.isStringSelectMenu()) {
                if (interaction.customId === 'ticket_category_select') {
                    const category = interaction.values[0];
                    if (!ALLOWED_TICKET_CATEGORIES.has(category)) {
                        return interaction.reply({content: '❌ Некорректная категория тикета.', flags: MessageFlags.Ephemeral});
                    }
                    const modal = buildCategoryModal(category);
                    await interaction.showModal(modal);
                }
                return;
            }

            if (interaction.isButton()) {
                if (interaction.customId === "create_ticket") {
                    if (hitCooldown(createTicketCooldown, interaction.user.id, 3_000)) {
                        return interaction.reply({content: "⏳ Подождите пару секунд перед повторным созданием тикета.", flags: MessageFlags.Ephemeral});
                    }
                    if (getBannedUsers().includes(interaction.user.id)) {
                        return interaction.reply({content: "🚫 Вы заблокированы в системе поддержки.", flags: MessageFlags.Ephemeral});
                    }

                    const existing = findExistingTicketChannelForUser(interaction.guild, interaction.user.id);
                    if (existing) {
                        return interaction.reply({content: `❌ У вас уже есть тикет: ${existing}`, flags: MessageFlags.Ephemeral});
                    }

                    const h = getMskHour();
                    const warning = (h < 10 || h >= 22)
                        ? "\n⚠️ **Внимание:** Сейчас нерабочее время (10:00 - 22:00 МСК). Мы ответим утром."
                        : "";

                    const settings = getSettings();
                    const options = [
                        new StringSelectMenuOptionBuilder().setLabel('Техническая проблема').setValue('tech').setEmoji('🛠️').setDescription('Не запускается, крашит, ошибки'),
                        new StringSelectMenuOptionBuilder().setLabel('Вопрос').setValue('question').setEmoji('❓').setDescription('Общие вопросы')
                    ];

                    if (settings.moderator_recruitment === 'open') {
                        options.push(new StringSelectMenuOptionBuilder().setLabel('Заявка на Модератора').setValue('moderator').setEmoji('👮‍♂️').setDescription('Вступить в команду'));
                    }

                    if (settings.media_recruitment === 'open') {
                        options.push(new StringSelectMenuOptionBuilder().setLabel('Заявка на Медиа').setValue('media').setEmoji('📹').setDescription('Тиктокер / Ютубер / сотрудничество'));
                    }

                    const select = new StringSelectMenuBuilder()
                        .setCustomId('ticket_category_select')
                        .setPlaceholder('Выберите тему обращения')
                        .addOptions(options);

                    return interaction.reply({
                        content: `Пожалуйста, выберите категорию вашего вопроса.${warning}`,
                        components: [new ActionRowBuilder().addComponents(select)],
                        flags: MessageFlags.Ephemeral
                    });
                }

                if (interaction.customId === "take_ticket") {
                    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

                    const channel = interaction.channel;
                    if (takeTicketInFlight.has(channel.id)) {
                        return interaction.editReply("⏳ Тикет уже берётся другим модератором, подождите.");
                    }
                    takeTicketInFlight.add(channel.id);
                    try {
                    let ticket = getTicketStateFromChannel(channel, interaction.message);
                    if (!ticket?.ownerId) return interaction.editReply("❌ Не удалось определить владельца тикета.");

                    if (!isInTicketCategory(channel)) return interaction.editReply("❌ Этот канал не находится в категории тикетов.");

                    const ticketCategory = inferTicketCategory(ticket, interaction.message);
                    ticket = await backfillLegacyTicketMetadata(channel, ticket, ticketCategory, interaction.guild.id);
                    if (!canTakeTicket(interaction.member, ticketCategory)) {
                        if (ticketCategory === 'moderator') return interaction.editReply("❌ Только для Кураторов");
                        if (ticketCategory === 'media') return interaction.editReply("❌ Только для Медиа-менеджеров");
                        return interaction.editReply("❌ Только модератор");
                    }

                    if (ticket.takenById) {
                        return interaction.editReply("❌ Тикет уже занят.");
                    }

                    const takerOverwriteOk = await editOverwriteSafe(channel, interaction.guild, interaction.user.id, {
                        SendMessages: true,
                        ViewChannel: true,
                        ReadMessageHistory: true
                    });
                    if (!takerOverwriteOk) {
                        return interaction.editReply("❌ Не удалось выдать доступ модератору, который взял тикет.");
                    }

                    const ownerOverwriteOk = await editOverwriteSafe(channel, interaction.guild, ticket.ownerId, {
                        SendMessages: true,
                        ViewChannel: true,
                        ReadMessageHistory: true
                    });
                    if (!ownerOverwriteOk) {
                        return interaction.editReply("❌ Владелец тикета не найден на сервере, доступ выдать не удалось.");
                    }

                    await channel.setTopic(buildTicketTopic({
                        ...ticket,
                        ownerId: ticket.ownerId,
                        category: ticketCategory,
                        takenById: interaction.user.id,
                        helpOpen: false
                    }));

                    if (getTicketState(channel.id)) {
                        setTicketTakenBy(channel.id, interaction.user.id);
                    } else {
                        createTicketState(channel.id, {
                            ownerId: ticket.ownerId,
                            category: ticketCategory,
                            takenById: interaction.user.id,
                            createdAt: Date.now(),
                            takenAt: Date.now(),
                            lastActive: Date.now(),
                            guildId: interaction.guild.id
                        });
                    }

                    const viewRoleIds = new Set(getTicketViewRoleIds(interaction.guild));
                    for (const roleId of getSafeModeratorRoleIds(interaction.guild)) {
                        if (viewRoleIds.has(roleId)) {
                            await editOverwriteSafe(channel, interaction.guild, roleId, {
                                ViewChannel: true,
                                SendMessages: false,
                                ReadMessageHistory: true
                            });
                            continue;
                        }
                        await editOverwriteSafe(channel, interaction.guild, roleId, {
                            ViewChannel: false,
                            SendMessages: false
                        });
                    }
                    if (ticketCategory === 'media' && /^\d{17,20}$/.test(MEDIA_MANAGER_ROLE_ID)) {
                        await editOverwriteSafe(channel, interaction.guild, MEDIA_MANAGER_ROLE_ID, {
                            ViewChannel: true,
                            ReadMessageHistory: true,
                            SendMessages: false
                        });
                    }

                    const components = [
                        new ButtonBuilder().setCustomId("create_voice").setLabel("Создать Voice").setEmoji("🔊").setStyle(ButtonStyle.Primary)
                    ];
                    if (ticketCategory !== 'moderator' && ticketCategory !== 'media') {
                        components.push(new ButtonBuilder().setCustomId("escalate_ticket").setLabel("🆘 Позвать других модераторов").setStyle(ButtonStyle.Danger));
                    }

                    try {
                        await interaction.message.edit({components: [new ActionRowBuilder().addComponents(components)]});
                    } catch (e) {
                        console.error("Failed to update main message buttons:", e);
                    }

                    await channel.send({
                        content: `🟢 **Тикет взял ${interaction.user.tag}**`,
                        allowedMentions: allowedMentionsNone()
                    });
                    return interaction.editReply({content: "✅ Вы взяли тикет.", components: []});
                    } finally {
                        takeTicketInFlight.delete(channel.id);
                    }
                }

                if (interaction.customId === "create_voice") {
                    await interaction.deferReply({flags: MessageFlags.Ephemeral});

                if (!isInTicketCategory(interaction.channel)) {
                    return interaction.editReply("❌ Этот канал не находится в категории тикетов.");
                }

                const ticket = getTicketStateFromChannel(interaction.channel);
                const ticketOwnerId = ticket?.ownerId;
                if (!ticketOwnerId) return interaction.editReply("❌ Это не тикет.");

                const takenById = ticket?.takenById;
                if (!takenById) return interaction.editReply("❌ Сначала возьмите тикет, затем создайте voice.");
                const memberIsAdmin = isAdmin(interaction.member);
                const memberIsCurator = isCurator(interaction.member);
                if (interaction.user.id !== takenById && !memberIsAdmin && !memberIsCurator) return interaction.editReply("❌ Создавать voice может только модератор, который взял тикет.");

                const existing = await findExistingTicketVoiceChannel(interaction.channel, ticketOwnerId);
                if (existing) return interaction.editReply(`⚠️ Голосовой канал для этого тикета уже создан: ${existing}`);

                const last = voiceCreateCooldown.get(interaction.channel.id) || 0;
                if (Date.now() - last < 30_000) return interaction.editReply("⏳ Подождите 30 секунд перед повторной попыткой.");
                voiceCreateCooldown.set(interaction.channel.id, Date.now());
                if (voiceCreateInFlight.has(interaction.channel.id)) return interaction.editReply("⏳ Создание голосового канала уже выполняется.");
                voiceCreateInFlight.add(interaction.channel.id);

                const botId = interaction.guild.members.me?.id || interaction.client.user.id;
                const modRoleIds = getSafeModeratorRoleIds(interaction.guild);
                const curatorRoleIds = uniqSnowflakes([CURATOR_ROLE_ID]);
                let lockAcquired = false;

                try {
                    const lock = await acquireVoiceLock(interaction.channel, interaction.id);
                    if (!lock.ok) {
                        const existingAfter = await findExistingTicketVoiceChannel(interaction.channel, ticketOwnerId);
                        if (existingAfter) return interaction.editReply(`⚠️ Голосовой канал для этого тикета уже создан: ${existingAfter}`);
                        return interaction.editReply("⏳ Голосовой канал уже создаётся, подождите.");
                    }
                    lockAcquired = true;

                    const modMember = await interaction.guild.members.fetch(takenById).catch(() => null);
                    const ownerMember = await interaction.guild.members.fetch(ticketOwnerId).catch(() => null);
                    const modName = modMember?.displayName || modMember?.user?.username || takenById;
                    const ownerName = ownerMember?.displayName || ownerMember?.user?.username || ticketOwnerId;
                    const voiceName = buildVoiceName(modName, ownerName);

                    const voice = await interaction.guild.channels.create({
                        name: voiceName,
                        type: ChannelType.GuildVoice,
                        parent: TICKET_CATEGORY_ID,
                        permissionOverwrites: [
                            {id: interaction.guild.id, deny: [PermissionFlagsBits.ViewChannel]},
                            {
                                id: botId,
                                allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.Connect, PermissionFlagsBits.Speak, PermissionFlagsBits.ManageChannels]
                            },
                            {
                                id: ticketOwnerId,
                                allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.Connect, PermissionFlagsBits.Speak]
                            },
                            {
                                id: takenById,
                                allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.Connect, PermissionFlagsBits.Speak]
                            },
                            ...curatorRoleIds.map(id => ({
                                id,
                                allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.Connect, PermissionFlagsBits.Speak]
                            })),
                            ...(ticket.helpOpen ? uniqSnowflakes(modRoleIds).map(id => ({
                                id,
                                allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.Connect, PermissionFlagsBits.Speak]
                            })) : [])
                        ]
                    });

                    await interaction.channel.setTopic(buildTicketTopic({
                        ...ticket,
                        ownerId: ticket.ownerId,
                        category: ticket.category,
                        takenById,
                        voiceId: voice.id,
                        helpOpen: ticket.helpOpen
                    })).catch(() => {
                    });

                    return interaction.editReply({content: `✅ Голосовой канал создан: ${voice}`});
                } finally {
                    if (lockAcquired) {
                        await releaseVoiceLock(interaction.channel, interaction.id);
                    }
                    voiceCreateInFlight.delete(interaction.channel.id);
                }
            }

            if (interaction.customId === "escalate_ticket") {
                const ticket = getTicketStateFromChannel(interaction.channel);
                if (!isInTicketCategory(interaction.channel) || !ticket?.ownerId) {
                    return interaction.reply({content: "❌ Это не активный тикет.", flags: MessageFlags.Ephemeral});
                }
                if ((ticket.category === 'moderator' || ticket.category === 'media') && !isCurator(interaction.member)) {
                    return interaction.reply({
                        content: "❌ Для этого типа тикета помощь модераторов не используется.",
                        flags: MessageFlags.Ephemeral
                    });
                }
                if (!ticket.takenById) {
                    return interaction.reply({content: "❌ Сначала возьмите тикет.", flags: MessageFlags.Ephemeral});
                }
                if (!isModerator(interaction.member) && !isCurator(interaction.member) && !isAdmin(interaction.member)) {
                    return interaction.reply({content: "❌ Нет прав.", flags: MessageFlags.Ephemeral});
                }
                if (interaction.user.id !== ticket.takenById && !isCurator(interaction.member) && !isAdmin(interaction.member)) {
                    return interaction.reply({
                        content: "❌ Помощь может вызвать только модератор, который взял тикет.",
                        flags: MessageFlags.Ephemeral
                    });
                }
                if (ticket.helpOpen) {
                    return interaction.reply({content: "⚠️ Помощь уже вызвана для этого тикета.", flags: MessageFlags.Ephemeral});
                }
                if (hitCooldown(helpCooldown, interaction.channel.id, 30_000)) {
                    return interaction.reply({content: "⏳ Нельзя вызывать помощь чаще, чем раз в 30 секунд.", flags: MessageFlags.Ephemeral});
                }

                await interaction.reply({content: "🚨 **Модераторы призваны!**", flags: MessageFlags.Ephemeral});

                const channel = interaction.channel;
                const failedRoleIds = [];
                for (const roleId of getSafeModeratorRoleIds(interaction.guild)) {
                    const ok = await editOverwriteSafe(channel, interaction.guild, roleId, {
                        ViewChannel: true,
                        SendMessages: true
                    });
                    if (!ok) failedRoleIds.push(roleId);
                }
                if (failedRoleIds.length) {
                    console.warn(`Failed to open help access for role IDs: ${failedRoleIds.join(', ')}`);
                }
                await channel.setTopic(buildTicketTopic({
                    ...ticket,
                    helpOpen: true
                })).catch(() => {
                });

                const pingRoleIds = getSafePingRoleIds(interaction.guild);
                const pings = pingRoleIds.map(id => `<@&${id}>`).join(" ");
                await interaction.channel.send({
                    content: `🆘 **HELP APPROVED** ${pings}\nМодератор ${interaction.user} открыл доступ к тикету для помощи.`,
                    allowedMentions: {parse: [], roles: pingRoleIds, users: []}
                });
                    return;
                }

                if (interaction.customId.startsWith("rate:")) {
                const [, ticketId, staffId, rawRating] = interaction.customId.split(':');
                const rating = Number.parseInt(rawRating, 10);
                if (!/^\d{17,20}$/.test(String(ticketId ?? '')) || !/^\d{17,20}$/.test(String(staffId ?? '')) || !Number.isInteger(rating) || rating < 1 || rating > 5) {
                    return interaction.update({content: "❌ Некорректная оценка.", components: [], embeds: []});
                }
                if (hasTicketFeedback(ticketId)) {
                    return interaction.update({
                        content: "⚠️ Оценка по этому тикету уже сохранена.",
                        components: [],
                        embeds: []
                    });
                }

                await interaction.update({content: `✅ Спасибо за оценку: ${rating} ⭐`, components: [], embeds: []});

                setTicketFeedback(ticketId, {
                    userId: interaction.user.id,
                    staffId,
                    rating,
                    createdAt: Date.now()
                });
                addStaffAction(staffId, 'rating', rating);

                try {
                    const logChannel = LOG_CHANNEL_ID
                        ? await interaction.client.channels.fetch(LOG_CHANNEL_ID).catch(() => null)
                        : null;
                    if (logChannel) {
                        const embed = new EmbedBuilder()
                            .setTitle("⭐ Новая оценка")
                            .setDescription(`Пользователь ${interaction.user} поставил **${rating} / 5** модератору <@${staffId}>`)
                            .addFields({name: "Тикет", value: ticketId, inline: true})
                            .setColor(rating >= 4 ? 0x2ecc71 : 0xe74c3c)
                            .setTimestamp();
                        await logChannel.send({embeds: [embed]});
                    }
                } catch (e) {
                    console.error("Failed to log rating:", e);
                }
                    return;
                }

                if (interaction.customId.startsWith("rate_")) {
                const rating = parseInt(interaction.customId.split("_")[1], 10);
                await interaction.update({content: `✅ Спасибо за оценку: ${rating} ⭐`, components: [], embeds: []});
                    return;
                }
            }

            if (interaction.isModalSubmit()) {
            if (!interaction.customId.startsWith('ticket_modal_')) return;
            const category = interaction.customId.split('_')[2];
            if (!ALLOWED_TICKET_CATEGORIES.has(category)) {
                return interaction.reply({content: '❌ Некорректная категория тикета.', flags: MessageFlags.Ephemeral});
            }
            const submitKey = `${interaction.user.id}:${category}`;
            if (ticketSubmitInFlight.has(submitKey)) {
                return interaction.reply({content: '⏳ Заявка уже обрабатывается, подождите.', flags: MessageFlags.Ephemeral});
            }
            ticketSubmitInFlight.add(submitKey);
            try {
                await interaction.deferReply({flags: MessageFlags.Ephemeral});

                const user = interaction.user;
                const guild = interaction.guild;

                if (!/^\d{17,20}$/.test(String(TICKET_CATEGORY_ID ?? '').trim())) {
                    return interaction.editReply("❌ Не настроен TICKET_CATEGORY_ID (env).");
                }

                if (findExistingTicketChannelForUser(guild, user.id)) {
                    return interaction.editReply("❌ Тикет уже существует.");
                }

                const botId = guild.members.me?.id || interaction.client.user.id;
                const modRoleIds = getSafeModeratorRoleIds(guild);
                const viewRoleIds = getTicketViewRoleIds(guild);
                const curatorRoleIds = uniqSnowflakes([CURATOR_ROLE_ID]);

                const permissionOverwrites = [
                    {id: guild.id, deny: [PermissionFlagsBits.ViewChannel]},
                    {
                        id: botId,
                        allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory, PermissionFlagsBits.ManageChannels]
                    },
                    {
                        id: user.id,
                        allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.ReadMessageHistory],
                        deny: [PermissionFlagsBits.SendMessages]
                    },
                    ...curatorRoleIds.map(id => ({
                        id,
                        allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory]
                    })),
                    ...uniqSnowflakes(viewRoleIds).map(id => ({
                        id,
                        allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.ReadMessageHistory],
                        deny: [PermissionFlagsBits.SendMessages]
                    }))
                ];

                let pingRoleIds = [];
                if (category === 'media') {
                    permissionOverwrites.push({
                        id: MEDIA_MANAGER_ROLE_ID,
                        allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.ReadMessageHistory],
                        deny: [PermissionFlagsBits.SendMessages]
                    });
                    pingRoleIds = [MEDIA_MANAGER_ROLE_ID];
                } else if (category === 'moderator') {
                    permissionOverwrites.push({
                        id: CURATOR_ROLE_ID,
                        allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.ReadMessageHistory]
                    });
                    pingRoleIds = [CURATOR_ROLE_ID];
                } else {
                    permissionOverwrites.push(...uniqSnowflakes(modRoleIds).map(id => ({
                        id,
                        allow: [PermissionFlagsBits.ViewChannel],
                        deny: [PermissionFlagsBits.SendMessages]
                    })));
                    pingRoleIds = getSafePingRoleIds(guild);
                }

                const channel = await guild.channels.create({
                    name: `ticket-${user.id}`,
                    type: ChannelType.GuildText,
                    parent: TICKET_CATEGORY_ID,
                    topic: buildTicketTopic({
                        ownerId: user.id,
                        category
                    }),
                    permissionOverwrites
                });

                const embed = buildTicketEmbed(category, interaction, user);
                const row = new ActionRowBuilder().addComponents(
                    new ButtonBuilder().setCustomId("take_ticket").setLabel("Взять тикет").setEmoji("🟢").setStyle(ButtonStyle.Success)
                );

                const allowMentions = {parse: [], roles: pingRoleIds, users: []};
                const shouldPing = (category === 'media' || category === 'moderator') ? true : isWorkingHours();
                const pings = shouldPing ? pingRoleIds.map(id => `<@&${id}>`).join(" ") : "";

                await channel.send({
                    content: pings || null,
                    embeds: [embed],
                    components: [row],
                    allowedMentions: allowMentions
                });

                try {
                    createTicketState(channel.id, {
                        ownerId: user.id,
                        category,
                        createdAt: Date.now(),
                        lastActive: Date.now(),
                        guildId: guild.id
                    });
                } catch (e) {
                    console.error("Failed to create ticket state:", e);
                    await channel.delete().catch(() => {
                    });
                    return interaction.editReply("❌ Не удалось сохранить состояние тикета. Попробуйте ещё раз.");
                }
                updateTicketActivity(channel.id);
                return interaction.editReply({content: `✅ Тикет создан: ${channel}`});
            } finally {
                ticketSubmitInFlight.delete(submitKey);
            }
            }
        } catch (error) {
            console.error('InteractionCreate error:', error);
            try {
                if (interaction?.replied || interaction?.deferred) {
                    await interaction.followUp({content: '❌ Произошла ошибка при обработке interaction.', flags: MessageFlags.Ephemeral});
                } else if (interaction?.isRepliable?.()) {
                    await interaction.reply({content: '❌ Произошла ошибка при обработке interaction.', flags: MessageFlags.Ephemeral});
                }
            } catch {
                // noop
            }
        }
    },
};
