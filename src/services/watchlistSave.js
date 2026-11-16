const sessionManager = require("../utils/session");
const redis = require("./redis");
const db = require("./database");

async function saveCurrentVideoForUser(userId, userData = null) {
  const session = await sessionManager.get(userId);
  const cur = session.tempData?.currentVideo;

  if (!cur?.url || !cur?.videoId) {
    return { ok: false, error: "No current video to save." };
  }

  const savedId = await sessionManager.addVideoLink(
    userId,
    cur.url,
    userData,
    {
      title: cur.title || null,
    }
  );

  if (!savedId) {
    return { ok: false, error: "Could not save: failed to parse a YouTube video ID from the URL." };
  }

  const kTranscript = `draft_transcript:${savedId}`;
  const kSegments = `draft_segments:${savedId}`;
  const kSummary = `draft_collection:${savedId}`;

  const draftTranscript = await redis.getTemp(userId, kTranscript);
  if (draftTranscript?.text) {
    await db.updateVideoTranscript(savedId, String(draftTranscript.text));
  }

  const draftSegments = await redis.getTemp(userId, kSegments);
  if (Array.isArray(draftSegments) && draftSegments.length) {
    await db.updateVideoMetadata(savedId, { whisper: { segments: draftSegments } });
  }

  const draftSummary = await redis.getTemp(userId, kSummary);
  if (draftSummary?.summary) {
    await db.updateVideoMetadata(savedId, {
      summary: String(draftSummary.summary),
      highlights: Array.isArray(draftSummary.highlights) ? draftSummary.highlights : [],
      summaryUpdatedAt: new Date().toISOString(),
    });
  }

  const modeData = await redis.getTemp(userId, `chat_mode:${savedId}`);
  if (modeData?.mode) {
    await db.updateVideoMetadata(savedId, { chatMode: modeData.mode });
  }

  const items = await redis.getContext(userId, savedId);
  if (Array.isArray(items) && items.length) {
    for (const it of items) {
      const msg = String(it.message || "");
      if (!msg) continue;
      const resp = it.response == null ? null : String(it.response);
      await db.saveConversation(userId, savedId, msg, resp);
    }
    await redis.clearContext(userId, savedId);
  }

  await redis.deleteTemp(userId, kTranscript);
  await redis.deleteTemp(userId, kSegments);
  await redis.deleteTemp(userId, kSummary);

  return {
    ok: true,
    videoId: savedId,
    title: cur.title || null,
    message: "Saved to watchlist. Transcript + summary + conversation + chat mode are now stored in DB.",
  };
}

module.exports = {
  saveCurrentVideoForUser,
};
