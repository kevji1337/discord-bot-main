const { SlashCommandBuilder, ChannelType, PermissionFlagsBits, MessageFlags } = require('discord.js');
const {
    isModerator,
    isCurator,
    isAdmin,
    getSafeModeratorRoleIds,
    buildTicketTopic,
    getTicketChannelState
} = require('../utils/helpers');
const { TICKET_CATEGORY_ID } = process.env;
const CURATOR_ROLE_ID = String(process.env.CURATOR_ROLE_ID ?? '').trim();

async function findExistingTicketVoiceChannel(channel, ticketOwnerId) {
    const catId = String(process.env.TICKET_CATEGORY_ID ?? '').trim();
    const ticket = getTicketChannelState(channel);
    if (ticket?.voiceId) {
        const v = await channel.guild.channels.fetch(ticket.voiceId).catch(() => null);
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

module.exports = {
    data: new SlashCommandBuilder()
        .setName('voice')
        .setDescription('Создать или управлять голосовым каналом тикета'),
    async execute(interaction) {
        if (!getTicketChannelState(interaction.channel)) {
            return interaction.reply({ content: "❌ Эту команду можно использовать только в тикетах.", flags: MessageFlags.Ephemeral });
        }

        const ticketCategoryId = String(process.env.TICKET_CATEGORY_ID ?? '').trim();
        if (/^\d{17,20}$/.test(ticketCategoryId) && String(interaction.channel.parentId ?? '') !== ticketCategoryId) {
            return interaction.reply({content: "❌ Этот канал не находится в категории тикетов.", flags: MessageFlags.Ephemeral});
        }

        const ticket = getTicketChannelState(interaction.channel);
        const ticketOwnerId = ticket?.ownerId;
        if (!ticketOwnerId) {
            return interaction.reply({content: "❌ Не удалось определить владельца тикета.", flags: MessageFlags.Ephemeral});
        }

        if (!isModerator(interaction.member) && !isCurator(interaction.member) && !isAdmin(interaction.member)) {
            return interaction.reply({ content: "❌ Нет прав доступа.", flags: MessageFlags.Ephemeral });
        }

        const existing = await findExistingTicketVoiceChannel(interaction.channel, ticketOwnerId);
        if (existing) return interaction.reply({
            content: `⚠️ Голосовой канал для этого тикета уже создан: ${existing}`,
            flags: MessageFlags.Ephemeral
        });

        const takenById = ticket?.takenById;
        const memberIsAdmin = isAdmin(interaction.member);
        const memberIsCurator = isCurator(interaction.member);
        if (!takenById) return interaction.reply({
            content: "❌ Сначала возьмите тикет, затем создайте voice.",
            flags: MessageFlags.Ephemeral
        });
        if (interaction.user.id !== takenById && !memberIsAdmin && !memberIsCurator) return interaction.reply({
            content: "❌ Создавать voice может только модератор, который взял тикет.",
            flags: MessageFlags.Ephemeral
        });

        await interaction.deferReply({flags: MessageFlags.Ephemeral});

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

            const botId = interaction.guild.members.me?.id || interaction.client.user.id;
            const modRoleIds = getSafeModeratorRoleIds(interaction.guild);
            const curatorRoleIds = CURATOR_ROLE_ID && /^\d{17,20}$/.test(CURATOR_ROLE_ID) ? [CURATOR_ROLE_ID] : [];
            const voice = await interaction.guild.channels.create({
                name: voiceName,
                type: ChannelType.GuildVoice,
                parent: TICKET_CATEGORY_ID,
                permissionOverwrites: [
                    { id: interaction.guild.id, deny: [PermissionFlagsBits.ViewChannel] },
                    { id: botId, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.Connect, PermissionFlagsBits.Speak, PermissionFlagsBits.ManageChannels] },
                    { id: ticketOwnerId, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.Connect, PermissionFlagsBits.Speak] },
                    { id: takenById, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.Connect, PermissionFlagsBits.Speak] },
                    ...curatorRoleIds.map(id => ({
                        id,
                        allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.Connect, PermissionFlagsBits.Speak]
                    })),
                    ...(ticket.helpOpen ? modRoleIds.map(id => ({
                        id,
                        allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.Connect, PermissionFlagsBits.Speak]
                    })) : [])
                ]
            });

            // Save Voice ID
            await interaction.channel.setTopic(buildTicketTopic({
                ...ticket,
                voiceId: voice.id,
                voiceLockId: null
            })).catch(() => {
            });

            await interaction.editReply(`✅ Голосовой канал создан: ${voice}`);
        } catch (e) {
            console.error(e);
            await interaction.editReply("❌ Ошибка создания канала.");
        } finally {
            if (lockAcquired) {
                await releaseVoiceLock(interaction.channel, interaction.id);
            }
        }
    }
};
