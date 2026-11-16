const db = require("./database");
const redis = require("./redis");

const WHISPER_URL = process.env.WHISPER_URL || "http://whisper:9000";

function parseMetadata(video) {
  if (!video?.metadata) return {};

  try {
    const meta = typeof video.metadata === "string"
      ? JSON.parse(video.metadata || "{}")
      : (video.metadata || {});
    return meta && typeof meta === "object" ? meta : {};
  } catch {
    return {};
  }
}

function normalizeInsightsPayload(data = {}, fallbackUrl = "") {
  return {
    url: typeof data.url === "string" && data.url ? data.url : (fallbackUrl || null),
    summary: typeof data.summary === "string" ? data.summary : null,
    highlights: Array.isArray(data.highlights) ? data.highlights : [],
    transcript: typeof data.transcript === "string" ? data.transcript : "",
    segments: Array.isArray(data.segments) ? data.segments : [],
  };
}

async function fetchLatestInsights(videoUrl, videoId) {
  const resp = await fetch(`${WHISPER_URL}/analyze/youtube`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ url: videoUrl, video_id: videoId }),
  });

  if (!resp.ok) {
    const errText = await resp.text().catch(() => "");
    const error = new Error(errText || "Transcript not ready. Call /transcribe first.");
    error.status = resp.status;
    throw error;
  }

  const data = await resp.json().catch(() => ({}));
  return normalizeInsightsPayload(data, videoUrl);
}

async function storeLatestInsights(userId, videoId, insights, { persistToDb = false } = {}) {
  const normalized = normalizeInsightsPayload(insights);

  await redis.setTemp(
    userId,
    `draft_collection:${videoId}`,
    { summary: normalized.summary, highlights: normalized.highlights },
    86400
  );

  if (normalized.transcript) {
    await redis.setTemp(userId, `draft_transcript:${videoId}`, { text: normalized.transcript }, 86400);
  }

  if (normalized.segments.length) {
    await redis.setTemp(userId, `draft_segments:${videoId}`, normalized.segments, 86400);
  }

  if (persistToDb) {
    await db.updateVideoMetadata(videoId, {
      summary: normalized.summary,
      highlights: normalized.highlights,
      summaryUpdatedAt: new Date().toISOString(),
      ...(normalized.segments.length ? { whisper: { segments: normalized.segments } } : {}),
    });

    if (normalized.transcript) {
      await db.updateVideoTranscript(videoId, normalized.transcript);
    }

    await redis.invalidateVideoCache(videoId).catch(() => {});
  }

  return normalized;
}

async function getLatestInsights(userId, videoId) {
  const [video, draft, draftTranscript, draftSegments] = await Promise.all([
    db.getVideo(videoId),
    redis.getTemp(userId, `draft_collection:${videoId}`),
    redis.getTemp(userId, `draft_transcript:${videoId}`),
    redis.getTemp(userId, `draft_segments:${videoId}`),
  ]);

  const meta = parseMetadata(video);

  let summary = typeof meta.summary === "string" ? meta.summary : null;
  let highlights = Array.isArray(meta.highlights) ? meta.highlights : [];
  let transcript = typeof video?.transcript === "string" ? video.transcript : "";
  let segments = Array.isArray(meta?.whisper?.segments) ? meta.whisper.segments : [];

  if (draft && Object.prototype.hasOwnProperty.call(draft, "summary")) {
    summary = typeof draft.summary === "string" ? draft.summary : null;
  }

  if (draft && Object.prototype.hasOwnProperty.call(draft, "highlights")) {
    highlights = Array.isArray(draft.highlights) ? draft.highlights : [];
  }

  if (draftTranscript?.text) {
    transcript = String(draftTranscript.text);
  }

  if (Array.isArray(draftSegments)) {
    segments = draftSegments;
  }

  return {
    video,
    videoId,
    url: video?.url || null,
    summary,
    highlights,
    transcript,
    segments,
  };
}

module.exports = {
  fetchLatestInsights,
  getLatestInsights,
  storeLatestInsights,
};
