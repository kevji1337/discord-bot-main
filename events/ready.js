const {Events, PermissionFlagsBits} = require('discord.js');
const {getTicketsMeta, removeTicketMeta, removeTicketState} = require('../utils/db');
const {isTicketChannel, getTicketChannelState, allowedMentionsNone} = require('../utils/helpers');
const {runStartupSelfCheck} = require('../utils/runtime');
const discordTranscripts = require('discord-html-transcripts');
const {LOG_CHANNEL_ID} = process.env;

let autoCloseInFlight = false;

function getTranscriptLimit() {
    const raw = process.env.TRANSCRIPT_LIMIT;
    if (raw === undefined) return 2000;
    const n = Number(raw);
    if (!Number.isFinite(n)) return 2000;
    return n;
}

function shouldSaveTranscriptImages() {
    return String(process.env.TRANSCRIPT_SAVE_IMAGES ?? '').trim().toLowerCase() === 'true';
}

module.exports = {
    name: Events.ClientReady,
    once: true,
    async execute(client) {
        console.log(`🤖 Бот запущен как ${client.user.tag}`);
        await runStartupSelfCheck(client);

        // AUTO-CLOSE LOOP (Runs every 1 hour)
        const interval = setInterval(async () => {
            if (autoCloseInFlight) return;
            autoCloseInFlight = true;
            console.log("🔄 Running Auto-Close Check...");
            try {
                const tickets = getTicketsMeta();
                const now = Date.now();
                const ONE_DAY = 24 * 60 * 60 * 1000;
                const TWO_DAYS = 48 * 60 * 60 * 1000;

                for (const [channelId, lastActive] of Object.entries(tickets)) {
                    try {
                        const channel = await client.channels.fetch(channelId).catch(() => null);
                        if (!channel) {
                            removeTicketMeta(channelId);
                            removeTicketState(channelId);
                            continue;
                        }

                        // Никогда не трогаем не-тикеты даже если в JSON попал "левый" channelId
                        if (!isTicketChannel(channel)) {
                            removeTicketMeta(channelId);
                            removeTicketState(channelId);
                            continue;
                        }
                        const ticketCategoryId = String(process.env.TICKET_CATEGORY_ID ?? '').trim();
                        if (/^\d{17,20}$/.test(ticketCategoryId) && String(channel.parentId ?? '') !== ticketCategoryId) {
                            removeTicketMeta(channelId);
                            removeTicketState(channelId);
                            continue;
                        }

                        const diff = now - lastActive;

                        // Warn after 24h
                        if (diff > ONE_DAY && diff < ONE_DAY + (60 * 60 * 1000)) { // 1 hour window to avoid spam
                            await channel.send({
                                content: "⚠️ **Тикет неактивен 24 часа.** Если ответа не будет, он закроется автоматически.",
                                allowedMentions: allowedMentionsNone()
                            });
                        }

                        // Close after 48h
                        if (diff > TWO_DAYS) {
                            await channel.send({
                                content: "🛑 **Автоматическое закрытие из-за неактивности.**",
                                allowedMentions: allowedMentionsNone()
                            });

                            // LOGGING (Simplified version of close-ticket logic)
                            let attachment = null;
                            try {
                                attachment = await discordTranscripts.createTranscript(channel, {
                                    limit: getTranscriptLimit(),
                                    returnType: 'attachment',
                                    filename: `${channel.name}-autoclose.html`,
                                    saveImages: shouldSaveTranscriptImages(),
                                    poweredBy: false,
                                    footerText: "Exported by Troxill Bot"
                                });
                            } catch (e) {
                                console.error("Auto-close transcript error:", e?.message || e);
                            }

                            const logChannel = LOG_CHANNEL_ID
                                ? await client.channels.fetch(LOG_CHANNEL_ID).catch(() => null)
                                : null;
                            if (logChannel) {
                                await logChannel.send({
                                    content: `🔒 Auto-closed ticket: ${channel.name}`,
                                    files: attachment ? [attachment] : [],
                                    allowedMentions: allowedMentionsNone()
                                });
                            }

                            // Удаляем связанный voice (если был создан), иначе он "зависает" после автозакрытия
                            try {
                                const ticket = getTicketChannelState(channel);
                                const ownerId = ticket?.ownerId;
                                const voices = [];

                                if (ticket?.voiceId) {
                                    const voiceId = ticket.voiceId;
                                    const v = await channel.guild.channels.fetch(voiceId).catch(() => null);
                                    if (v) voices.push(v);
                                }

                                if (ownerId) {
                                    const catId = String(process.env.TICKET_CATEGORY_ID ?? '').trim();
                                    for (const c of channel.guild.channels.cache.values()) {
                                        if (
                                            c &&
                                            c.type === 2 &&
                                            String(c.parentId ?? '') === catId &&
                                            c.permissionOverwrites?.cache?.get(ownerId)?.allow?.has(PermissionFlagsBits.ViewChannel)
                                        ) {
                                            voices.push(c);
                                        }
                                    }
                                }

                                const unique = new Map();
                                for (const v of voices) {
                                    if (v && v.id) unique.set(v.id, v);
                                }

                                for (const v of unique.values()) {
                                    try {
                                        await v.delete();
                                    } catch { /* noop */
                                    }
                                }
                            } catch (e) {
                                console.error("Auto-close voice delete error:", e?.message || e);
                            }

                            await channel.delete();
                            removeTicketMeta(channelId);
                            removeTicketState(channelId);
                        }

                    } catch (e) {
                        console.error(`Auto-close error for ${channelId}:`, e.message);
                    }
                }
            } finally {
                autoCloseInFlight = false;
            }
        }, 60 * 60 * 1000); // 1 hour
        interval.unref?.();
    },
};
