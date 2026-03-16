const { SlashCommandBuilder } = require("discord.js");

module.exports = {
    data: new SlashCommandBuilder()
        .setName("java")
        .setDescription("Java для использования Troxill Product"),
    async execute(interaction) {
        return interaction.reply({
            content: `**Java для использования Troxill Product**\n\n**Java 21 (для версии 1.21+)**\nhttps://drive.google.com/file/d/1puv5qNHUZgczztWqmgmgIMdenoWW2cB4/view?usp=sharing\n\n**Инструкция по установке:**\n1. Распакуйте папку \`jdk-21\` в каталог \`C:\\Program Files\\Java\`.\n2. Если папок \`Program Files\` или \`Java\` нет, создайте их вручную.\n3. Папка \`jdk-21\` должна находиться внутри \`C:\\Program Files\\Java\`. Удалять существующие файлы не требуется.\n4. Откройте лаунчер и перейдите в настройки игры.\n5. Найдите пункт выбора Java и нажмите «Настроить».\n6. Укажите путь к Java: \`C:\\Program Files\\Java\\jdk-21\\bin\\javaw.exe\`.\n7. После сохранения настроек запустите Minecraft и продолжите настройку продукта.`
        });
    }
};
