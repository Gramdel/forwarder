const { HearManager } = require("@vk-io/hear");
const { pgPool, selectQuery, insertQuery, updateQuery, ConfirmationStatus } = require("./utils/db_utils");
const { VkUtils } = require("./utils/vk_utils");

class VkBot {
    #vk;

    constructor(vk, telegram) {
        const hearManager = new HearManager();

        VkUtils.flattenFwdMessages([]);

        hearManager.hear(new RegExp("/set_tg_id.*"), async (ctx) => {
            /* Проверяем, что команда вызвана с правильными аргументами */
            const args = ctx.message.text.split(" ");
            if (args.length !== 2 || isNaN(parseInt(args[1]))) {
                await ctx.send("У команды /set_tg_id должен быть один параметр - ваш id в TG (число, не username).");
                return ctx.send("Например: /set_tg_id 12345678");
            }

            /* Достаем запись о пользователе по его vk_id */
            const vkId = ctx.peerId.toString();
            const tgId = args[1];
            const select = await pgPool.query(selectQuery, [vkId, tgId]);
            const row = select.rows[0];
            const status = row?.status;
            const id = row?.id;

            /* Если в базе уже есть пользователь с таким id в TG, сообщаем об этом */
            const vkIdMatches = row?.vk_id.toString() === vkId;
            const tgIdMatches = row?.tg_id.toString() === tgId;
            if ((select.rowCount > 1) || (!vkIdMatches && tgIdMatches)) {
                await ctx.send("Упс... Этот TG id связан с id другого пользователя VK!");
                await ctx.send("Если вы уверены, что TG id - верный, возможно, вы ошиблись, когда указывали VK id боту в TG");
                await ctx.send("Попробуйте отправить боту в TG (https://t.me/fwd2vk_bot) команду:");
                return ctx.send(`/set_vk_id ${vkId}`);
            }

            /* Если запись в базе подтверждена и изменений нет, то ничего не делаем */
            if (status === ConfirmationStatus.CONFIRMED && tgIdMatches) {
                return ctx.send("Ваш аккаунт уже связан с этим TG id. Можно пересылать сообщения!");
            }

            /* Если ожидалось подтверждение от бота в VK и изменения нет, то подтверждаем запись */
            if (status === ConfirmationStatus.WAIT_VK && tgIdMatches) {
                const chat = await telegram.getChat(tgId);
                await pgPool.query(updateQuery, [vkId, tgId, ConfirmationStatus.CONFIRMED, id]);
                await ctx.send("Ваш id в TG установлен!");
                await ctx.send(`Бот будет пересылать сообщения сюда: https://t.me/${chat.username}`);
                await telegram.sendMessage(tgId, "Ваш id в VK установлен!")
                return telegram.sendMessage(tgId, `Бот будет пересылать сообщения сюда: https://vk.com/id${vkId}`);
            }

            /* Запрашиваем подтверждение от бота в TG (кроме случая, когда оно уже было запрошено с таким же id) */
            if (!(status === ConfirmationStatus.WAIT_TG && tgIdMatches)) {
                if (row) {
                    await pgPool.query(updateQuery, [vkId, tgId, ConfirmationStatus.WAIT_TG, id]);
                } else {
                    await pgPool.query(insertQuery, [vkId, tgId, ConfirmationStatus.WAIT_TG]);
                }
            }
            await ctx.send("Для подтверждения, откройте бота в TG (https://t.me/fwd2vk_bot) и отправьте ему команду:");
            return ctx.send(`/set_vk_id ${vkId}`);
        });

        hearManager.hear(new RegExp(".*"), async (ctx) => {
            /* Достаем запись о пользователе по его vk_id */
            const vkId = ctx.peerId;
            const select = await pgPool.query(selectQuery, [vkId, 0]);
            const row = select.rows[0];

            /* Если пользователь ранее не указал свой tg_id, то записи о нём в БД нет */
            if (!row) {
                await ctx.send("Бот не знает, куда переслать сообщение - укажите ему свой id в TG");
                return ctx.send("Например: /set_tg_id 12345678");
            }

            /* Если ожидается подтверждение от бота в VK */
            if (row.status === ConfirmationStatus.WAIT_VK) {
                await ctx.send("Ваш id в TG пока не подтвержден");
                return ctx.send("Для подтверждения, выполните команду, которую вам отправил бот в TG (https://t.me/fwd2vk_bot)");
            }

            /* Если ожидается подтверждение от бота в TG */
            if (row.status === ConfirmationStatus.WAIT_TG) {
                ctx.send("Ваш id в TG пока не подтвержден");
                await ctx.send("Для подтверждения, откройте бота в TG (https://t.me/fwd2vk_bot) и отправьте ему команду:");
                return ctx.send(`/set_vk_id ${vkId}`);
            }

            /* Пробуем переслать сообщение в TG */
            const tgId = row.tg_id;
            await vk.api.messages.markAsRead({ peer_id: ctx.peerId }); // иначе сообщение отображается как непрочитанное
            return telegram.sendMessage(tgId, ctx.message.text).catch(async (error) => {
                const chat = await telegram.getChat(tgId);
                await ctx.reply(`Бот попытался переслать сообщение в чат с пользователем https://t.me/${chat.username}, но не смог :(`);
                return ctx.reply("Возможно, id указан неверно или у вас нет переписки с нашим ботом в TG.");
            });
        });

        vk.updates.on("message_new", hearManager.middleware);
        this.#vk = vk;
    }

    handleUpdate(update) {
        return this.#vk.updates.handleWebhookUpdate(update);
    }
}

module.exports = { VkBot };