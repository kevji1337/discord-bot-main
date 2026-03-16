const { ChannelType, PermissionFlagsBits } = require('discord.js');

const REQUIRED_STRING_KEYS = ['DISCORD_TOKEN'];
const REQUIRED_SNOWFLAKE_KEYS = ['CLIENT_ID', 'GUILD_ID', 'TICKET_CATEGORY_ID', 'CURATOR_ROLE_ID', 'MEDIA_MANAGER_ROLE_ID'];
const REQUIRED_SNOWFLAKE_LIST_KEYS = ['MODERATOR_ROLE_IDS'];
const OPTIONAL_SNOWFLAKE_KEYS = ['LOG_CHANNEL_ID', 'TICKET_PANEL_OWNER_ID', 'STATUS_PANEL_OWNER_ID'];
const OPTIONAL_SNOWFLAKE_LIST_KEYS = ['PING_ROLE_IDS', 'TICKET_VIEW_ROLE_IDS'];
const BOOLEAN_DEFAULTS = {
    ENABLE_EXTERNAL_TICKET_EXPORT: 'false',
    TRANSCRIPT_SAVE_IMAGES: 'false',
    DM_TICKET_TRANSCRIPTS: 'false',
    DM_TICKET_FEEDBACK: 'true'
};
const INTEGER_DEFAULTS = {
    TRANSCRIPT_LIMIT: '2000'
};

function normalizeEnvValue(value) {
    return String(value ?? '')
        .trim()
        .replace(/^['"]+|['"]+$/g, '');
}

function isSnowflake(value) {
    return /^\d{17,20}$/.test(String(value ?? '').trim());
}

function parseSnowflakeList(value) {
    return [...new Set(
        String(value ?? '')
            .split(',')
            .map(item => normalizeEnvValue(item))
            .filter(Boolean)
            .filter(isSnowflake)
    )];
}

function normalizeProcessEnv(env = process.env) {
    const normalized = env;
    const keys = new Set([
        ...REQUIRED_STRING_KEYS,
        ...REQUIRED_SNOWFLAKE_KEYS,
        ...REQUIRED_SNOWFLAKE_LIST_KEYS,
        ...OPTIONAL_SNOWFLAKE_KEYS,
        ...OPTIONAL_SNOWFLAKE_LIST_KEYS,
        ...Object.keys(BOOLEAN_DEFAULTS),
        ...Object.keys(INTEGER_DEFAULTS),
        'GOOGLE_DRIVE_WEBAPP_URL'
    ]);

    for (const key of keys) {
        const raw = normalized[key];
        if (raw !== undefined) normalized[key] = normalizeEnvValue(raw);
    }

    for (const [key, value] of Object.entries(BOOLEAN_DEFAULTS)) {
        if (!normalized[key]) normalized[key] = value;
    }
    for (const [key, value] of Object.entries(INTEGER_DEFAULTS)) {
        if (!normalized[key]) normalized[key] = value;
    }

    return normalized;
}

function validateRuntimeEnv(env = process.env) {
    const errors = [];
    const warnings = [];

    for (const key of REQUIRED_STRING_KEYS) {
        if (!normalizeEnvValue(env[key])) {
            errors.push(`${key} is required`);
        }
    }

    for (const key of REQUIRED_SNOWFLAKE_KEYS) {
        if (!isSnowflake(env[key])) {
            errors.push(`${key} must be a Discord snowflake`);
        }
    }

    for (const key of REQUIRED_SNOWFLAKE_LIST_KEYS) {
        if (!parseSnowflakeList(env[key]).length) {
            errors.push(`${key} must contain at least one Discord role ID`);
        }
    }

    for (const key of OPTIONAL_SNOWFLAKE_KEYS) {
        if (env[key] && !isSnowflake(env[key])) {
            errors.push(`${key} must be a Discord snowflake when set`);
        }
    }

    for (const key of OPTIONAL_SNOWFLAKE_LIST_KEYS) {
        const raw = normalizeEnvValue(env[key]);
        if (raw && !parseSnowflakeList(raw).length) {
            errors.push(`${key} contains no valid Discord IDs`);
        }
    }

    const transcriptLimit = Number(env.TRANSCRIPT_LIMIT);
    if (!Number.isFinite(transcriptLimit)) {
        errors.push('TRANSCRIPT_LIMIT must be a number');
    }

    const exportEnabled = normalizeEnvValue(env.ENABLE_EXTERNAL_TICKET_EXPORT).toLowerCase() === 'true';
    if (exportEnabled) {
        const url = normalizeEnvValue(env.GOOGLE_DRIVE_WEBAPP_URL);
        if (!/^https:\/\//i.test(url)) {
            errors.push('GOOGLE_DRIVE_WEBAPP_URL must be https when ENABLE_EXTERNAL_TICKET_EXPORT=true');
        }
    }

    if (!parseSnowflakeList(env.PING_ROLE_IDS).length) {
        warnings.push('PING_ROLE_IDS is empty, ticket pings will be disabled');
    }
    if (!normalizeEnvValue(env.LOG_CHANNEL_ID)) {
        warnings.push('LOG_CHANNEL_ID is empty, ticket close logs will be skipped');
    }
    if (normalizeEnvValue(env.DM_TICKET_TRANSCRIPTS).toLowerCase() === 'true') {
        warnings.push('DM_TICKET_TRANSCRIPTS=true increases privacy exposure for ticket transcripts');
    }
    if (normalizeEnvValue(env.TRANSCRIPT_SAVE_IMAGES).toLowerCase() === 'true') {
        warnings.push('TRANSCRIPT_SAVE_IMAGES=true stores third-party media in transcripts');
    }

    return { errors, warnings };
}

function failFastOnInvalidEnv(env = process.env) {
    normalizeProcessEnv(env);
    const { errors, warnings } = validateRuntimeEnv(env);
    for (const warning of warnings) {
        console.warn(`⚠️ ${warning}`);
    }
    if (!errors.length) return;
    for (const error of errors) {
        console.error(`❌ ${error}`);
    }
    process.exit(1);
}

async function fetchRole(guild, roleId) {
    if (!isSnowflake(roleId)) return null;
    return guild.roles.cache.get(roleId) || guild.roles.fetch(roleId).catch(() => null);
}

async function fetchChannel(guild, channelId) {
    if (!isSnowflake(channelId)) return null;
    return guild.channels.cache.get(channelId) || guild.channels.fetch(channelId).catch(() => null);
}

async function runStartupSelfCheck(client) {
    const guildId = normalizeEnvValue(process.env.GUILD_ID);
    const guild = client.guilds.cache.get(guildId) || await client.guilds.fetch(guildId).catch(() => null);
    if (!guild) {
        console.error(`❌ Startup self-check failed: guild ${guildId} not found`);
        return;
    }

    const botMember = guild.members.me || await guild.members.fetchMe().catch(() => null);
    if (!botMember) {
        console.error('❌ Startup self-check failed: bot member not found in target guild');
        return;
    }

    const category = await fetchChannel(guild, process.env.TICKET_CATEGORY_ID);
    if (!category || category.type !== ChannelType.GuildCategory) {
        console.error('❌ TICKET_CATEGORY_ID does not point to an existing category channel');
    } else {
        const permissions = category.permissionsFor(botMember);
        const requiredPermissions = [
            PermissionFlagsBits.ViewChannel,
            PermissionFlagsBits.SendMessages,
            PermissionFlagsBits.ReadMessageHistory,
            PermissionFlagsBits.ManageChannels,
            PermissionFlagsBits.ManageMessages
        ];
        const missing = requiredPermissions.filter(permission => !permissions?.has(permission));
        if (missing.length) {
            console.error(`❌ Missing bot permissions in ticket category: ${missing.map(permission => permission.toString()).join(', ')}`);
        }
    }

    const logChannelId = normalizeEnvValue(process.env.LOG_CHANNEL_ID);
    if (logChannelId) {
        const logChannel = await fetchChannel(guild, logChannelId);
        if (!logChannel || !logChannel.isTextBased?.()) {
            console.error('❌ LOG_CHANNEL_ID does not point to a text channel');
        }
    }

    const roleChecks = [
        ...parseSnowflakeList(process.env.MODERATOR_ROLE_IDS),
        ...parseSnowflakeList(process.env.PING_ROLE_IDS),
        ...parseSnowflakeList(process.env.TICKET_VIEW_ROLE_IDS),
        normalizeEnvValue(process.env.CURATOR_ROLE_ID),
        normalizeEnvValue(process.env.MEDIA_MANAGER_ROLE_ID)
    ].filter(Boolean);

    for (const roleId of new Set(roleChecks)) {
        const role = await fetchRole(guild, roleId);
        if (!role) {
            console.error(`❌ Role ${roleId} from env does not exist in guild ${guild.name}`);
        }
    }

    const userChecks = [
        normalizeEnvValue(process.env.TICKET_PANEL_OWNER_ID),
        normalizeEnvValue(process.env.STATUS_PANEL_OWNER_ID)
    ].filter(Boolean);
    for (const userId of userChecks) {
        const member = await guild.members.fetch(userId).catch(() => null);
        if (!member) {
            console.warn(`⚠️ Configured owner ${userId} is not a member of guild ${guild.name}`);
        }
    }
}

module.exports = {
    normalizeEnvValue,
    normalizeProcessEnv,
    validateRuntimeEnv,
    failFastOnInvalidEnv,
    parseSnowflakeList,
    isSnowflake,
    runStartupSelfCheck
};
