const { SlashCommandBuilder, ChannelType, PermissionFlagsBits } = require('discord.js');
const {getTicketState} = require('../utils/db');
const {
    isModerator,
    isCurator,
    isAdmin,
    getSafeModeratorRoleIds,
    getTicketViewRoleIds,
    ticketOwnerIdFromChannel
} = require('../utils/helpers');
const { TICKET_CATEGORY_ID } = process.env;
const CURATOR_ROLE_ID = String(process.env.CURATOR_ROLE_ID ?? '').trim();

async function findExistingTicketVoiceChannel(channel, ticketOwnerId) {
    const catId = String(process.env.TICKET_CATEGORY_ID ?? '').trim();
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

module.exports = {
    data: new SlashCommandBuilder()
        .setName('voice')
        .setDescription('Создать или управлять голосовым каналом тикета'),
    async execute(interaction) {
        if (!interaction.channel.name.startsWith('ticket-')) {
            return interaction.reply({ content: "❌ Эту команду можно использовать только в тикетах.", ephemeral: true });
        }

        const ticketCategoryId = String(process.env.TICKET_CATEGORY_ID ?? '').trim();
        if (/^\d{17,20}$/.test(ticketCategoryId) && String(interaction.channel.parentId ?? '') !== ticketCategoryId) {
            return interaction.reply({content: "❌ Этот канал не находится в категории тикетов.", ephemeral: true});
        }

        const ticket = getTicketState(interaction.channel.id);
        const ticketOwnerId = ticket?.ownerId || ticketOwnerIdFromChannel(interaction.channel);
        if (!ticketOwnerId) {
            return interaction.reply({content: "❌ Не удалось определить владельца тикета.", ephemeral: true});
        }

        if (!isModerator(interaction.member) && !isCurator(interaction.member) && !isAdmin(interaction.member)) {
            return interaction.reply({ content: "❌ Нет прав доступа.", ephemeral: true });
        }

        const existing = await findExistingTicketVoiceChannel(interaction.channel, ticketOwnerId);
        if (existing) return interaction.reply({
            content: `⚠️ Голосовой канал для этого тикета уже создан: ${existing}`,
            ephemeral: true
        });

        const takenMatch = interaction.channel.topic?.match(/TAKEN_BY:(\d{17,20})/);
        const takenById = ticket?.takenById || (takenMatch ? takenMatch[1] : null);
        const memberIsAdmin = isAdmin(interaction.member);
        const memberIsCurator = isCurator(interaction.member);
        if (!takenById) return interaction.reply({
            content: "❌ Сначала возьмите тикет, затем создайте voice.",
            ephemeral: true
        });
        if (interaction.user.id !== takenById && !memberIsAdmin && !memberIsCurator) return interaction.reply({
            content: "❌ Создавать voice может только модератор, который взял тикет.",
            ephemeral: true
        });

        await interaction.deferReply({ephemeral: true});

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

            const botId = interaction.guild.members.me?.id || interaction.client.user.id;
            const modRoleIds = getSafeModeratorRoleIds(interaction.guild);
            const viewRoleIds = getTicketViewRoleIds(interaction.guild);
            const curatorRoleIds = CURATOR_ROLE_ID && /^\d{17,20}$/.test(CURATOR_ROLE_ID) ? [CURATOR_ROLE_ID] : [];
            const voice = await interaction.guild.channels.create({
                name: voiceName,
                type: ChannelType.GuildVoice,
                parent: TICKET_CATEGORY_ID,
                permissionOverwrites: [
                    { id: interaction.guild.id, deny: [PermissionFlagsBits.ViewChannel] },
                    { id: botId, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.Connect, PermissionFlagsBits.Speak, PermissionFlagsBits.ManageChannels] },
                    { id: ticketOwnerId, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.Connect, PermissionFlagsBits.Speak] },
                    ...curatorRoleIds.map(id => ({
                        id,
                        allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.Connect, PermissionFlagsBits.Speak]
                    })),
                    ...modRoleIds.map(id => ({
                        id,
                        allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.Connect, PermissionFlagsBits.Speak]
                    })),
                    ...viewRoleIds.map(id => ({
                        id,
                        allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.Connect]
                    }))
                ]
            });

            // Save Voice ID
            let currentTopic = interaction.channel.topic || "";
            const cleared = releaseVoiceLock(currentTopic);
            if (!cleared.includes("VOICE:")) {
                await interaction.channel.setTopic(`${cleared} | VOICE:${voice.id}`.trim()).catch(() => {
                });
            }

            await interaction.editReply(`✅ Голосовой канал создан: ${voice}`);
        } catch (e) {
            console.error(e);
            await interaction.editReply("❌ Ошибка создания канала.");
        }
    }
};
