const sessionManager = require("../utils/session");
const {
  fetchLatestInsights,
  getLatestInsights,
  storeLatestInsights,
} = require("../services/insights");
const TELEGRAM_MAX_LENGTH = 4096;

function formatTime(sec) {
  sec = Math.max(0, Math.floor(Number(sec || 0)));
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return `${m}:${String(s).padStart(2, "0")}`;
}

function splitMessage(text, maxLength = TELEGRAM_MAX_LENGTH) {
  if (text.length <= maxLength) return [text];
  const chunks = [];
  let currentChunk = "";
  for (const word of text.split(" ")) {
    if ((currentChunk + " " + word).trim().length > maxLength) {
      if (currentChunk) chunks.push(currentChunk.trim());
      currentChunk = word;
    } else {
      currentChunk = (currentChunk ? currentChunk + " " : "") + word;
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
      "No video selected.\n\nSend a YouTube link or use /watchlist to select one."
    );
    return;
  }

  const videoId = currentVideo.video_id;
  const statusMsg = await ctx.reply("Preparing highlights…");

  void (async () => {
    try {
      let insights = await getLatestInsights(userId, videoId);
      let highlights = insights.highlights;
      let videoUrl = currentVideo.url || insights.url || "";

      if (!highlights.length) {
        if (!videoUrl) {
          await ctx.telegram
            .editMessageText(
              statusMsg.chat.id,
              statusMsg.message_id,
              undefined,
              "Missing video URL. Try syncing the video from the extension first."
            )
            .catch(() => {});
          return;
        }

        await ctx.telegram
          .editMessageText(
            statusMsg.chat.id,
            statusMsg.message_id,
            undefined,
            "Generating highlights…"
          )
          .catch(() => {});

        try {
          const latest = await fetchLatestInsights(videoUrl, videoId);
          const session = await sessionManager.get(userId);
          insights = await storeLatestInsights(userId, videoId, latest, {
            persistToDb: session?.currentVideoId === videoId,
          });
        } catch (err) {
          await ctx.telegram
            .editMessageText(
              statusMsg.chat.id,
              statusMsg.message_id,
              undefined,
              `Error: ${String(err.message || "").slice(0, 3500)}`
            )
            .catch(() => {});
          return;
        }
        highlights = insights.highlights;
      }

      if (!highlights.length) {
        await ctx.telegram
          .editMessageText(
            statusMsg.chat.id,
            statusMsg.message_id,
            undefined,
            "No highlights returned."
          )
          .catch(() => {});
        return;
      }

      const lines = highlights.map((h, i) => {
        const t = formatTime(h.startSec || h.start || 0);
        // const link = `${videoUrl}&t=${Math.floor(h.startSec || h.start || 0)}s`;
        const title = h.title || "";
        const text = (h.text || "").trim();
        return `${i + 1}. [${t}] ${title}\n${text ? `\n${text}` : ""}`;
      });

      const text = `✨ Highlights:\n\n${lines.join("\n\n")}`;
      const chunks = splitMessage(text, 3500);

      await ctx.telegram
        .editMessageText(statusMsg.chat.id, statusMsg.message_id, undefined, chunks[0])
        .catch(() => {});

      for (let i = 1; i < chunks.length; i++) {
        await ctx.reply(chunks[i]);
      }
    } catch (e) {
      await ctx.telegram
        .editMessageText(
          statusMsg.chat.id,
          statusMsg.message_id,
          undefined,
          `Error: ${e.message}`
        )
        .catch(() => {});
    }
  })();
};