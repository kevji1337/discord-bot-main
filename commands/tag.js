const {SlashCommandBuilder, PermissionFlagsBits, MessageFlags} = require('discord.js');
const {getSnippets, addSnippet, removeSnippet} = require('../utils/db');
const {allowedMentionsNone, isCurator, isAdmin} = require('../utils/helpers');

function normalizeTagName(name) {
    const key = String(name ?? '').trim();
    // Ограничиваем длину и запрещаем опасные ключи для защиты от prototype pollution.
    if (!key || key.length > 64) return null;
    if (key === '__proto__' || key === 'prototype' || key === 'constructor') return null;
    return key;
}

module.exports = {
    data: new SlashCommandBuilder()
        .setName('tag')
        .setDescription('Управление заготовками ответов')
        .setDefaultMemberPermissions(PermissionFlagsBits.ManageMessages)
        .addSubcommand(sub =>
            sub.setName('send').setDescription('Отправить заготовку')
                .addStringOption(opt => opt.setName('name').setDescription('Название тега').setRequired(true).setAutocomplete(true))
        )
        .addSubcommand(sub =>
            sub.setName('create').setDescription('Создать заготовку')
                .addStringOption(opt => opt.setName('name').setDescription('Название').setRequired(true))
                .addStringOption(opt => opt.setName('content').setDescription('Текст').setRequired(true))
        )
        .addSubcommand(sub =>
            sub.setName('delete').setDescription('Удалить заготовку')
                .addStringOption(opt => opt.setName('name').setDescription('Название').setRequired(true).setAutocomplete(true))
        )
        .addSubcommand(sub => sub.setName('list').setDescription('Список всех заготовок')),

    async autocomplete(interaction) {
        const focusedValue = interaction.options.getFocused();
        const snippets = getSnippets();
        const choices = Object.keys(snippets);
        const filtered = choices.filter(choice => choice.startsWith(focusedValue)).slice(0, 25);
        await interaction.respond(filtered.map(choice => ({name: choice, value: choice})));
    },

    async execute(interaction) {
        if (!interaction.member.permissions.has(PermissionFlagsBits.ManageMessages) && !isCurator(interaction.member) && !isAdmin(interaction.member)) {
            return interaction.reply({content: '❌ Нет прав.', flags: MessageFlags.Ephemeral});
        }

        const sub = interaction.options.getSubcommand();
        const snippets = getSnippets();

        if (sub === 'create') {
            const nameRaw = interaction.options.getString('name');
            const content = interaction.options.getString('content');
            const name = normalizeTagName(nameRaw);
            if (!name) return interaction.reply({
                content: '❌ Некорректное имя тега (до 64 символов).',
                flags: MessageFlags.Ephemeral
            });
            try {
                addSnippet(name, content);
            } catch (e) {
                return interaction.reply({content: '❌ Не удалось сохранить тег.', flags: MessageFlags.Ephemeral});
            }
            return interaction.reply({content: `✅ Тег **${name}** создан.`, flags: MessageFlags.Ephemeral});
        }

        if (sub === 'delete') {
            const nameRaw = interaction.options.getString('name');
            const name = normalizeTagName(nameRaw);
            if (!name) return interaction.reply({content: '❌ Некорректное имя тега.', flags: MessageFlags.Ephemeral});
            if (!snippets[name]) return interaction.reply({content: '❌ Тег не найден.', flags: MessageFlags.Ephemeral});
            try {
                removeSnippet(name);
            } catch (e) {
                return interaction.reply({content: '❌ Не удалось удалить тег.', flags: MessageFlags.Ephemeral});
            }
            return interaction.reply({content: `🗑️ Тег **${name}** удален.`, flags: MessageFlags.Ephemeral});
        }

        if (sub === 'list') {
            const list = Object.keys(snippets).map(k => `\`${k}\``).join(', ') || "Нет тегов";
            return interaction.reply({content: `📂 **Список тегов:**\n${list}`, flags: MessageFlags.Ephemeral});
        }

        if (sub === 'send') {
            const nameRaw = interaction.options.getString('name');
            const name = normalizeTagName(nameRaw);
            if (!name || !snippets[name]) return interaction.reply({content: '❌ Тег не найден.', flags: MessageFlags.Ephemeral});
            // Защита от массовых упоминаний (@everyone/@here/ролей) через контент тега.
            return interaction.reply({content: String(snippets[name]), allowedMentions: allowedMentionsNone()});
        }
    }
};
