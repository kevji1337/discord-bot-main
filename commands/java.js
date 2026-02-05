const { SlashCommandBuilder } = require("discord.js");

module.exports = {
    data: new SlashCommandBuilder()
        .setName("java")
        .setDescription("Java для использования Troxill Product"),
    async execute(interaction) {
        return interaction.reply({
            content: `☕ **Java для использования Troxill Product**\n\n**Java 21 (Для 1.21+)**\nhttps://drive.google.com/file/d/1puv5qNHUZgczztWqmgmgIMdenoWW2cB4/view?usp=sharing`,
            ephemeral: false
        });
    }
};
