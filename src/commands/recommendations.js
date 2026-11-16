const sessionManager = require("../utils/session");
const {
  getLatestInsights,
  fetchLatestInsights,
  storeLatestInsights,
} = require("../services/insights");
const { sanitizeBotText } = require("../utils/formatting");

const DEFAULT_COUNT = 4;
const MAX_COUNT = 5;
const MAX_SOURCE_CHARS = 7000;

function normalizeSpace(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function truncate(text, maxLen) {
  const normalized = normalizeSpace(text);
  if (!normalized) return "";
  return normalized.length > maxLen ? `${normalized.slice(0, maxLen)}...` : normalized;
}

function stripCodeFences(text) {
  return String(text || "")
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/i, "")
    .trim();
}

function parseJsonObject(rawText) {
  const cleaned = stripCodeFences(rawText);
  const start = cleaned.indexOf("{");
  const end = cleaned.lastIndexOf("}");
  if (start < 0 || end <= start) throw new Error("Recommendation match JSON not found");
  return JSON.parse(cleaned.slice(start, end + 1));
}

function parseRequestedCount(messageText) {
  const args = normalizeSpace(String(messageText || "").split(" ").slice(1).join(" "))
    .split(/\s+/)
    .filter(Boolean);

  for (const arg of args) {
    const parsed = Number(arg);
    if (Number.isInteger(parsed) && parsed > 0) {
      return Math.min(MAX_COUNT, parsed);
    }
  }

  return DEFAULT_COUNT;
}

function buildSourceText(currentVideo, insights) {
  const summary = truncate(insights.summary || "", 1800);
  const transcript = truncate(insights.transcript || "", MAX_SOURCE_CHARS);
  const highlights = Array.isArray(insights.highlights)
    ? insights.highlights
        .slice(0, 5)
        .map((item, idx) => {
          const title = normalizeSpace(item?.title || "");
          const text = truncate(item?.text || "", 220);
          return `${idx + 1}. ${title || "Highlight"}${text ? `: ${text}` : ""}`;
        })
        .join("\n")
    : "";

  return [
    currentVideo?.title ? `Video title: ${normalizeSpace(currentVideo.title)}` : "",
    summary ? `Summary:\n${summary}` : "",
    highlights ? `Highlights:\n${highlights}` : "",
    transcript ? `Transcript excerpt:\n${transcript}` : "",
  ]
    .filter(Boolean)
    .join("\n\n");
}

async function loadRecommendationSource(userId, currentVideo) {
  const videoId = currentVideo.video_id;
  let insights = await getLatestInsights(userId, videoId);

  if (!normalizeSpace(buildSourceText(currentVideo, insights)) && currentVideo.url) {
    const latest = await fetchLatestInsights(currentVideo.url, videoId);
    const session = await sessionManager.get(userId);
    insights = await storeLatestInsights(userId, videoId, latest, {
      persistToDb: session?.currentVideoId === videoId,
    });
  }

  return insights;
}

async function callLLM({ messages }) {
  const llmBaseUrl = process.env.LLM_BASE_URL || "http://host.docker.internal:1234/v1";
  const llmModel = process.env.LLM_MODEL || "openai/gpt-oss-20b";

  const resp = await fetch(`${llmBaseUrl}/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: llmModel,
      messages,
      stream: false,
      temperature: 0.4,
      max_tokens: 550,
    }),
  });

  if (!resp.ok) {
    const text = await resp.text().catch(() => "");
    throw new Error(text || `LLM HTTP ${resp.status}`);
  }

  const data = await resp.json().catch(() => ({}));
  return String(data?.choices?.[0]?.message?.content || "").trim();
}

function parseRecommendationList(rawText, count) {
  const cleaned = stripCodeFences(rawText);
  const start = cleaned.indexOf("[");
  const end = cleaned.lastIndexOf("]");
  if (start < 0 || end <= start) throw new Error("Recommendation JSON not found");

  const parsed = JSON.parse(cleaned.slice(start, end + 1));
  if (!Array.isArray(parsed) || parsed.length === 0) {
    throw new Error("No recommendations returned");
  }

  return parsed
    .slice(0, count)
    .map((item) => ({
      label: sanitizeBotText(item?.label || item?.kind || "Recommended next video"),
      reason: truncate(sanitizeBotText(item?.reason || item?.why || ""), 220),
      searchQuery: truncate(sanitizeBotText(item?.searchQuery || item?.query || ""), 120),
    }))
    .filter((item) => item.searchQuery);
}

async function generateRecommendationSeeds({ currentVideo, sourceText, count }) {
  const messages = [
    {
      role: "system",
      content:
        "You design helpful next-video recommendations for a learner after they finish a video.\n" +
        "Use only the provided material. Do not invent specific creators or exact videos.\n" +
        "Focus on useful next steps for learning: prerequisite review, alternate explanation, practical example, deeper follow-up, comparison, or common mistake.\n" +
        `Return strict JSON only as an array with exactly ${count} items.\n` +
        "Each item must have this shape:\n" +
        '{"label":"string","reason":"string","searchQuery":"string"}\n' +
        "The searchQuery should be a good YouTube search phrase for finding that next video.\n" +
        "Make the items distinct and genuinely useful.",
    },
    {
      role: "user",
      content:
        `Current video: ${normalizeSpace(currentVideo.title || "Untitled video")}\n\n` +
        `Source material:\n${sourceText}`,
    },
  ];

  let lastError = null;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const raw = await callLLM({ messages });
      return parseRecommendationList(raw, count);
    } catch (error) {
      lastError = error;
      messages.push({
        role: "user",
        content:
          `Return valid JSON only as an array of exactly ${count} items. Do not add markdown fences or commentary.`,
      });
    }
  }

  throw lastError || new Error("Failed to generate recommendations");
}

async function searchYouTubeVideos(query, currentVideoId) {
  const apiKey = String(process.env.YOUTUBE_API_KEY || "").trim();
  if (!apiKey || !query) return [];

  const url =
    "https://www.googleapis.com/youtube/v3/search" +
    `?part=snippet&type=video&maxResults=3&q=${encodeURIComponent(query)}&key=${encodeURIComponent(apiKey)}`;

  const resp = await fetch(url).catch(() => null);
  if (!resp?.ok) return [];

  const data = await resp.json().catch(() => ({}));
  const items = Array.isArray(data?.items) ? data.items : [];

  return items
    .map((item) => {
      const videoId = String(item?.id?.videoId || "").trim();
      const title = sanitizeBotText(item?.snippet?.title || "");
      const channel = sanitizeBotText(item?.snippet?.channelTitle || "");
      const description = truncate(sanitizeBotText(item?.snippet?.description || ""), 240);
      if (!videoId || videoId === currentVideoId || !title) return null;
      return {
        videoId,
        title,
        channel,
        description,
        url: `https://www.youtube.com/watch?v=${videoId}`,
      };
    })
    .filter(Boolean);
}

async function chooseBestRecommendationMatch({ currentVideo, sourceText, seed, candidates }) {
  if (!Array.isArray(candidates) || candidates.length === 0) return null;

  const messages = [
    {
      role: "system",
      content:
        "You are choosing the best concrete YouTube recommendation for a learner.\n" +
        "Use the current video's source material, the intended recommendation seed, and the candidate metadata.\n" +
        "Pick the single best candidate videoId from the provided candidates only.\n" +
        "Write the final reason based on the ACTUAL selected candidate, not only on the seed.\n" +
        "If none fit well enough, return an empty videoId.\n" +
        "Return strict JSON only with this shape:\n" +
        '{"videoId":"string","reason":"string","confidence":0.0}\n' +
        "Confidence should be between 0 and 1.",
    },
    {
      role: "user",
      content:
        `Current video: ${normalizeSpace(currentVideo.title || "Untitled video")}\n\n` +
        `Source material:\n${sourceText}\n\n` +
        `Recommendation seed label: ${seed.label}\n` +
        `Recommendation seed reason: ${seed.reason}\n` +
        `Recommendation search query: ${seed.searchQuery}\n\n` +
        `Candidates:\n${candidates
          .map((candidate, idx) =>
            `${idx + 1}. videoId=${candidate.videoId}\n` +
            `Title: ${candidate.title}\n` +
            `Channel: ${candidate.channel || "(unknown)"}\n` +
            `Description: ${candidate.description || "(none)"}\n` +
            `URL: ${candidate.url}`
          )
          .join("\n\n")}`,
    },
  ];

  const raw = await callLLM({ messages });
  const parsed = parseJsonObject(raw);
  const videoId = normalizeSpace(parsed?.videoId || "");
  const confidence = Number(parsed?.confidence);
  const reason = truncate(sanitizeBotText(parsed?.reason || ""), 220);
  if (!videoId) return null;
  const match = candidates.find((candidate) => candidate.videoId === videoId);
  if (!match) return null;
  return {
    ...match,
    reason: reason || seed.reason || "Good next step based on this video.",
    confidence: Number.isFinite(confidence) ? confidence : 0,
  };
}

function formatSearchRecommendations(currentVideo, items) {
  const header = currentVideo?.title
    ? `Recommended next videos after: ${sanitizeBotText(currentVideo.title)}`
    : "Recommended next videos";

  const lines = items.map((item, idx) => {
    const searchUrl = `https://www.youtube.com/results?search_query=${encodeURIComponent(item.searchQuery)}`;
    return (
      `${idx + 1}. ${item.label}\n` +
      `Why: ${item.reason || "Good next step based on this video."}\n` +
      `Search: ${item.searchQuery}\n` +
      `${searchUrl}`
    );
  });

  return [
    header,
    "",
    ...lines,
    "",
    "Tip: open one result you like, then use /save if you want it in your watchlist.",
  ].join("\n\n");
}

function formatVideoRecommendations(currentVideo, items) {
  const header = currentVideo?.title
    ? `Recommended next videos after: ${sanitizeBotText(currentVideo.title)}`
    : "Recommended next videos";

  const lines = items.map((item, idx) => (
    `${idx + 1}. ${item.videoTitle}\n` +
    `${item.videoUrl}\n` +
    `${item.channel ? `Channel: ${item.channel}\n` : ""}` +
    `Why: ${item.reason}`
  ));

  return [
    header,
    "",
    ...lines,
    "",
    "Tip: use /recommendations 5 if you want a longer list.",
  ].join("\n\n");
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

  const count = parseRequestedCount(ctx.message?.text || "");
  const statusMsg = await ctx.reply("Preparing recommendations...");

  void (async () => {
    try {
      const insights = await loadRecommendationSource(userId, currentVideo);
      const sourceText = buildSourceText(currentVideo, insights);

      if (!sourceText && !currentVideo.title) {
        await ctx.telegram
          .editMessageText(
            statusMsg.chat.id,
            statusMsg.message_id,
            undefined,
            "I need at least the video title, summary, or transcript to recommend the next videos."
          )
          .catch(() => {});
        return;
      }

      const seeds = await generateRecommendationSeeds({
        currentVideo,
        sourceText:
          sourceText ||
          `Video title: ${normalizeSpace(currentVideo.title || currentVideo.url || currentVideo.video_id)}`,
        count,
      });

      if (!seeds.length) {
        await ctx.telegram
          .editMessageText(
            statusMsg.chat.id,
            statusMsg.message_id,
            undefined,
            "Could not find good recommendations right now."
          )
          .catch(() => {});
        return;
      }

      const concrete = [];
      const seenIds = new Set();
      for (const seed of seeds) {
        const hits = (await searchYouTubeVideos(seed.searchQuery, currentVideo.video_id))
          .filter((hit) => !seenIds.has(hit.videoId));
        if (!hits.length) continue;

        let selected = null;
        try {
          selected = await chooseBestRecommendationMatch({
            currentVideo,
            sourceText:
              sourceText ||
              `Video title: ${normalizeSpace(currentVideo.title || currentVideo.url || currentVideo.video_id)}`,
            seed,
            candidates: hits,
          });
        } catch {
          selected = null;
        }

        const match = selected || hits[0];
        if (!match) continue;
        seenIds.add(match.videoId);
        concrete.push({
          label: seed.label,
          reason: match.reason || seed.reason,
          videoTitle: match.title,
          channel: match.channel,
          videoUrl: match.url,
        });
        if (concrete.length >= count) break;
      }

      const message = concrete.length
        ? formatVideoRecommendations(currentVideo, concrete)
        : formatSearchRecommendations(currentVideo, seeds);

      await ctx.telegram
        .editMessageText(statusMsg.chat.id, statusMsg.message_id, undefined, message)
        .catch(async () => {
          await ctx.reply(message);
        });
    } catch (e) {
      await ctx.telegram
        .editMessageText(
          statusMsg.chat.id,
          statusMsg.message_id,
          undefined,
          e.message || "Could not generate recommendations right now."
        )
        .catch(() => {});
    }
  })();
};