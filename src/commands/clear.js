const sessionManager = require("../utils/session");
const db = require("../services/database");
const redis = require("../services/redis");
const { Markup } = require("telegraf");

function buildMenu(videos, currentVideoId) {
  let message = "Select which video to clear:\n\n";

  videos.forEach((v, idx) => {
    const isActive = v.video_id === currentVideoId;
    const title = (v.title || "Untitled Video").trim();
    const url = v.url || `https://www.youtube.com/watch?v=${v.video_id}`;
    message += `${idx + 1}. ${title}${isActive ? " (Active)" : ""}\n${url}\n\n`;
  });

  const buttons = [];
  for (let i = 0; i < videos.length; i += 2) {
    const row = [];

    row.push(
      Markup.button.callback(
        `Clear ${i + 1}`,
        `clear_video_${videos[i].video_id}`
      )
    );

    if (i + 1 < videos.length) {
      row.push(
        Markup.button.callback(
          `Clear ${i + 2}`,
          `clear_video_${videos[i + 1].video_id}`
        )
      );
    }
    buttons.push(row);
  }

  buttons.push([
    Markup.button.callback("Clear all", "clear_all_confirm"),
    Markup.button.callback("Cancel", "clear_cancel"),
  ]);

  return { message, keyboard: Markup.inlineKeyboard(buttons) };
}

module.exports = async (ctx) => {
  const userId = ctx.from.id;

  // Callback handlers
  if (ctx.callbackQuery) {
    const data = ctx.callbackQuery.data || "";

    if (data === "clear_cancel") {
      await ctx.answerCbQuery("Cancelled");
      await ctx.deleteMessage().catch(() => {});
      return;
    }

    if (data === "clear_all_confirm") {
      await ctx.answerCbQuery("Clearing all...");

      const videos = await sessionManager.getVideos(userId);
      const videoIds = videos.map((v) => v.video_id);

      // Clear user-specific data
      await db.clearWatchlist(userId);
      await db.deleteAllUserConversations(userId);
      await redis.deleteSession(userId).catch(() => {});

      // Clear per-video context keys for this user
      for (const vid of videoIds) {
        await redis.clearContext(userId, vid).catch(() => {});
      }

      // Delete shared video rows only if unused by anyone
      for (const vid of videoIds) {
        const watchers = await db.countVideoWatchers(vid);
        if (watchers === 0) {
          await db.deleteVideo(vid);
          await redis.invalidateVideoCache(vid).catch(() => {});
        }
      }

      await ctx.editMessageText("Cleared your watchlist and related data.");
      return;
    }

    if (data.startsWith("clear_video_")) {
      const videoId = data.slice("clear_video_".length);

      await ctx.answerCbQuery("Clearing...");

      const currentVideoId = await sessionManager.getCurrentVideoId(userId);
      const wasActive = currentVideoId === videoId;

      // Remove from user watchlist + session
      await sessionManager.removeVideo(userId, videoId);

      // Delete user-only data for that video
      await db.deleteUserConversations(userId, videoId);
      await redis.clearContext(userId, videoId).catch(() => {});

      // If it was active, pick a new active video (first remaining)
      if (wasActive) {
        const remaining = await sessionManager.getVideos(userId);
        if (remaining.length > 0) {
          await sessionManager.setCurrentVideo(userId, remaining[0].video_id);
        } else {
          await redis.updateSession(userId, { currentVideoId: null }).catch(() => {});
        }
      }

      // Delete shared video row only if no one else watches it
      const watchers = await db.countVideoWatchers(videoId);
      if (watchers === 0) {
        await db.deleteVideo(videoId);
        await redis.invalidateVideoCache(videoId).catch(() => {});
      }

      // Show updated menu (or empty state)
      const videos = await sessionManager.getVideos(userId);
      const newCurrent = await sessionManager.getCurrentVideoId(userId);

      if (videos.length === 0) {
        await ctx.editMessageText("No videos remaining. Send a YouTube link to get started.");
        return;
      }

      const { message, keyboard } = buildMenu(videos, newCurrent);
      await ctx.editMessageText(message, keyboard);
      return;
    }

    await ctx.answerCbQuery("Unknown action");
    return;
  }

  // Initial command invocation
  const videos = await sessionManager.getVideos(userId);
  const currentVideoId = await sessionManager.getCurrentVideoId(userId);

  if (!videos || videos.length === 0) {
    await ctx.reply("No videos to clear. Send a YouTube link or Sync from extension to get started.");
    return;
  }

  const { message, keyboard } = buildMenu(videos, currentVideoId);
  await ctx.reply(message, keyboard);
};