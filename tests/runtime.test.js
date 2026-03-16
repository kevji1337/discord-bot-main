const test = require('node:test');
const assert = require('node:assert/strict');
const { normalizeEnvValue, normalizeProcessEnv, validateRuntimeEnv } = require('../utils/runtime');

test('normalizeEnvValue trims whitespace and quotes', () => {
    assert.equal(normalizeEnvValue('  "abc"  '), 'abc');
    assert.equal(normalizeEnvValue(" '123' "), '123');
});

test('normalizeProcessEnv applies boolean defaults', () => {
    const env = {
        DISCORD_TOKEN: ' token ',
        CLIENT_ID: '12345678901234567',
        GUILD_ID: '12345678901234567',
        TICKET_CATEGORY_ID: '12345678901234567',
        CURATOR_ROLE_ID: '12345678901234567',
        MEDIA_MANAGER_ROLE_ID: '12345678901234567',
        MODERATOR_ROLE_IDS: '12345678901234567'
    };
    normalizeProcessEnv(env);
    assert.equal(env.DISCORD_TOKEN, 'token');
    assert.equal(env.DM_TICKET_TRANSCRIPTS, 'false');
    assert.equal(env.DM_TICKET_FEEDBACK, 'true');
});

test('validateRuntimeEnv reports malformed snowflakes', () => {
    const env = normalizeProcessEnv({
        DISCORD_TOKEN: 'token',
        CLIENT_ID: 'bad',
        GUILD_ID: '123',
        TICKET_CATEGORY_ID: '456',
        CURATOR_ROLE_ID: '789',
        MEDIA_MANAGER_ROLE_ID: '111',
        MODERATOR_ROLE_IDS: '222'
    });
    const { errors } = validateRuntimeEnv(env);
    assert.ok(errors.some(item => item.includes('CLIENT_ID')));
    assert.ok(errors.some(item => item.includes('GUILD_ID')));
    assert.ok(errors.some(item => item.includes('MODERATOR_ROLE_IDS')));
});

test('validateRuntimeEnv requires https export URL when external export is enabled', () => {
    const env = normalizeProcessEnv({
        DISCORD_TOKEN: 'token',
        CLIENT_ID: '123456789012345678',
        GUILD_ID: '123456789012345678',
        TICKET_CATEGORY_ID: '123456789012345678',
        CURATOR_ROLE_ID: '123456789012345678',
        MEDIA_MANAGER_ROLE_ID: '123456789012345679',
        MODERATOR_ROLE_IDS: '123456789012345680',
        ENABLE_EXTERNAL_TICKET_EXPORT: 'true',
        GOOGLE_DRIVE_WEBAPP_URL: 'http://example.com'
    });
    const { errors } = validateRuntimeEnv(env);
    assert.ok(errors.some(item => item.includes('GOOGLE_DRIVE_WEBAPP_URL')));
});
