const {MODERATOR_ROLE_IDS, PING_ROLE_IDS, TICKET_CATEGORY_ID, TICKET_VIEW_ROLE_IDS} = process.env;
const {PermissionFlagsBits} = require('discord.js');

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

function isTicketChannel(channel) {
    return Boolean(channel && channel.name && channel.name.startsWith('ticket-'));
}

function ticketOwnerIdFromChannel(channel) {
    if (!isTicketChannel(channel)) return null;
    const id = String(channel.name).slice('ticket-'.length);
    return /^\d{17,20}$/.test(id) ? id : null;
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
    isAdmin,
    allowedMentionsNone,
    isTicketChannel,
    ticketOwnerIdFromChannel,
    isInTicketCategory,
};
