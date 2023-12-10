const { message } = require("telegraf/filters");
const { pgPool, selectQuery, insertQuery, updateQuery, ConfirmationStatus } = require("./utils/db_utils");

class TgBot {
    #telegraf;

    constructor(telegraf, vk) {
        telegraf.command("set_vk_id", async (ctx) => {
            /* Проверяем, что команда вызвана с правильными аргументами */
            const args = ctx.message.text.split(" ");
            if (args.length !== 2 || isNaN(parseInt(args[1]))) {
                await ctx.reply("У команды /set_vk_id должен быть один параметр - ваш id в VK (просто число, без префикса id).");
                return ctx.replyWithMarkdownV2("Например: `/set_vk_id 12345678`");
            }

            /* Достаем запись о пользователе по его tg_id */
            const vkId = args[1];
            const tgId = ctx.message.from.id.toString();
            const select = await pgPool.query(selectQuery, [vkId, tgId]);
            const row = select.rows[0];
            const status = row?.status;
            const id = row?.id;

            /* Если в базе уже есть пользователь с таким id в VK, сообщаем об этом */
            const vkIdMatches = row?.vk_id.toString() === vkId;
            const tgIdMatches = row?.tg_id.toString() === tgId;
            if ((select.rowCount > 1) || (!tgIdMatches && vkIdMatches)) {
                await ctx.reply("Упс... Этот VK id связан с id другого пользователя TG!");
                await ctx.reply("Если вы уверены, что VK id - верный, возможно, вы ошиблись, когда указывали TG id боту в VK");
                await ctx.reply("Попробуйте отправить боту в VK (https://vk.me/fwd2tg_bot) команду:");
                return ctx.replyWithMarkdownV2("`/set_tg_id " + tgId + "`");
            }

            /* Если запись в базе подтверждена и изменений нет, то ничего не делаем */
            if (status === ConfirmationStatus.CONFIRMED && vkIdMatches) {
                return ctx.reply("Ваш аккаунт уже связан с этим VK id. Можно пересылать сообщения!");
            }

            /* Если ожидалось подтверждение от бота в TG и изменения нет, то подтверждаем запись */
            if (status === ConfirmationStatus.WAIT_TG && vkIdMatches) {
                await pgPool.query(updateQuery, [vkId, tgId, ConfirmationStatus.CONFIRMED, id]);
                await ctx.reply("Ваш id в VK установлен!");
                await ctx.reply(`Бот будет пересылать сообщения сюда: https://vk.com/id${vkId}`);
                await vk.api.messages.send({ user_id: vkId, random_id: 0, message: "Ваш id в TG установлен!" });
                return vk.api.messages.send({
                    user_id: vkId,
                    random_id: 0,
                    message: `Бот будет пересылать сообщения сюда: https://t.me/${ctx.message.from.username}`
                });
            }

            /* Запрашиваем подтверждение от бота в VK (кроме случая, когда оно уже было запрошено с таким же id) */
            if (!(status === ConfirmationStatus.WAIT_VK && vkIdMatches)) {
                if (row) {
                    await pgPool.query(updateQuery, [vkId, tgId, ConfirmationStatus.WAIT_VK, id]);
                } else {
                    await pgPool.query(insertQuery, [vkId, tgId, ConfirmationStatus.WAIT_VK]);
                }
            }
            await ctx.reply("Для подтверждения, откройте бота в VK (https://vk.me/fwd2tg_bot) и отправьте ему команду:");
            return ctx.replyWithMarkdownV2("`/set_tg_id " + tgId + "`");
        });

        telegraf.on(message("text"), async ctx => {
            /* Достаем запись о пользователе по его tg_id */
            const tgId = ctx.message.from.id
            const select = await pgPool.query(selectQuery, [0, tgId]);
            const row = select.rows[0];

            /* Если пользователь ранее не указал свой vk_id, то записи о нём в БД нет */
            if (!row) {
                await ctx.reply("Бот не знает, куда переслать сообщение - укажите ему свой id в VK");
                return ctx.replyWithMarkdownV2("Например: `/set_vk_id 12345678`");
            }

            /* Если ожидается подтверждение от бота в VK */
            if (row.status === ConfirmationStatus.WAIT_VK) {
                ctx.reply("Ваш id в VK пока не подтвержден");
                await ctx.reply("Для подтверждения, откройте бота в VK (https://vk.me/fwd2tg_bot) и отправьте ему команду:");
                return ctx.replyWithMarkdownV2("`/set_tg_id " + tgId + "`");
            }

            /* Если ожидается подтверждение от бота в TG */
            if (row.status === ConfirmationStatus.WAIT_TG) {
                await ctx.reply("Ваш id в VK пока не подтвержден");
                return ctx.reply("Для подтверждения, выполните команду, которую вам отправил бот в VK (https://vk.me/fwd2tg_bot)");
            }

            /* Пробуем переслать сообщение в VK */
            const vkId = row.vk_id;
            return vk.api.messages.send({
                user_id: vkId,
                random_id: 0,
                message: ctx.message.text
            }).catch(async (error) => {
                await ctx.reply(`Бот попытался переслать сообщение в чат с пользователем https://vk.com/id${vkId}, но не смог :(`);
                return ctx.reply("Возможно, id указан неверно или у вас нет переписки с нашим ботом в VK.");
            });
        });

        this.#telegraf = telegraf;
    }

    handleUpdate(update) {
        return this.#telegraf.handleUpdate(update);
    }
}

module.exports = { TgBot };