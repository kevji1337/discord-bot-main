const {Events} = require('discord.js');
const {getTicketState, updateTicketActivity} = require('../utils/db');
const {isTicketChannel, ticketOwnerIdFromChannel, allowedMentionsNone} = require('../utils/helpers');

const javaCooldown = new Map(); // key -> timestamp
function hitCooldown(key, ms) {
    const now = Date.now();
    const last = javaCooldown.get(key) || 0;
    if (now - last < ms) return true;
    javaCooldown.set(key, now);
    return false;
}

module.exports = {
    name: Events.MessageCreate,
    async execute(message) {
        if (message.author.bot) return;

        // Надёжность авто-закрытия: активность считаем по реальным сообщениям в тикетах.
        if (isTicketChannel(message.channel)) {
            const ticket = getTicketState(message.channel.id) || {
                ownerId: ticketOwnerIdFromChannel(message.channel),
                takenById: message.channel.topic?.match(/TAKEN_BY:(\d{17,20})/)?.[1] || null
            };
            if (ticket?.ownerId === message.author.id && !ticket.takenById) {
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
            updateTicketActivity(message.channel.id);
        }

        const content = message.content.toLowerCase();

        // Java Auto-Response
        // Matches: "java", "джава", "скачать джаву", "какую джаву"
        if (content.includes("java") || content.includes("джава") || content.includes("джаву")) {
            // Check context usually, but user asked for simple target
            if (content.includes("скачать") || content.includes("где") || content.includes("какую") || content.includes("net") || content.includes("нет")) {
                // Анти-спам: не отвечаем чаще 1 раза в 60с на канал и 1 раза в 120с на пользователя.
                if (hitCooldown(`c:${message.channelId}`, 60_000) || hitCooldown(`u:${message.author.id}`, 120_000)) return;
                await message.reply({
                    content: "☕ **Вот ссылка на скачивание Java:**\nhttps://drive.google.com/file/d/1puv5qNHUZgczztWqmgmgIMdenoWW2cB4/view?usp=sharing",
                    allowedMentions: allowedMentionsNone()
                });

            }
        }
    },
};
