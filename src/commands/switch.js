const sessionManager = require("../utils/session");

module.exports = async (ctx) => {
  const userId = ctx.from.id;
  const rawText = String(ctx.message?.text || "").trim();
  const parts = rawText.split(/\s+/);
  const indexText = parts[1] || "";
  const index = Number(indexText);

  const videos = await sessionManager.getVideos(userId);
  if (!videos || videos.length === 0) {
    await ctx.reply(
      "Your watchlist is empty.\n\nSave a video first, then use /watchlist and /switch <number>."
    );
    return;
  }

  if (!Number.isInteger(index) || index < 1 || index > videos.length) {
    await ctx.reply(
      `Usage: /switch <number>\n\nExample: /switch 2\n\nUse /watchlist to see the numbered list of your saved videos.`
    );
    return;
  }

  const selected = videos[index - 1];
  await sessionManager.setCurrentVideo(userId, selected.video_id);

  const title = selected.title || "Untitled Video";
  const url = selected.url || `https://www.youtube.com/watch?v=${selected.video_id}`;
  await ctx.reply(
    `Switched to watchlist video ${index}.\n\nTitle: ${title}\nURL: ${url}`
  );
};
