const { pgPool, selectQuery, insertQuery, updateQuery, ConfirmationStatus } = require("./utils/db_utils");
const { HearManager } = require("@vk-io/hear");
const { PhotoAttachment, VideoAttachment, WallAttachment, DocumentAttachment } = require("vk-io");

const noLinks = { dont_parse_links: true };
const noPreview = { disable_web_page_preview: true };

const VkBot = (vk, telegram) => {
    const setTgId = async (ctx) => {
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

        /* Вызываем следующий обработчик */
        ctx.tgId = tgId;
        ctx.vkId = vkId;
        return next();
    }

    const uploadPhoto = async (ctx, photo) => {
        /* Пробуем переслать фото в TG */
        await vk.api.messages.markAsRead({ peer_id: ctx.vkId });
        return telegram.sendPhoto(ctx.tgId, photo.largeSizeUrl, { caption: ctx.text });
    }

    const uploadVideo = async (ctx, video) => {
        /* Пробуем переслать видео в TG */
        await vk.api.messages.markAsRead({ peer_id: ctx.vkId });
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

    const unsupportedMessageHandler = (ctx) => {
        return ctx.reply("Этот тип сообщения не поддерживается :(");
    }

    const forwardMessage = async (ctx) => {
        /* Если есть вложения, то разбираем и пересылаем их */
        //console.log(ctx.attachments);
        for (const attachment of (ctx.attachments ?? [])) {
            switch (attachment.type) {
                case "photo":
                    return uploadPhoto(ctx, attachment);
                case "video":
                    //return uploadVideo(ctx, new VideoAttachment({ api: vk.api, payload: attachment.video }));
                    return uploadVideo(ctx, attachment);
                case "link":
                    /*
                    await telegram.sendMessage(
                        ctx.tgId,
                        `URL: ${attachment.link.url}\nTITLE: ${attachment.link.title}`,
                        Extra.notifications(false),
                    );*/
                    break;
                case "sticker":
                    /*
                    const stickerUrl = attachment.sticker.photo_256 || attachment.sticker.images[2];
                    if (!stickerUrl) {
                        await telegram.sendMessage(
                            ctx.tgId,
                            'Error. Something wrong with this sticker...',
                            Extra.notifications(false),
                        );
                        break;
                    }

                    const converter = sharp()
                        .webp()
                        .toFormat('webp');

                    const converterStream = request(stickerUrl)
                        .on('error', e => console.error(e))
                        .pipe(converter);

                    await telegram.sendDocument(
                        ctx.tgId,
                        {
                            source: converterStream,
                            filename: 'sticker.webp',
                        },
                        Extra.notifications(false),
                    );*/
                    break;
                case "doc":
                    /*
                    const doc = new DocumentAttachment(attachment.doc, vk);
                    if (doc.isVoice()) {
                        await telegram.sendVoice(
                            ctx.tgId,
                            doc.getPreview().audio_msg.link_ogg,
                            Extra.notifications(false),
                        );
                    } else {
                        await telegram.sendDocument(
                            ctx.tgId,
                            doc.getUrl(),
                            Extra.notifications(false),
                        )
                            .catch((err) => {
                                console.error(err);
                                return telegram.sendMessage(
                                    ctx.tgId,
                                    "Error. Can't upload document",
                                    Extra.notifications(false),
                                );
                            });
                    }*/
                    break;
                default:
                    return unsupportedMessageHandler(ctx);
            }
        }

        /* Если вложений нет, но есть текст, пробуем его переслать в TG */
        if (ctx.text) {
            await vk.api.messages.markAsRead({ peer_id: ctx.vkId }); // иначе сообщение отображается как непрочитанное
            return telegram.sendMessage(ctx.tgId, ctx.text)
                /*.catch(async (error) => {
                const chat = await telegram.getChat(ctx.tgId);
                await ctx.send(`Бот попытался переслать сообщение в чат с пользователем https://t.me/${chat.username}, но не смог :(`);
                return ctx.send("Возможно, id указан неверно или у вас нет переписки с нашим ботом в TG (https://t.me/fwd2vk_bot)");
            })*/;
        }

    }

    const flattenAndForwardMessage = async (ctx) => {
        /* Рекурсивно пересылаем все пересланные сообщения (те, на которые ссылается данное сообщение из VK) */
        await forwardMessage(ctx);
        for (const fwdCtx of ctx.forwards) {
            fwdCtx.vkId = ctx.vkId;
            fwdCtx.tgId = ctx.tgId;
            console.log(fwdCtx.senderId);
            //const [user] = await vk.api.users.get({ user_ids: [fwdCtx.senderId] });
            const from = `⬇ От vk.com/${fwdCtx.senderId > 0 ? "id" + fwdCtx.senderId : "club" + -fwdCtx.senderId} ⬇`
            await telegram.sendMessage(fwdCtx.tgId, from, noPreview);
            await flattenAndForwardMessage(fwdCtx);
        }
    };

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