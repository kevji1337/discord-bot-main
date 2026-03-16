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

function getTicketChannelState(channel) {
    const stored = getTicketState(channel?.id);
    const fromTopic = parseTicketTopic(channel);
    const ownerId = stored?.ownerId || fromTopic.ownerId;
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
    allowedMentionsNone,
    isTicketChannel,
    parseTicketTopic,
    buildTicketTopic,
    getTicketChannelState,
    isInTicketCategory,
};
