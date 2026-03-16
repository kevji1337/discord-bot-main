const {Events} = require('discord.js');
const {updateTicketActivity} = require('../utils/db');
const {
    isInTicketCategory,
    allowedMentionsNone,
    isCurator,
    isAdmin,
    isModerator,
    getTicketChannelState
} = require('../utils/helpers');

const noticeCooldown = new Map();
function hitCooldown(key, ms) {
    const now = Date.now();
    const last = noticeCooldown.get(key) || 0;
    if (now - last < ms) return true;
    noticeCooldown.set(key, now);
    return false;
}

module.exports = {
    name: Events.MessageCreate,
    async execute(message) {
        if (message.author.bot) return;

        // Надёжность авто-закрытия: активность считаем по реальным сообщениям в тикетах.
        const ticket = getTicketChannelState(message.channel);
        if (ticket?.ownerId) {
            if (isInTicketCategory(message.channel) === false) return;
            const ticketNotTaken = !ticket?.takenById;
            const memberCanBypassPreTakeLock = isCurator(message.member) || isAdmin(message.member);
            const isTicketOwner = ticket.ownerId === message.author.id;
            const isTicketTaker = ticket.takenById === message.author.id;

            if (ticketNotTaken && isTicketOwner) {
                await message.delete().catch(() => {
                });
                if (!hitCooldown(`blocked:${message.channelId}:${message.author.id}`, 15_000)) {
                    const notice = await message.channel.send({
                        content: "⏳ Писать в тикет можно только после того, как его возьмёт администратор или модератор.",
                        allowedMentions: allowedMentionsNone()
                    }).catch(() => null);
                    if (notice) {
                        setTimeout(() => notice.delete().catch(() => {
                        }), 5000);
                    }
                }
                return;
            }

            if (ticketNotTaken && !memberCanBypassPreTakeLock) {
                await message.delete().catch(() => {
                });
                if (!hitCooldown(`pretake:${message.channelId}:${message.author.id}`, 15_000)) {
                    const notice = await message.channel.send({
                        content: "⏳ Отвечать в тикете можно только после нажатия кнопки «Взять тикет».",
                        allowedMentions: allowedMentionsNone()
                    }).catch(() => null);
                    if (notice) {
                        setTimeout(() => notice.delete().catch(() => {
                        }), 5000);
                    }
                }
                return;
            }

            if (!ticketNotTaken) {
                const helpAccess = ticket.helpOpen && isModerator(message.member);
                const canWrite = isTicketOwner || isTicketTaker || memberCanBypassPreTakeLock || helpAccess;
                if (!canWrite) {
                    await message.delete().catch(() => {
                    });
                    if (!hitCooldown(`taken:${message.channelId}:${message.author.id}`, 15_000)) {
                        const notice = await message.channel.send({
                            content: "⏳ В этом тикете может отвечать только автор, взявший тикет модератор или куратор. Для остальных сначала нужен вызов помощи.",
                            allowedMentions: allowedMentionsNone()
                        }).catch(() => null);
                        if (notice) {
                            setTimeout(() => notice.delete().catch(() => {
                            }), 5000);
                        }
                    }
                    return;
                }
            }
            updateTicketActivity(message.channel.id);
        }
    },
};
