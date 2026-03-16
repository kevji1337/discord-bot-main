const {SlashCommandBuilder, PermissionFlagsBits, MessageFlags} = require('discord.js');
const {isCurator, isAdmin} = require('../utils/helpers');
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
        if (!interaction.member.permissions.has(PermissionFlagsBits.BanMembers) && !isCurator(interaction.member) && !isAdmin(interaction.member)) {
            return interaction.reply({content: '❌ Нет прав.', flags: MessageFlags.Ephemeral});
        }

        const sub = interaction.options.getSubcommand();
        const user = interaction.options.getUser('user');

        if (sub === 'add') {
            banUser(user.id);
            return interaction.reply({
                content: `🚫 Пользователь ${user} заблокирован в системе тикетов.`,
                flags: MessageFlags.Ephemeral
            });
        }

        if (sub === 'remove') {
            unbanUser(user.id);
            return interaction.reply({content: `✅ Пользователь ${user} разблокирован.`, flags: MessageFlags.Ephemeral});
        }
    }
};
