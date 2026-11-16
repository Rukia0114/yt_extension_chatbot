const { Telegraf } = require("telegraf");
const commands = require("../commands");
const textHandler = require("./handlers/text");

const token = process.env.TELEGRAM_BOT_TOKEN;
if (!token) throw new Error("Missing TELEGRAM_BOT_TOKEN");

const bot = new Telegraf(token, { handlerTimeout: 600000 });

const LLM_BASE_URL = process.env.LLM_BASE_URL || "http://host.docker.internal:1234/v1";
const LLM_MODEL = process.env.LLM_MODEL || "openai/gpt-oss-20b";

function wireHandlers() {
  bot.start(commands.start);
  bot.help(commands.help);
  bot.command("recommendations", commands.recommendations);
  bot.command("summary", commands.summary);
  bot.command("watchlist", commands.watchlist);
  bot.command("switch", commands.switch);
  bot.command("save", commands.save);
  bot.command("question", commands.question);
  bot.command("clear", commands.clear);
  bot.command("highlight", commands.highlight);
  bot.command("current", commands.showCurrentVideo);
  bot.command("source", commands.source);
  bot.command("mode", commands.mode);
  // moved to handler file
  bot.on("text", textHandler(LLM_BASE_URL, LLM_MODEL));

  bot.on("callback_query", async (ctx) => {
    if (ctx.callbackQuery?.data?.startsWith("clear_")) {
      await commands.clear(ctx);
      return;
    }
    if (ctx.callbackQuery?.data?.startsWith("source_")) {
      await commands.source(ctx);
      return;
    }
    await ctx.answerCallbackQuery("Unknown action");
  });
}

async function setBotCommandsMenu() {
  await bot.telegram.setMyCommands([
    { command: "start", description: "Start the bot and enter the video/yt links" },
    { command: "help", description: "Show all commands the bot have" },
    { command: "summary", description: "Generate video summary" },
    { command: "watchlist", description: "View your watchlist" },
    { command: "switch", description: "Switch to a watchlist video by number" },
    { command: "recommendations", description: "Get recommendations of similar videos" },
    { command: "question", description: "Generate MC question about the video" },
    { command: "clear", description: "Clear current session and start new chat" },
    { command: "save", description: "Save the current video to your watchlist" },
    { command: "highlight", description: "Show highlights" },
    { command: "current", description: "Show current selected video" },
    { command: "source", description: "Switch between watchlist and temporary video" },
    { command: "mode", description: "Change chat mode" },
]);
}

async function startBot() {
  wireHandlers();
  await setBotCommandsMenu();
  await bot.telegram.deleteWebhook();
  await bot.launch();
  console.log("Bot is running in polling mode");
}

module.exports = { bot, startBot };