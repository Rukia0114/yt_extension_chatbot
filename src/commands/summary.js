// Summary command: uses Whisper /analyze/youtube so Telegram matches extension

const sessionManager = require("../utils/session");
const {
  fetchLatestInsights,
  storeLatestInsights,
} = require("../services/insights");
const TELEGRAM_MAX_LENGTH = 4096;

function splitMessage(text, maxLength = TELEGRAM_MAX_LENGTH) {
  if (text.length <= maxLength) return [text];

  const chunks = [];
  let currentChunk = "";
  const words = text.split(" ");

  for (const w of words) {
    if ((currentChunk + " " + w).trim().length > maxLength) {
      if (currentChunk) chunks.push(currentChunk.trim());
      currentChunk = w;
    } else {
      currentChunk = (currentChunk ? currentChunk + " " : "") + w;
    }
  }

  if (currentChunk) chunks.push(currentChunk.trim());
  return chunks;
}

module.exports = async (ctx) => {
  const userId = ctx.from.id;
  const currentVideo = await sessionManager.getCurrentVideo(userId);

  if (!currentVideo) {
    await ctx.reply(
      "No video selected!\n\n" +
        "Please send a YouTube link first, or use /watchlist to select a video."
    );
    return;
  }

  const videoId = currentVideo.video_id;
  const videoUrl = currentVideo.url;

  const statusMsg = await ctx.reply("Preparing summary…");

  void (async () => {
    try {
      await ctx.telegram
        .editMessageText(statusMsg.chat.id, statusMsg.message_id, undefined, "Generating summary…")
        .catch(() => {});

      let saved;
      try {
        const insights = await fetchLatestInsights(videoUrl, videoId);
        const session = await sessionManager.get(userId);
        saved = await storeLatestInsights(userId, videoId, insights, {
          persistToDb: session.currentVideoId === videoId,
        });
      } catch (err) {
        await ctx.telegram
          .editMessageText(
            statusMsg.chat.id,
            statusMsg.message_id,
            undefined,
            err.message || "Transcript not ready. Click Sync now in the extension first."
          )
          .catch(() => {});
        return;
      }

      const summary = saved.summary || "";

      if (!summary.trim()) {
        await ctx.telegram
          .editMessageText(statusMsg.chat.id, statusMsg.message_id, undefined, "No summary returned.")
          .catch(() => {});
        return;
      }

      const chunks = splitMessage(summary, 3500);
      await ctx.telegram
        .editMessageText(statusMsg.chat.id, statusMsg.message_id, undefined, chunks[0])
        .catch(() => {});

      for (let i = 1; i < chunks.length; i++) {
        await ctx.reply(chunks[i]);
      }
    } catch (e) {
      await ctx.telegram
        .editMessageText(statusMsg.chat.id, statusMsg.message_id, undefined, `Error: ${e.message}`)
        .catch(() => {});
    }
  })();
};