const { Markup } = require("telegraf");
const sessionManager = require("../utils/session");
const db = require("../services/database");

function formatSourceName(source) {
  return source === "watchlist" ? "Saved watchlist video" : "Temporary synced/pasted video";
}

function getArgFromMessage(text) {
  const parts = String(text || "").trim().split(/\s+/);
  return String(parts[1] || "").trim().toLowerCase();
}

async function loadSourceState(userId) {
  const session = await sessionManager.get(userId);
  const available = await sessionManager.getAvailableVideoSources(userId);
  const watchlistVideo = available.watchlistVideoId
    ? await db.getVideo(available.watchlistVideoId)
    : null;
  const tempVideo = session.tempData?.currentVideo || null;

  return {
    ...available,
    watchlistVideo,
    tempVideo,
  };
}

function buildSourceMessage(state) {
  if (!state.hasWatchlist && !state.hasSession) {
    return (
      "No video source is available yet.\n\n" +
      "Paste a YouTube link or sync from the extension first. You can also save a video to your watchlist with /save."
    );
  }

  const lines = [
    `Current source: ${formatSourceName(state.active)}`,
    "",
    "Available sources:",
  ];

  if (state.hasWatchlist) {
    const title = state.watchlistVideo?.title || state.watchlistVideo?.url || state.watchlistVideoId;
    lines.push(`- watchlist${state.active === "watchlist" ? " (active)" : ""}: ${title}`);
  }

  if (state.hasSession) {
    const title = state.tempVideo?.title || state.tempVideo?.url || state.sessionVideoId;
    lines.push(`- session${state.active === "session" ? " (active)" : ""}: ${title}`);
  }

  if (state.hasWatchlist && state.hasSession) {
    lines.push("", "Use /source watchlist or /source session, or tap a button below.");
  }

  return lines.join("\n");
}

function buildSourceKeyboard(state) {
  const rows = [];

  if (state.hasWatchlist) {
    rows.push([
      Markup.button.callback(
        state.active === "watchlist" ? "Watchlist active" : "Switch to watchlist",
        "source_switch_watchlist"
      ),
    ]);
  }

  if (state.hasSession) {
    rows.push([
      Markup.button.callback(
        state.active === "session" ? "Session active" : "Switch to session",
        "source_switch_session"
      ),
    ]);
  }

  if (rows.length > 0) {
    rows.push([
      Markup.button.callback("Refresh", "source_refresh"),
      Markup.button.callback("Close", "source_cancel"),
    ]);
  }

  return rows.length > 0 ? Markup.inlineKeyboard(rows) : undefined;
}

module.exports = async (ctx) => {
  const userId = ctx.from.id;

  if (ctx.callbackQuery) {
    const data = String(ctx.callbackQuery.data || "");

    if (data === "source_cancel") {
      await ctx.answerCbQuery("Closed");
      await ctx.deleteMessage().catch(() => {});
      return;
    }

    if (data === "source_refresh") {
      const state = await loadSourceState(userId);
      await ctx.answerCbQuery("Refreshed");
      await ctx.editMessageText(buildSourceMessage(state), buildSourceKeyboard(state)).catch(() => {});
      return;
    }

    if (data === "source_switch_watchlist" || data === "source_switch_session") {
      const nextSource = data.endsWith("watchlist") ? "watchlist" : "session";
      const result = await sessionManager.switchCurrentVideoSource(userId, nextSource);
      if (!result.ok) {
        await ctx.answerCbQuery(result.error, { show_alert: true }).catch(() => {});
      } else {
        await ctx.answerCbQuery(`Switched to ${nextSource}`);
      }
      const state = await loadSourceState(userId);
      await ctx.editMessageText(buildSourceMessage(state), buildSourceKeyboard(state)).catch(() => {});
      return;
    }

    await ctx.answerCbQuery("Unknown action");
    return;
  }

  const requestedSource = getArgFromMessage(ctx.message?.text);
  if (requestedSource === "watchlist" || requestedSource === "session") {
    const result = await sessionManager.switchCurrentVideoSource(userId, requestedSource);
    if (!result.ok) {
      await ctx.reply(result.error);
      return;
    }
    const state = await loadSourceState(userId);
    await ctx.reply(buildSourceMessage(state), buildSourceKeyboard(state));
    return;
  }

  const state = await loadSourceState(userId);
  await ctx.reply(buildSourceMessage(state), buildSourceKeyboard(state));
};
