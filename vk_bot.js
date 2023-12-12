const { pgPool, selectQuery, insertQuery, updateQuery, ConfirmationStatus } = require("./utils/db_utils");
const { HearManager } = require("@vk-io/hear");

const noLinks = { dont_parse_links: true };
const noPreview = { disable_web_page_preview: true };
const MAX_UPLOAD_SIZE = 50_000_000;

const VkBot = (vk, telegram) => {
    const setTgId = async (ctx) => {
        /* Проверяем, что команда вызвана с правильными аргументами */
        const args = ctx.text.split(" ");
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
            await ctx.send("Попробуйте отправить боту в TG (https://t.me/fwd2vk_bot) команду:", noLinks);
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
        await ctx.send("Для подтверждения, откройте бота в TG (https://t.me/fwd2vk_bot) и отправьте ему команду:", noLinks);
        return ctx.send(`/set_vk_id ${vkId}`);
    }

    const checkPairing = async (ctx, next) => {
        console.time("checkPairing");
        /* Достаем запись о пользователе по его vk_id */
        const vkId = ctx.peerId;
        const select = await pgPool.query(selectQuery, [vkId, 0]);
        const row = select.rows[0];
        const tgId = row?.tg_id;

        /* Если пользователь ранее не указал свой tg_id, то записи о нём в БД нет */
        if (!row) {
            await ctx.send("Бот не знает, куда переслать сообщение - укажите ему свой id в TG");
            return ctx.send("Например: /set_tg_id 12345678");
        }

        /* Если ожидается подтверждение от бота в VK */
        if (row.status === ConfirmationStatus.WAIT_VK) {
            await ctx.send("Ваш id в TG пока не подтвержден");
            return ctx.send("Для подтверждения, выполните команду, которую вам отправил бот в TG (https://t.me/fwd2vk_bot)", noLinks);
        }

        /* Если ожидается подтверждение от бота в TG */
        if (row.status === ConfirmationStatus.WAIT_TG) {
            ctx.send("Ваш id в TG пока не подтвержден");
            await ctx.send("Для подтверждения, откройте бота в TG (https://t.me/fwd2vk_bot) и отправьте ему команду:", noLinks);
            return ctx.send(`/set_vk_id ${vkId}`);
        }

        /* Помечаем сообщение прочитанным */
        await vk.api.messages.markAsRead({ peer_id: vkId });

        /* Вызываем следующий обработчик */
        ctx.tgId = tgId;
        ctx.vkId = vkId;
        console.timeEnd("checkPairing");
        return next();
    }

    const uploadDocument = async (ctx, document, extra) => {
        /* Проверяем, что документ не слишком большой */
        if (document.size > MAX_UPLOAD_SIZE) {
            await ctx.reply("К сожалению, этот файл слишком большой 😔");
            return ctx.reply("Текущая версия Telegram Bot API запрещает ботам загружать файлы весом больше 50 Мб")
        }

        /* Пробуем переслать файл в TG */
        return telegram.sendDocument(ctx.tgId, document.url, extra).catch((error) => tgSendErrorHandler(ctx, error));
    }

    const uploadPhoto = async (ctx, photo, extra) => {
        /* Пробуем переслать фото в TG */
        return telegram.sendPhoto(ctx.tgId, photo.largeSizeUrl, extra).catch((error) => tgSendErrorHandler(ctx, error));
    }

    const uploadVideo = async (ctx, video, extra) => {
        /* Пробуем переслать видео в TG */
        return ctx.send(JSON.stringify(video));
        /*
        const url = await vk.api.video.get({
            videos: video.toString(),
        });

        const text = wall
            ? `Video from wall: ${video.items[0].player}`
            : `Video: ${video.items[0].player}`;
        await telegram.sendMessage(ctx.tgId, text, Extra.notifications(false));*/
    }

    const uploadAudio = async (ctx, audio, extra) => {
        /* Пробуем переслать аудио в TG */
        return telegram.sendAudio(ctx.tgId, audio.url, { performer: audio.artist, title: audio.title })
            .catch((error) => tgSendErrorHandler(ctx, error));
    }

    const uploadVoice = async (ctx, voice) => {
        /* Пробуем переслать гс в TG */
        return telegram.sendVoice(ctx.tgId, voice.oggUrl).catch((error) => tgSendErrorHandler(ctx, error));
    }

    const uploadSticker = async (ctx, sticker) => {
        /* Не все стикеры можно скачать */
        if (!sticker.images?.length) {
            return unsupportedMessageHandler(ctx);
        }

        /* Пробуем переслать стикер в TG */
        return telegram.sendPhoto(ctx.tgId, sticker.images.pop().url).catch((error) => tgSendErrorHandler(ctx, error));
    }

    const uploadGraffiti = async (ctx, graffiti) => {
        /* Пробуем переслать граффити в TG */
        return telegram.sendPhoto(ctx.tgId, graffiti.url).catch((error) => tgSendErrorHandler(ctx, error));
    }

    const forwardMessage = async (ctx) => {
        console.time("forwardMessage");
        /* Если есть вложения, то разбираем и пересылаем их */
        let extra = { caption: ctx.text };
        for (const attachment of (ctx.attachments ?? [])) {
            switch (attachment.type) {
                case "doc":
                    await uploadDocument(ctx, attachment, extra);
                    extra = {};
                    break;
                case "photo":
                    await uploadPhoto(ctx, attachment, extra);
                    extra = {};
                    break;
                case "video":
                    await uploadVideo(ctx, attachment, extra); // TODO
                    extra = {};
                    break;
                case "audio":
                    await uploadAudio(ctx, attachment, extra);
                    extra = {};
                    break;
                case "audio_message":
                    await uploadVoice(ctx, attachment);
                    extra = {};
                    break;
                case "sticker":
                    await uploadSticker(ctx, attachment);
                    break;
                case "graffiti":
                    await uploadGraffiti(ctx, attachment);
                    break;
                case "link":
                    break;
                default:
                    await unsupportedMessageHandler(ctx);
            }
        }

        /* Если есть текст и он не был вставлен как подпись, пробуем его переслать в TG */
        if (extra.caption && ctx.text) {
            return telegram.sendMessage(ctx.tgId, ctx.text).catch((error) => tgSendErrorHandler(ctx, error));
        }
        console.timeEnd("forwardMessage");
    }

    const flattenAndForwardMessage = async (ctx) => {
        /* Рекурсивно пересылаем все пересланные сообщения (те, на которые ссылается данное сообщение из VK) */
        await forwardMessage(ctx);
        for (const fwdCtx of ctx.forwards) {
            fwdCtx.vkId = ctx.vkId;
            fwdCtx.tgId = ctx.tgId;
            const from = `⬇ От vk.com/${fwdCtx.senderId > 0 ? "id" + fwdCtx.senderId : "club" + -fwdCtx.senderId} ⬇`
            await telegram.sendMessage(fwdCtx.tgId, from, noPreview).catch((error) => tgSendErrorHandler(ctx, error));
            await flattenAndForwardMessage(fwdCtx);
        }
    };

    const tgSendErrorHandler = async (ctx, error) => {
        console.log(error);
        const chat = await telegram.getChat(ctx.tgId);
        if (chat) {
            await ctx.send(`Бот попытался переслать сообщение в чат с пользователем https://t.me/${chat.username}, но не смог 😔`);
        } else {
            await ctx.send(`Бот попытался переслать сообщение пользователю с TG id ${ctx.tgId}, но не смог найти с ним чат 😔`);
        }
        return ctx.send("Возможно, id указан неверно или у вас нет переписки с нашим ботом в TG (https://t.me/fwd2vk_bot)");
    }

    const unsupportedMessageHandler = (ctx) => {
        return ctx.send("❌ Этот тип сообщения не поддерживается");
    }

    const hearManager = new HearManager();
    hearManager.hear(/\/set_tg_id.*/, setTgId);

    vk.updates.use(hearManager.middleware);
    vk.updates.use(checkPairing);
    vk.updates.use(flattenAndForwardMessage);

    const handleUpdate = (update) => {
        return vk.updates.handleWebhookUpdate(update);
    }

    return { handleUpdate };
}

module.exports = { VkBot };