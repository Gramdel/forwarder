const { pgPool, selectQuery, deleteQuery, insertQuery, updateQuery, ConfirmationStatus } = require("./utils/db_utils");

const noLinks = { dont_parse_links: true };
const noPreview = { disable_web_page_preview: true };
const MAX_DOWNLOAD_SIZE = 20_000_000;

const TgBot = (telegraf, vk) => {
    const start = async (ctx) => {
        /* Проверяем, что команда вызвана с правильными аргументами */
        const args = ctx.message.text.split(" ");
        if (args.length !== 1) {
            return ctx.reply("❌ У команды /start не должно быть параметров");
        }

        await ctx.reply(
            "Привет! 👋 Этот бот умеет пересылать видео, \"кружки\", аудио, гс, фото, " +
            "стикеры (кроме анимированных), текст и файлы из Telegram в VK. " +
            "Единственное ограничение - размер каждого пересылаемого файла (в т.ч. видео) не больше 20 Мб."
        );
        await ctx.reply(
            "Для пересылки используется парный бот в VK (https://vk.me/fwd2tg_bot). " +
            "Всё, что вы отправите боту в TG, бот в VK отправит вам в личные сообщения! 😉",
            noPreview
        );
        await ctx.replyWithMarkdownV2(
            "Чтобы начать работу, боту нужно узнать ваш id в VK\\. Укажите его: `/set_vk_id 12345678` " +
            "\\(обязательно вводить именно так, числом\\)\\."
        );
        return ctx.reply("Если вы хотите посмотреть список команд, вызовите команду /help");
    }

    const help = async (ctx) => {
        /* Проверяем, что команда вызвана с правильными аргументами */
        const args = ctx.message.text.split(" ");
        if (args.length !== 1) {
            return ctx.reply("❌ У команды /help не должно быть параметров");
        }

        return ctx.reply(
            "Список поддерживаемых команд:\n\n" +
            "    /help - вывести данное сообщение (список команд)\n\n" +
            "    /start - вывести приветственное сообщение\n\n" +
            "    /set_vk_id id - установить id вашего аккаунта в VK; id должно быть числом\n\n" +
            "    /delete_info - удалить из бота информацию о ваших TG и VK"
        );
    }

    const setVkId = async (ctx) => {
        /* Проверяем, что команда вызвана с правильными аргументами */
        const args = ctx.message.text.split(" ");
        if (args.length !== 2 || isNaN(parseInt(args[1]))) {
            await ctx.reply("❌ У команды /set_vk_id должен быть один параметр - ваш id в VK (просто число, без префикса id)");
            return ctx.replyWithMarkdownV2("Например: `/set_vk_id 12345678`");
        }
        const vkId = args[1];
        const tgId = ctx.message.from.id.toString();

        try {
            /* Достаем запись о пользователе */
            const select = await pgPool.query(selectQuery, [vkId, tgId]);
            const row = select.rows[0];
            const status = row?.status;
            const id = row?.id;

            /* Если в базе уже есть пользователь с таким id в VK, сообщаем об этом */
            const vkIdMatches = row?.vk_id.toString() === vkId;
            const tgIdMatches = row?.tg_id.toString() === tgId;
            if ((select.rowCount > 1) || (!tgIdMatches && vkIdMatches)) {
                await ctx.reply("Упс... ⛔ Этот VK id связан с id другого пользователя TG!");
                await ctx.reply("Если вы уверены, что VK id - верный, возможно, вы ошиблись, когда указывали TG id боту в VK? 🤔");
                await ctx.reply("Попробуйте отправить боту в VK (https://vk.me/fwd2tg_bot) команду:", noPreview);
                return ctx.replyWithMarkdownV2("`/set_tg_id " + tgId + "`");
            }

            /* Если запись в базе подтверждена и изменений нет, то ничего не делаем */
            if (status === ConfirmationStatus.CONFIRMED && vkIdMatches) {
                return ctx.reply("Ваш аккаунт уже связан с этим VK id. Можно пересылать сообщения! 😉");
            }

            /* Если ожидалось подтверждение от бота в TG и изменения нет, то подтверждаем запись */
            if (status === ConfirmationStatus.WAIT_TG && vkIdMatches) {
                await pgPool.query(updateQuery, [vkId, tgId, ConfirmationStatus.CONFIRMED, id]);
                await ctx.reply("Ваш id в VK установлен! ✅");
                await ctx.reply(`Бот будет пересылать сообщения сюда: https://vk.com/id${vkId}`);
                await vk.api.messages.send({ user_id: vkId, random_id: 0, message: "Ваш id в TG установлен! ✅" });
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
            await ctx.reply("Для подтверждения, откройте бота в VK (https://vk.me/fwd2tg_bot) и отправьте ему команду:", noPreview);
            return ctx.replyWithMarkdownV2("`/set_tg_id " + tgId + "`");
        } catch (error) {
            return dbErrorHandler(ctx, error);
        }
    }

    const deleteInfo = async (ctx) => {
        /* Проверяем, что команда вызвана с правильными аргументами */
        const args = ctx.message.text.split(" ");
        if (args.length !== 1) {
            return ctx.reply("❌ У команды /delete_info не должно быть параметров");
        }

        try {
            /* Удаляем запись о пользователе по его tg_id */
            const tgId = ctx.message.from.id;
            await pgPool.query(deleteQuery, [0, tgId]);
            return ctx.reply("Данные успешно стерты! ✅");
        } catch (error) {
            return dbErrorHandler(ctx, error);
        }
    }

    const checkPairing = async (ctx, next) => {
        try {
            /* Достаем запись о пользователе по его tg_id */
            const tgId = ctx.message.from.id
            const select = await pgPool.query(selectQuery, [0, tgId]);
            const row = select.rows[0];
            const vkId = row?.vk_id;

            /* Если пользователь ранее не указал свой vk_id, то записи о нём в БД нет */
            if (!row) {
                await ctx.reply("❌ Бот не знает, куда переслать сообщение - укажите ему свой id в VK");
                return ctx.replyWithMarkdownV2("Например: `/set_vk_id 12345678`");
            }

            /* Если ожидается подтверждение от бота в VK */
            if (row.status === ConfirmationStatus.WAIT_VK) {
                ctx.reply("❌ Ваш id в VK пока не подтвержден");
                await ctx.reply("Для подтверждения, откройте бота в VK (https://vk.me/fwd2tg_bot) и отправьте ему команду:", noPreview);
                return ctx.replyWithMarkdownV2("`/set_tg_id " + tgId + "`");
            }

            /* Если ожидается подтверждение от бота в TG */
            if (row.status === ConfirmationStatus.WAIT_TG) {
                await ctx.reply("❌ Ваш id в VK пока не подтвержден");
                return ctx.reply("Для подтверждения, выполните команду, которую вам отправил бот в VK (https://vk.me/fwd2tg_bot)", noPreview);
            }

            /* Вызываем следующий обработчик */
            ctx.tgId = tgId;
            ctx.vkId = vkId;
            return next();
        } catch (error) {
            return dbErrorHandler(ctx, error);
        }
    }

    const uploadPhoto = async (ctx, next) => {
        /* Получаем ссылку для загрузки из TG */
        const photo = ctx.message.photo.pop()
        const url = await ctx.telegram.getFileLink(photo);

        /* Загружаем фото и вызываем следующий обработчик */
        ctx.attachment = await vk.upload.messagePhoto({
            source: {
                value: url.toString()
            }
        });
        ctx.message.text = ctx.message.caption ?? "";
        return next();
    }

    const uploadVoice = async (ctx, next) => {
        /* Получаем ссылку для загрузки из TG */
        const voice = ctx.message.voice;
        const url = await ctx.telegram.getFileLink(voice);

        /* Загружаем гс и вызываем следующий обработчик */
        ctx.attachment = await vk.upload.audioMessage({
            source: {
                value: url.toString()
            },
            peer_id: ctx.vkId
        });
        ctx.message.text = "";
        return next();
    }

    const uploadSticker = async (ctx, next) => {
        /* Анимированные стикеры не поддерживаются */
        if (ctx.message.sticker.is_animated) {
            return unsupportedMessageHandler(ctx);
        }

        /* Получаем ссылку для загрузки из TG */
        const sticker = ctx.message.sticker;
        const url = await ctx.telegram.getFileLink(sticker);

        /* Загружаем стикер и вызываем следующий обработчик */
        ctx.attachment = await vk.upload.messagePhoto({
            source: {
                value: url.toString()
            },
        });
        ctx.message.text = ctx.message.caption ?? "";
        return next();
    }

    const uploadDocument = async (ctx, next) => {
        /* Проверяем, что документ не слишком большой и получаем на него ссылку */
        const document = ctx.message.document ?? ctx.message.video ?? ctx.message.video_note ?? ctx.message.audio ?? ctx.message.animation;
        if (document.file_size > MAX_DOWNLOAD_SIZE) {
            await ctx.reply("К сожалению, этот файл слишком большой 😔");
            return ctx.reply("Текущая версия Telegram Bot API запрещает ботам скачивать файлы весом больше 20 Мб")
        }
        const url = await ctx.telegram.getFileLink(document);

        /* Изменяем расширение для аудио */
        if (ctx.message.audio && document.file_name.match(/.+\.(mp3|m4a)$/)) {
            document.file_name += ".audio";
        }

        /* Устанавливаем имя для кружка */
        if (ctx.message.video_note) {
            document.file_name += document.file_unique_id + ".mp4";
        }

        /* Загружаем файл и вызываем следующий обработчик */
        ctx.attachment = await vk.upload.messageDocument({
            source: {
                value: url.toString(),
                filename: document.file_name
            },
            peer_id: ctx.vkId
        });
        ctx.message.text = ctx.message.caption ?? "";
        return next();
    }

    const forwardMessage = async (ctx) => {
        /* Пробуем переслать сообщение в VK */
        const attachment = ctx.attachment;
        if (ctx.message.forward_from || ctx.message.forward_from_chat) {
            await vk.api.messages.send({
                user_id: ctx.vkId,
                random_id: 0,
                message: `⬇ От t.me/${(ctx.message.forward_from ?? ctx.message.forward_from_chat).username} ⬇`,
                ...noLinks
            }).catch((error) => vkSendErrorHandler(ctx, error));
        }
        return vk.api.messages.send({
            user_id: ctx.vkId,
            random_id: 0,
            message: ctx.message.text,
            attachment
        }).catch((error) => vkSendErrorHandler(ctx, error));
    }

    const dbErrorHandler = async (ctx, error) => {
        console.log(error);
        await ctx.reply("Возникла проблема при подключении к базе данных 😬");
        return ctx.reply("Попробуйте позже!");
    }

    const vkSendErrorHandler = async (ctx, error) => {
        console.log(error);
        await ctx.reply(`Бот попытался переслать сообщение в чат с пользователем https://vk.com/id${ctx.vkId}, но не смог 😔`);
        return ctx.reply("Возможно, id указан неверно или у вас нет переписки с нашим ботом в VK (https://vk.me/fwd2tg_bot)");
    }

    const unsupportedMessageHandler = (ctx) => {
        return ctx.reply("❌ Этот тип сообщения не поддерживается");
    }

    telegraf.command("start", start);
    telegraf.command("help", help);
    telegraf.command("set_vk_id", setVkId);
    telegraf.command("delete_info", deleteInfo);
    telegraf.use(checkPairing);
    telegraf.on("voice", uploadVoice);
    telegraf.on("photo", uploadPhoto);
    telegraf.on("sticker", uploadSticker);
    telegraf.on(["document", "video", "video_note", "audio", "animation"], uploadDocument);
    telegraf.on("text", forwardMessage);
    telegraf.use(unsupportedMessageHandler);

    const handleUpdate = (update) => {
        return telegraf.handleUpdate(update);
    }

    return { handleUpdate };
}

module.exports = { TgBot };