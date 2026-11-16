const sessionManager = require("../utils/session");

module.exports = async (ctx) => {
  const userId = ctx.from.id;
  const currentVideo = await sessionManager.getCurrentVideo(userId);
  const currentSource = await sessionManager.getCurrentVideoSource(userId);

  if (!currentVideo) {
    await ctx.reply(
      "No video selected.\n\nSend a YouTube link or use /watchlist to select one."
    );
    return;
  }

  const title = currentVideo.title || "(no title)";
  const url = currentVideo.url || "";
  const id = currentVideo.video_id || "";

  await ctx.reply(
    `🎬 Current video:\n` +
    `Source: ${currentSource === "watchlist" ? "saved watchlist video" : "temporary synced/pasted video"}\n` +
    `Title: ${title}\n` +
    `URL: ${url}\n\n` +
    `Use /source if you want to switch between the saved watchlist video and the temporary synced/pasted video.\n\n` +
    `You can use /save to save the current video to your watchlist and save the conversation history and summary of the video \n\n`
  );
};