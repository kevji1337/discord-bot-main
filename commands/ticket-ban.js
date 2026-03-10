const {SlashCommandBuilder, PermissionFlagsBits} = require('discord.js');
const {isAdmin} = require('../utils/helpers');
const {getBannedUsers, banUser, unbanUser} = require('../utils/db');

module.exports = {
    data: new SlashCommandBuilder()
        .setName('ticket-ban')
        .setDescription('Бан пользователя в системе тикетов')
        .setDefaultMemberPermissions(PermissionFlagsBits.BanMembers)
        .addSubcommand(sub =>
            sub.setName('add').setDescription('Забанить пользователя')
                .addUserOption(opt => opt.setName('user').setDescription('Пользователь').setRequired(true))
        )
        .addSubcommand(sub =>
            sub.setName('remove').setDescription('Разбанить пользователя')
                .addUserOption(opt => opt.setName('user').setDescription('Пользователь').setRequired(true))
        ),
    async execute(interaction) {
        if (!interaction.member.permissions.has(PermissionFlagsBits.BanMembers) && !isAdmin(interaction.member)) {
            return interaction.reply({content: '❌ Нет прав.', ephemeral: true});
        }

        const sub = interaction.options.getSubcommand();
        const user = interaction.options.getUser('user');

        if (sub === 'add') {
            banUser(user.id);
            return interaction.reply({
                content: `🚫 Пользователь ${user} заблокирован в системе тикетов.`,
                ephemeral: true
            });
        }

        if (sub === 'remove') {
            unbanUser(user.id);
            return interaction.reply({content: `✅ Пользователь ${user} разблокирован.`, ephemeral: true});
        }
    }
};
