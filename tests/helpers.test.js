const test = require('node:test');
const assert = require('node:assert/strict');
const { buildTicketTopic, parseTicketTopic, getTicketChannelState } = require('../utils/helpers');

test('buildTicketTopic emits stable ticket metadata tokens', () => {
    const topic = buildTicketTopic({
        ownerId: '123456789012345678',
        category: 'tech',
        takenById: '223456789012345678',
        voiceId: '323456789012345678',
        helpOpen: true,
        voiceLockId: '423456789012345678'
    });

    assert.equal(
        topic,
        'OWNER:123456789012345678 | CATEGORY:tech | TAKEN_BY:223456789012345678 | VOICE:323456789012345678 | HELP_OPEN:1 | VOICE_LOCK:423456789012345678'
    );
});

test('parseTicketTopic extracts structured state from topic text', () => {
    const state = parseTicketTopic('OWNER:123456789012345678 | CATEGORY:media | TAKEN_BY:223456789012345678 | HELP_OPEN:1');
    assert.deepEqual(state, {
        ownerId: '123456789012345678',
        category: 'media',
        takenById: '223456789012345678',
        voiceId: null,
        voiceLockId: null,
        helpOpen: true
    });
});

test('parseTicketTopic ignores invalid category tokens', () => {
    const state = parseTicketTopic('OWNER:123456789012345678 | CATEGORY:invalid');
    assert.equal(state.ownerId, '123456789012345678');
    assert.equal(state.category, null);
});

test('getTicketChannelState reconstructs state from topic tokens', () => {
    const state = getTicketChannelState({
        id: '523456789012345678',
        guildId: '623456789012345678',
        topic: 'OWNER:123456789012345678 | CATEGORY:question | TAKEN_BY:223456789012345678 | HELP_OPEN:1'
    });

    assert.deepEqual(state, {
        ownerId: '123456789012345678',
        category: 'question',
        takenById: '223456789012345678',
        createdAt: null,
        takenAt: null,
        lastActive: null,
        guildId: '623456789012345678',
        voiceId: null,
        voiceLockId: null,
        helpOpen: true
    });
});

test('getTicketChannelState falls back to legacy ticket channel name', () => {
    const state = getTicketChannelState({
        id: '723456789012345678',
        guildId: '623456789012345678',
        name: 'ticket-123456789012345678',
        topic: ''
    });

    assert.equal(state.ownerId, '123456789012345678');
    assert.equal(state.category, null);
});

test('getTicketChannelState can recover owner from legacy embed field', () => {
    const state = getTicketChannelState({
        id: '823456789012345678',
        guildId: '623456789012345678',
        name: 'legacy-ticket',
        topic: ''
    }, {
        message: {
            embeds: [{
                fields: [{
                    name: 'Пользователь',
                    value: '<@923456789012345678> (legacyuser)'
                }]
            }]
        }
    });

    assert.equal(state.ownerId, '923456789012345678');
});
