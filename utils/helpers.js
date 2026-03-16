const {
    MODERATOR_ROLE_IDS,
    PING_ROLE_IDS,
    TICKET_CATEGORY_ID,
    TICKET_VIEW_ROLE_IDS,
    CURATOR_ROLE_ID,
    MEDIA_MANAGER_ROLE_ID
} = process.env;
const {PermissionFlagsBits} = require('discord.js');
const {getTicketState} = require('./db');

const ALLOWED_TICKET_CATEGORIES = new Set(['tech', 'question', 'moderator', 'media']);

function parseSnowflakeList(value) {
    const arr = Array.isArray(value) ? value : String(value ?? '').split(',');
    return [...new Set(
        arr.map(s => String(s).trim())
            .filter(Boolean)
            .filter(s => /^\d{17,20}$/.test(s))
    )];
}

function safeRoleIdsForGuild(roleIds, guild) {
    // guild.id == @everyone. Если он попадёт в список — мы можем "открыть" тикеты/войсы всем.
    const gId = guild?.id ? String(guild.id) : null;
    return parseSnowflakeList(roleIds).filter(id => !gId || id !== gId);
}

function getSafeModeratorRoleIds(guild) {
    return safeRoleIdsForGuild(MODERATOR_ROLE_IDS, guild);
}

function getSafePingRoleIds(guild) {
    return safeRoleIdsForGuild(PING_ROLE_IDS, guild);
}

function getTicketViewRoleIds(guild) {
    const raw = String(TICKET_VIEW_ROLE_IDS ?? '').trim();
    return safeRoleIdsForGuild(raw, guild);
}

function allowedMentionsNone() {
    return {parse: []};
}

function normalizeTicketCategory(value) {
    const category = String(value ?? '').trim().toLowerCase();
    return ALLOWED_TICKET_CATEGORIES.has(category) ? category : null;
}

function parseTicketTopic(channelOrTopic) {
    const topic = typeof channelOrTopic === 'string'
        ? channelOrTopic
        : String(channelOrTopic?.topic ?? '');

    return {
        ownerId: topic.match(/\bOWNER:(\d{17,20})\b/)?.[1] || null,
        category: normalizeTicketCategory(topic.match(/\bCATEGORY:([a-z_]+)\b/i)?.[1]),
        takenById: topic.match(/\bTAKEN_BY:(\d{17,20})\b/)?.[1] || null,
        voiceId: topic.match(/\bVOICE:(\d{17,20})\b/)?.[1] || null,
        voiceLockId: topic.match(/\bVOICE_LOCK:(\d{17,20})\b/)?.[1] || null,
        helpOpen: /\bHELP_OPEN:(?:1|true)\b/i.test(topic)
    };
}

function buildTicketTopic(state = {}) {
    const tokens = [];
    const ownerId = /^\d{17,20}$/.test(String(state.ownerId ?? '').trim()) ? String(state.ownerId).trim() : null;
    const category = normalizeTicketCategory(state.category);
    const takenById = /^\d{17,20}$/.test(String(state.takenById ?? '').trim()) ? String(state.takenById).trim() : null;
    const voiceId = /^\d{17,20}$/.test(String(state.voiceId ?? '').trim()) ? String(state.voiceId).trim() : null;
    const voiceLockId = /^\d{17,20}$/.test(String(state.voiceLockId ?? '').trim()) ? String(state.voiceLockId).trim() : null;

    if (ownerId) tokens.push(`OWNER:${ownerId}`);
    if (category) tokens.push(`CATEGORY:${category}`);
    if (takenById) tokens.push(`TAKEN_BY:${takenById}`);
    if (voiceId) tokens.push(`VOICE:${voiceId}`);
    if (state.helpOpen) tokens.push('HELP_OPEN:1');
    if (voiceLockId) tokens.push(`VOICE_LOCK:${voiceLockId}`);

    return tokens.join(' | ');
}

function extractSnowflakeFromText(value) {
    const text = String(value ?? '');
    return text.match(/<@!?(\d{17,20})>/)?.[1]
        || text.match(/\b(\d{17,20})\b/)?.[1]
        || null;
}

function getLegacyOwnerIdFromChannelName(channel) {
    return String(channel?.name ?? '').match(/^ticket-(\d{17,20})$/)?.[1] || null;
}

function getLegacyOwnerIdFromMessage(message) {
    for (const embed of message?.embeds ?? []) {
        for (const field of embed?.fields ?? []) {
            if (!/пользователь/i.test(String(field?.name ?? ''))) continue;
            const id = extractSnowflakeFromText(field?.value);
            if (id) return id;
        }
    }
    return null;
}

function getLegacyOwnerIdFromOverwrites(channel) {
    const guild = channel?.guild;
    const guildId = String(guild?.id ?? '').trim();
    const botId = String(guild?.members?.me?.id || channel?.client?.user?.id || '').trim();
    const reservedIds = new Set([
        guildId,
        botId,
        String(CURATOR_ROLE_ID ?? '').trim(),
        String(MEDIA_MANAGER_ROLE_ID ?? '').trim(),
        ...getSafeModeratorRoleIds(guild),
        ...getSafePingRoleIds(guild),
        ...getTicketViewRoleIds(guild)
    ].filter(id => /^\d{17,20}$/.test(id)));

    const memberOverwriteIds = [];
    for (const overwrite of channel?.permissionOverwrites?.cache?.values?.() ?? []) {
        const type = overwrite?.type;
        const isMemberOverwrite = type === 1 || type === 'member';
        if (!isMemberOverwrite) continue;

        const id = String(overwrite?.id ?? '').trim();
        if (!/^\d{17,20}$/.test(id) || reservedIds.has(id)) continue;
        memberOverwriteIds.push(id);
    }

    return memberOverwriteIds.length === 1 ? memberOverwriteIds[0] : null;
}

function getTicketChannelState(channel, options = {}) {
    const fromTopic = parseTicketTopic(channel);
    const legacyOwnerId = fromTopic.ownerId
        ? null
        : getLegacyOwnerIdFromChannelName(channel)
            || getLegacyOwnerIdFromMessage(options.message)
            || getLegacyOwnerIdFromOverwrites(channel);
    const needsStoredState = !fromTopic.category || (!fromTopic.ownerId && !legacyOwnerId);
    const stored = needsStoredState ? getTicketState(channel?.id) : null;
    const ownerId = stored?.ownerId || fromTopic.ownerId || legacyOwnerId;
    if (!ownerId) return null;

    return {
        ownerId,
        category: stored?.category || fromTopic.category || null,
        takenById: stored?.takenById || fromTopic.takenById || null,
        createdAt: stored?.createdAt ?? null,
        takenAt: stored?.takenAt ?? null,
        lastActive: stored?.lastActive ?? null,
        guildId: stored?.guildId || (channel?.guildId ? String(channel.guildId) : null),
        voiceId: fromTopic.voiceId,
        voiceLockId: fromTopic.voiceLockId,
        helpOpen: fromTopic.helpOpen
    };
}

function isTicketChannel(channel) {
    if (!channel) return false;
    const inTicketCategory = isInTicketCategory(channel);
    if (inTicketCategory === false) return false;
    return Boolean(getTicketChannelState(channel)?.ownerId);
}

function isInTicketCategory(channel) {
    const cat = String(TICKET_CATEGORY_ID ?? '').trim();
    if (!cat || !/^\d{17,20}$/.test(cat)) return null; // нет конфига — не делаем жёстких выводов
    return channel?.parentId === cat;
}

function isModerator(member) {
    if (!member || !member.roles) return false; // Safety check
    const ids = getSafeModeratorRoleIds(member.guild);
    if (!ids.length) return false;
    return member.roles.cache.some(r => ids.includes(r.id));
}

function isCurator(member) {
    if (!member || !member.roles) return false;
    const id = String(CURATOR_ROLE_ID ?? '').trim();
    if (!/^\d{17,20}$/.test(id)) return false;
    return member.roles.cache.has(id);
}

function isMediaManager(member) {
    if (!member || !member.roles) return false;
    const id = String(MEDIA_MANAGER_ROLE_ID ?? '').trim();
    if (!/^\d{17,20}$/.test(id)) return false;
    return member.roles.cache.has(id);
}

function isAdmin(member) {
    return Boolean(member?.permissions?.has?.(PermissionFlagsBits.Administrator));
}

async function resolveOverwriteTarget(guild, targetId) {
    const id = String(targetId ?? '').trim();
    if (!/^\d{17,20}$/.test(id)) return null;

    return guild?.members?.cache?.get(id)
        || guild?.roles?.cache?.get(id)
        || await guild?.members?.fetch?.(id).catch(() => null)
        || await guild?.roles?.fetch?.(id).catch(() => null)
        || null;
}

async function editOverwriteSafe(channel, guild, targetId, permissions) {
    const target = await resolveOverwriteTarget(guild, targetId);
    if (!target) return false;
    await channel.permissionOverwrites.edit(target, permissions);
    return true;
}

async function collectMessages(channel, opts = {}) {
    // Защита от rate-limit/памяти на больших тикетах: собираем ограниченный объём.
    const maxMessages = Number.isFinite(opts.maxMessages) ? opts.maxMessages : 2000;
    const maxChars = Number.isFinite(opts.maxChars) ? opts.maxChars : 200_000;

    let messages = [];
    let lastId;
    let total = 0;

    while (true) {
        const fetched = await channel.messages.fetch({ limit: 100, before: lastId });
        if (!fetched.size) break;

        for (const m of fetched.values()) {
            const line = `[${m.createdAt.toLocaleString()}] ${m.author.tag}: ${m.content}`;
            messages.push(line);
            total += line.length + 1;
            if (messages.length >= maxMessages || total >= maxChars) break;
        }

        if (messages.length >= maxMessages || total >= maxChars) break;
        lastId = fetched.last().id;
    }

    return messages.reverse().join("\n");
}

module.exports = {
    isModerator,
    collectMessages,
    parseSnowflakeList,
    safeRoleIdsForGuild,
    getSafeModeratorRoleIds,
    getSafePingRoleIds,
    getTicketViewRoleIds,
    isCurator,
    isMediaManager,
    isAdmin,
    resolveOverwriteTarget,
    editOverwriteSafe,
    allowedMentionsNone,
    isTicketChannel,
    parseTicketTopic,
    buildTicketTopic,
    getTicketChannelState,
    isInTicketCategory,
};
