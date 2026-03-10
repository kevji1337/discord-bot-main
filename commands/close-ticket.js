const {
    SlashCommandBuilder,
    EmbedBuilder,
    ActionRowBuilder,
    ButtonBuilder,
    ButtonStyle,
    PermissionFlagsBits
} = require("discord.js");
const {
    isModerator,
    isCurator,
    isAdmin,
    collectMessages,
    allowedMentionsNone,
    ticketOwnerIdFromChannel
} = require("../utils/helpers");
const {removeTicketMeta, removeTicketState, getTicketState, addStaffAction} = require("../utils/db");
const discordTranscripts = require('discord-html-transcripts');
const { GOOGLE_DRIVE_WEBAPP_URL, LOG_CHANNEL_ID } = process.env;

function getTranscriptLimit() {
    // Безопасный дефолт, чтобы не упираться в лимиты/память. Для полного лога задайте TRANSCRIPT_LIMIT=-1 в env.
    const raw = process.env.TRANSCRIPT_LIMIT;
    if (raw === undefined) return 2000;
    const n = Number(raw);
    if (!Number.isFinite(n)) return 2000;
    return n;
}

function shouldSaveTranscriptImages() {
    return String(process.env.TRANSCRIPT_SAVE_IMAGES ?? '').trim().toLowerCase() === 'true';
}

function isExternalExportEnabled() {
    return String(process.env.ENABLE_EXTERNAL_TICKET_EXPORT ?? '').trim().toLowerCase() === 'true';
}

function buildFeedbackRow(ticketId, staffId) {
    const values = [1, 2, 3, 4, 5];
    const styles = [ButtonStyle.Danger, ButtonStyle.Secondary, ButtonStyle.Primary, ButtonStyle.Success, ButtonStyle.Success];
    const row = new ActionRowBuilder();

    values.forEach((rating, index) => {
        row.addComponents(
            new ButtonBuilder()
                .setCustomId(`rate:${ticketId}:${staffId}:${rating}`)
                .setLabel(String(rating))
                .setStyle(styles[index])
        );
    });

    return row;
}

async function postJsonWithTimeout(url, payload, timeoutMs = 15000) {
    const u = String(url ?? '').trim();
    if (!u) return {skipped: true, reason: 'missing_url'};
    if (!/^https:\/\//i.test(u)) return {skipped: true, reason: 'non_https_url'};

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    try {
        const res = await fetch(u, {
            method: "POST",
            headers: {"Content-Type": "application/json"},
            body: JSON.stringify(payload),
            signal: controller.signal
        });
        return {ok: res.ok, status: res.status};
    } finally {
        clearTimeout(timeout);
    }
}

module.exports = {
    data: new SlashCommandBuilder()
        .setName("close-ticket")
        .setDescription("Закрыть тикет"),
    async execute(interaction) {
        await interaction.deferReply({ ephemeral: true });

        if (!isModerator(interaction.member) && !isCurator(interaction.member) && !isAdmin(interaction.member))
            return interaction.editReply("❌ Нет прав");

        const channel = interaction.channel;
        if (!channel.name.startsWith("ticket-"))
            return interaction.editReply("❌ Это не тикет");

        // Защита от удаления "чужих" каналов при переименовании: если категория тикетов настроена — требуем совпадение.
        const ticketCategoryId = String(process.env.TICKET_CATEGORY_ID ?? '').trim();
        if (/^\d{17,20}$/.test(ticketCategoryId) && String(channel.parentId ?? '') !== ticketCategoryId) {
            return interaction.editReply("❌ Этот канал не находится в категории тикетов. Закрытие отменено.");
        }

        const ticket = getTicketState(channel.id);
        const ticketOwnerId = ticket?.ownerId || ticketOwnerIdFromChannel(channel) || channel.name.replace("ticket-", "");

        // 1. Generate Transcript
        let attachment = null;
        try {
            attachment = await discordTranscripts.createTranscript(channel, {
                limit: getTranscriptLimit(),
                returnType: 'attachment',
                filename: `${channel.name}.html`,
                saveImages: shouldSaveTranscriptImages(),
                footerText: "Exported by Troxill Bot",
                poweredBy: false
            });
        } catch (e) {
            console.error("Transcript error:", e?.message || e);
        }

        // 2. DM User with Transcript (Feature 9)
        try {
            const ticketOwner = await channel.guild.members.fetch(ticketOwnerId).catch(() => null);
            if (ticketOwner) {
                await ticketOwner.send({
                    content: `🔒 **Ваш тикет был закрыт.**\nКопия переписки во вложении.`,
                    files: attachment ? [attachment] : []
                }).catch(e => console.log("Could not DM user transcript:", e.message));

                // Reuse Feedback Logic here?
                // The original code had feedback logic below. merging workflow.
                // Original: interaction.client.users.cache.get(...) -> Send feedback buttons
                // We can combine: Send Transcript AND Feedback in one or separate messages.
                // Original code logic below does specific feedback sending.
                // I will leave original feedback logic alone, but ensure attachment is sent.
                // Ideally send attachment first, then feedback.
            }
        } catch (e) {
            console.error("DM Transcript error:", e);
        }

        // 3. Log to Discord (Log Channel)
        const logChannel = interaction.guild.channels.cache.get(LOG_CHANNEL_ID) ||
            interaction.guild.channels.cache.find(c => c.name === "ticket-logs");

        if (logChannel) {
            const logEmbed = new EmbedBuilder()
                .setTitle("📝 Тикет закрыт")
                .addFields(
                    { name: "Тикет", value: channel.name, inline: true },
                    { name: "Закрыл", value: interaction.user.tag, inline: true },
                    {name: "Автор", value: ticketOwnerId ? `<@${ticketOwnerId}>` : 'Неизвестно', inline: true}
                )
                .setColor(0xe74c3c)
                .setTimestamp();

            await logChannel.send({
                embeds: [logEmbed],
                files: attachment ? [attachment] : [],
                allowedMentions: allowedMentionsNone()
            });
        } else {
            console.error("❌ Log channel not found (set LOG_CHANNEL_ID or create #ticket-logs)");
        }

        // 3. Google Drive (Legacy/Backup)
        if (isExternalExportEnabled()) {
            try {
                const log = await collectMessages(channel, {maxMessages: 2000, maxChars: 200_000});
                const payload = {
                    action: "close_ticket",
                    ticketChannel: channel.name,
                    ticketId: channel.id,
                    closedBy: interaction.user.tag,
                    closedById: interaction.user.id,
                    createdById: ticketOwnerId,
                    guildId: interaction.guild.id,
                    logContent: log
                };
                // Не блокируем закрытие тикета, но делаем корректный таймаут/abort.
                postJsonWithTimeout(GOOGLE_DRIVE_WEBAPP_URL, payload, 15000)
                    .catch(e => console.error("GDrive Error:", e?.message || e));
            } catch (err) { /* noop */
            }
        }

        // 4. Feedback Request (DM)
        const userId = ticketOwnerId;
        if (userId) try {
            const user = await interaction.guild.members.fetch(userId);
            if (user) {
                const feedbackEmbed = new EmbedBuilder()
                    .setTitle("⭐ Оцените качество поддержки")
                    .setDescription("Ваш тикет был закрыт. Пожалуйста, оцените работу модератора.")
                    .setColor(0xf1c40f);

                const row = buildFeedbackRow(channel.id, interaction.user.id);
                await user.send({
                    embeds: [feedbackEmbed],
                    components: [row],
                    allowedMentions: allowedMentionsNone()
                }).catch(() => {
                });
            }
        } catch (e) {
            console.log("Could not DM user for feedback");
        }

        await interaction.editReply("✅ Тикет закрыт, лог сохранен, отзыв запрошен.");
        // 4. Delete Linked Voice Channel(s)
        const voiceMatch = channel.topic?.match(/VOICE:(\d{17,20})/);
        try {
            const catId = String(process.env.TICKET_CATEGORY_ID ?? '').trim();
            const expectedName = `Voice-${ticketOwnerId}`;
            const voices = [];

            if (voiceMatch) {
                const v = await channel.guild.channels.fetch(voiceMatch[1]).catch(() => null);
                if (v) voices.push(v);
            }

            for (const c of channel.guild.channels.cache.values()) {
                if (
                    c &&
                    c.type === 2 &&
                    String(c.parentId ?? '') === catId &&
                    (
                        c.name === expectedName ||
                        c.permissionOverwrites?.cache?.get(ticketOwnerId)?.allow?.has(PermissionFlagsBits.ViewChannel)
                    )
                ) {
                    voices.push(c);
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
            console.error("Failed to delete voice:", e?.message || e);
        }

        // 5. Delete Ticket Channel
        removeTicketMeta(channel.id);
        removeTicketState(channel.id);
        addStaffAction(interaction.user.id, 'close');
        setTimeout(() => channel.delete().catch(() => { }), 5000);
    }
};
