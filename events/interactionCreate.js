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
    PermissionFlagsBits
} = require('discord.js');

const {
    isModerator,
    isCurator,
    isAdmin,
    getSafeModeratorRoleIds,
    getSafePingRoleIds,
    getTicketViewRoleIds,
    allowedMentionsNone,
    isTicketChannel,
    ticketOwnerIdFromChannel
} = require('../utils/helpers');

const {
    getBannedUsers,
    updateTicketActivity,
    createTicketState,
    getTicketState,
    setTicketTakenBy,
    hasTicketFeedback,
    setTicketFeedback,
    addStaffAction
} = require('../utils/db');

const {TICKET_CATEGORY_ID, LOG_CHANNEL_ID} = process.env;

const CURATOR_ROLE_ID = String(process.env.CURATOR_ROLE_ID ?? '1469094304789037249').trim();
const MEDIA_MANAGER_ROLE_ID = String(process.env.MEDIA_MANAGER_ROLE_ID ?? '1469094131920797811').trim();
const ALLOWED_TICKET_CATEGORIES = new Set(['tech', 'question', 'moderator', 'media']);

const voiceCreateCooldown = new Map();
const voiceCreateInFlight = new Set();

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
    const topicVoiceMatch = channel.topic?.match(/VOICE:(\d{17,20})/);
    if (topicVoiceMatch) {
        const v = await channel.guild.channels.fetch(topicVoiceMatch[1]).catch(() => null);
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
    const topic = String(channel.topic ?? '');
    if (topic.includes('VOICE:')) return {ok: false, reason: 'exists'};
    if (topic.includes('VOICE_LOCK:')) return {ok: false, reason: 'locked'};
    const next = `${topic} | VOICE_LOCK:${interactionId}`.trim();
    await channel.setTopic(next).catch(() => {
    });
    const fresh = await channel.fetch().catch(() => channel);
    const freshTopic = String(fresh.topic ?? '');
    return freshTopic.includes(`VOICE_LOCK:${interactionId}`) ? {ok: true} : {ok: false, reason: 'race'};
}

function releaseVoiceLock(topic) {
    return String(topic ?? '')
        .replace(/\s*\|\s*VOICE_LOCK:\d{17,20}\s*/g, ' ')
        .replace(/\s{2,}/g, ' ')
        .trim();
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

function getTicketStateFromChannel(channel) {
    const fromDb = getTicketState(channel?.id);
    if (fromDb) return fromDb;

    const ownerId = ticketOwnerIdFromChannel(channel);
    if (!ownerId) return null;

    const takenMatch = channel?.topic?.match(/TAKEN_BY:(\d{17,20})/);
    return {
        ownerId,
        category: null,
        takenById: takenMatch ? takenMatch[1] : null,
        createdAt: null,
        takenAt: null,
        lastActive: null,
        guildId: channel?.guildId ? String(channel.guildId) : null
    };
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
        return member?.roles?.cache?.has?.(CURATOR_ROLE_ID) || isAdmin(member);
    }
    if (category === 'media') {
        return member?.roles?.cache?.has?.(MEDIA_MANAGER_ROLE_ID) || isAdmin(member);
    }
    return isModerator(member) || isAdmin(member);
}

function findExistingTicketChannelForUser(guild, userId) {
    return guild?.channels?.cache?.find(channel => {
        if (!channel) return false;
        if (channel.name === `ticket-${userId}`) return true;
        return getTicketState(channel.id)?.ownerId === userId;
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
                    ephemeral: true
                });
                else await interaction.reply({content: 'Error!', ephemeral: true});
            }
            return;
        }

        if (interaction.isStringSelectMenu()) {
            if (interaction.customId === 'ticket_category_select') {
                const category = interaction.values[0];
                if (!ALLOWED_TICKET_CATEGORIES.has(category)) {
                    return interaction.reply({content: '❌ Некорректная категория тикета.', ephemeral: true});
                }
                const modal = buildCategoryModal(category);
                await interaction.showModal(modal);
            }
            return;
        }

        if (interaction.isButton()) {
            if (interaction.customId === "create_ticket") {
                if (getBannedUsers().includes(interaction.user.id)) {
                    return interaction.reply({content: "🚫 Вы заблокированы в системе поддержки.", ephemeral: true});
                }

                const existing = findExistingTicketChannelForUser(interaction.guild, interaction.user.id);
                if (existing) {
                    return interaction.reply({content: `❌ У вас уже есть тикет: ${existing}`, ephemeral: true});
                }

                const h = getMskHour();
                const warning = (h < 10 || h >= 22)
                    ? "\n⚠️ **Внимание:** Сейчас нерабочее время (10:00 - 22:00 МСК). Мы ответим утром."
                    : "";

                const select = new StringSelectMenuBuilder()
                    .setCustomId('ticket_category_select')
                    .setPlaceholder('Выберите тему обращения')
                    .addOptions(
                        new StringSelectMenuOptionBuilder().setLabel('Техническая проблема').setValue('tech').setEmoji('🛠️').setDescription('Не запускается, крашит, ошибки'),
                        new StringSelectMenuOptionBuilder().setLabel('Вопрос').setValue('question').setEmoji('❓').setDescription('Общие вопросы'),
                        new StringSelectMenuOptionBuilder().setLabel('Заявка на Модератора').setValue('moderator').setEmoji('👮‍♂️').setDescription('Вступить в команду'),
                        new StringSelectMenuOptionBuilder().setLabel('Заявка на Медиа').setValue('media').setEmoji('📹').setDescription('Тиктокер / Ютубер / сотрудничество')
                    );

                return interaction.reply({
                    content: `Пожалуйста, выберите категорию вашего вопроса.${warning}`,
                    components: [new ActionRowBuilder().addComponents(select)],
                    ephemeral: true
                });
            }

            if (interaction.customId === "take_ticket") {
                await interaction.deferReply({ ephemeral: true });

                const channel = interaction.channel;
                const ticket = getTicketStateFromChannel(channel);
                if (!ticket?.ownerId) return interaction.editReply("❌ Не удалось определить владельца тикета.");

                if (!isInTicketCategory(channel)) return interaction.editReply("❌ Этот канал не находится в категории тикетов.");

                const ticketCategory = inferTicketCategory(ticket, interaction.message);
                if (!canTakeTicket(interaction.member, ticketCategory)) {
                    if (ticketCategory === 'moderator') return interaction.editReply("❌ Только для Кураторов");
                    if (ticketCategory === 'media') return interaction.editReply("❌ Только для Медиа-менеджеров");
                    return interaction.editReply("❌ Только модератор");
                }

                if (ticket.takenById || (channel.topic && channel.topic.startsWith("TAKEN_BY:"))) {
                    return interaction.editReply("❌ Тикет уже занят.");
                }

                let newTopic = `TAKEN_BY:${interaction.user.id}`;
                if (channel.topic && channel.topic.includes("VOICE:")) {
                    const voiceMatch = channel.topic.match(/VOICE:\d{17,20}/);
                    if (voiceMatch) newTopic += ` | ${voiceMatch[0]}`;
                }
                await channel.setTopic(newTopic);
                await channel.permissionOverwrites.edit(interaction.user.id, {
                    SendMessages: true,
                    ViewChannel: true,
                    ReadMessageHistory: true
                });
                await channel.permissionOverwrites.edit(ticket.ownerId, {
                    SendMessages: true,
                    ViewChannel: true,
                    ReadMessageHistory: true
                });

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
                    if (viewRoleIds.has(roleId)) continue;
                    await channel.permissionOverwrites.edit(roleId, {ViewChannel: false});
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
            }

            if (interaction.customId === "create_voice") {
                await interaction.deferReply({ephemeral: true});

                if (!isInTicketCategory(interaction.channel)) {
                    return interaction.editReply("❌ Этот канал не находится в категории тикетов.");
                }

                const ticket = getTicketStateFromChannel(interaction.channel);
                const ticketOwnerId = ticket?.ownerId || ticketOwnerIdFromChannel(interaction.channel);
                if (!ticketOwnerId) return interaction.editReply("❌ Это не тикет.");

                const takenMatch = interaction.channel.topic?.match(/TAKEN_BY:(\d{17,20})/);
                const takenById = ticket?.takenById || (takenMatch ? takenMatch[1] : null);
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
                const viewRoleIds = getTicketViewRoleIds(interaction.guild);
                const curatorRoleIds = uniqSnowflakes([CURATOR_ROLE_ID]);

                try {
                    const lock = await acquireVoiceLock(interaction.channel, interaction.id);
                    if (!lock.ok) {
                        const existingAfter = await findExistingTicketVoiceChannel(interaction.channel, ticketOwnerId);
                        if (existingAfter) return interaction.editReply(`⚠️ Голосовой канал для этого тикета уже создан: ${existingAfter}`);
                        return interaction.editReply("⏳ Голосовой канал уже создаётся, подождите.");
                    }

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
                            ...curatorRoleIds.map(id => ({
                                id,
                                allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.Connect, PermissionFlagsBits.Speak]
                            })),
                            ...uniqSnowflakes(modRoleIds).map(id => ({
                                id,
                                allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.Connect, PermissionFlagsBits.Speak]
                            })),
                            ...uniqSnowflakes(viewRoleIds).map(id => ({
                                id,
                                allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.Connect]
                            }))
                        ]
                    });

                    const currentTopic = interaction.channel.topic || "";
                    const cleared = releaseVoiceLock(currentTopic);
                    if (!cleared.includes("VOICE:")) {
                        await interaction.channel.setTopic(`${cleared} | VOICE:${voice.id}`.trim()).catch(() => {
                        });
                    }

                    return interaction.editReply({content: `✅ Голосовой канал создан: ${voice}`});
                } finally {
                    voiceCreateInFlight.delete(interaction.channel.id);
                }
            }

            if (interaction.customId === "escalate_ticket") {
                const ticket = getTicketStateFromChannel(interaction.channel);
                if (!isInTicketCategory(interaction.channel) || !ticket?.ownerId) {
                    return interaction.reply({content: "❌ Это не активный тикет.", ephemeral: true});
                }
                if ((ticket.category === 'moderator' || ticket.category === 'media') && !isCurator(interaction.member)) {
                    return interaction.reply({
                        content: "❌ Для этого типа тикета помощь модераторов не используется.",
                        ephemeral: true
                    });
                }
                if (!ticket.takenById) {
                    return interaction.reply({content: "❌ Сначала возьмите тикет.", ephemeral: true});
                }
                if (!isModerator(interaction.member) && !isCurator(interaction.member) && !isAdmin(interaction.member)) {
                    return interaction.reply({content: "❌ Нет прав.", ephemeral: true});
                }
                if (interaction.user.id !== ticket.takenById && !isCurator(interaction.member) && !isAdmin(interaction.member)) {
                    return interaction.reply({
                        content: "❌ Помощь может вызвать только модератор, который взял тикет.",
                        ephemeral: true
                    });
                }

                await interaction.reply({content: "🚨 **Модераторы призваны!**", ephemeral: true});

                const channel = interaction.channel;
                for (const roleId of getSafeModeratorRoleIds(interaction.guild)) {
                    await channel.permissionOverwrites.edit(roleId, {ViewChannel: true, SendMessages: true});
                }

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
                return interaction.reply({content: '❌ Некорректная категория тикета.', ephemeral: true});
            }
            await interaction.deferReply({ephemeral: true});

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
                    allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.ReadMessageHistory]
                }))
            ];

            let pingRoleIds = [];
            if (category === 'media') {
                permissionOverwrites.push({
                    id: MEDIA_MANAGER_ROLE_ID,
                    allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.ReadMessageHistory]
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
                    allow: [PermissionFlagsBits.ViewChannel]
                })));
                pingRoleIds = getSafePingRoleIds(guild);
            }

            const channel = await guild.channels.create({
                name: `ticket-${user.id}`,
                type: ChannelType.GuildText,
                parent: TICKET_CATEGORY_ID,
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
        }
    },
};
