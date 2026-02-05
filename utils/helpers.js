const { MODERATOR_ROLE_IDS } = process.env;

const MODERATOR_ROLES = MODERATOR_ROLE_IDS ? MODERATOR_ROLE_IDS.split(",") : [];

function isModerator(member) {
    return member.roles.cache.some(r => MODERATOR_ROLES.includes(r.id));
}

async function collectMessages(channel) {
    let messages = [];
    let lastId;

    while (true) {
        const fetched = await channel.messages.fetch({ limit: 100, before: lastId });
        if (!fetched.size) break;

        fetched.forEach(m => {
            messages.push(
                `[${m.createdAt.toLocaleString()}] ${m.author.tag}: ${m.content}`
            );
        });

        lastId = fetched.last().id;
    }

    return messages.reverse().join("\n");
}

module.exports = { isModerator, collectMessages, MODERATOR_ROLES };
