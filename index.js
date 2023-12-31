const { Telegraf } = require("telegraf");
const { VK } = require("vk-io");

const { TgBot } = require("./tg_bot");
const { VkBot } = require("./vk_bot");

const telegraf = new Telegraf(process.env.TG_TOKEN);
const vk = new VK({ token: process.env.VK_TOKEN });
const vkUser = new VK({ token: process.env.VK_USER_TOKEN });

const tgBot = TgBot(telegraf, vk);
const vkBot = VkBot(telegraf.telegram, vk, vkUser);

module.exports.handler = async function (event, context) {
    for (const messageFromQueue of event.messages) {
        const update = JSON.parse(messageFromQueue.details.message.body);
        if (update.type === undefined) {
            await tgBot.handleUpdate(update);
        } else {
            await vkBot.handleUpdate(update);
        }
    }

    return { statusCode: 200, body: "" };
};