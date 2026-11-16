const crypto = require("crypto");
const db = require("./database");
const redisService = require("./redis");

const STOP_WORDS = new Set([
  "the", "a", "an", "and", "or", "but", "if", "then", "else", "to", "of", "in", "on", "for", "with",
  "from", "at", "by", "as", "is", "are", "was", "were", "be", "being", "been", "this", "that", "these",
  "those", "it", "its", "they", "them", "their", "we", "our", "you", "your", "i", "my", "me", "he", "she",
  "his", "her", "what", "which", "who", "whom", "how", "when", "where", "why", "can", "could", "should",
  "would", "will", "just", "about", "into", "over", "under", "than", "also", "more", "most", "very",
  "tell", "video", "videos", "please",
]);

function normalizeText(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function truncate(text, maxLen) {
  const normalized = normalizeText(text);
  if (!normalized) return "";
  return normalized.length > maxLen ? normalized.slice(0, maxLen) + "..." : normalized;
}

function tokenize(text) {
  return normalizeText(text)
    .toLowerCase()
    .match(/[a-z][a-z0-9-]{1,29}/g) || [];
}

function keywordTokens(text) {
  return tokenize(text).filter((token) => token.length >= 3 && !STOP_WORDS.has(token));
}

function formatTime(seconds) {
  const sec = Math.max(0, Math.floor(Number(seconds || 0)));
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  return h > 0
    ? `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`
    : `${m}:${String(s).padStart(2, "0")}`;
}

function parseMetadata(video) {
  if (!video?.metadata) return {};
  try {
    return typeof video.metadata === "string"
      ? JSON.parse(video.metadata || "{}")
      : (video.metadata || {});
  } catch {
    return {};
  }
}

async function getSegmentsForVideo(userId, videoId) {
  const draftSegments = await redisService.getTemp(userId, `draft_segments:${videoId}`);
  if (Array.isArray(draftSegments) && draftSegments.length > 0) return draftSegments;

  const video = await db.getVideo(videoId);
  const meta = parseMetadata(video);
  const segments = meta?.whisper?.segments;
  return Array.isArray(segments) ? segments : [];
}

function buildChunks(segments, { maxChars = 900, maxSegments = 6 } = {}) {
  const chunks = [];
  let current = null;

  for (const segment of segments || []) {
    const text = normalizeText(segment?.text || "");
    if (!text) continue;

    const start = Number(segment?.start ?? segment?.startSec ?? 0);
    const end = Number(segment?.end ?? segment?.endSec ?? start);

    if (!current) {
      current = { start, end, texts: [text], segmentCount: 1 };
      continue;
    }

    const candidateText = `${current.texts.join(" ")} ${text}`.trim();
    if (candidateText.length > maxChars || current.segmentCount >= maxSegments) {
      chunks.push({
        start: current.start,
        end: current.end,
        text: current.texts.join(" ").trim(),
      });
      current = { start, end, texts: [text], segmentCount: 1 };
      continue;
    }

    current.end = end;
    current.texts.push(text);
    current.segmentCount += 1;
  }

  if (current) {
    chunks.push({
      start: current.start,
      end: current.end,
      text: current.texts.join(" ").trim(),
    });
  }

  return chunks;
}

function scoreChunk(questionTokens, chunk) {
  if (!questionTokens.length || !chunk?.text) return 0;

  const chunkTokens = keywordTokens(chunk.text);
  const tokenSet = new Set(chunkTokens);
  let overlap = 0;
  for (const token of questionTokens) {
    if (tokenSet.has(token)) overlap += 1;
  }

  const phraseBoost = questionTokens.length >= 2
    ? questionTokens
        .slice(0, -1)
        .reduce((score, token, idx) => (
          chunk.text.toLowerCase().includes(`${token} ${questionTokens[idx + 1]}`) ? score + 1 : score
        ), 0)
    : 0;

  return overlap * 3 + phraseBoost * 4;
}

function selectTranscriptChunks(question, chunks, maxResults = 3) {
  const questionTokens = keywordTokens(question);
  return chunks
    .map((chunk) => ({ ...chunk, score: scoreChunk(questionTokens, chunk) }))
    .filter((chunk) => chunk.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, maxResults);
}

function needsExternalKnowledge(question, transcriptHits, ragOptions = {}) {
  const lower = normalizeText(question).toLowerCase();
  if (!lower) return false;

  const conceptPattern =
    /\b(what is|who is|define|definition|meaning|explain|background|history|compare|difference|why|how does|how do|example)\b/;
  const freshnessPattern = /\b(current|latest|recent|today|modern|real world)\b/;

  if (ragOptions.external === false) return false;
  if (freshnessPattern.test(lower)) return true;
  if (transcriptHits.length === 0) return conceptPattern.test(lower);
  const minScoreForExternalSkip = Number(ragOptions.minScoreForExternalSkip || 8);
  return conceptPattern.test(lower) && transcriptHits[0].score < minScoreForExternalSkip;
}

async function fetchWikipediaSummaries(query) {
  const searchResp = await fetch(
    `https://en.wikipedia.org/w/api.php?action=query&list=search&srsearch=${encodeURIComponent(query)}&utf8=1&format=json`
  );
  if (!searchResp.ok) return [];

  const searchData = await searchResp.json().catch(() => ({}));
  const results = Array.isArray(searchData?.query?.search) ? searchData.query.search.slice(0, 2) : [];
  const pages = [];

  for (const result of results) {
    const title = String(result?.title || "").trim();
    if (!title) continue;

    const summaryResp = await fetch(
      `https://en.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(title)}`
    ).catch(() => null);
    if (!summaryResp?.ok) continue;

    const summaryData = await summaryResp.json().catch(() => ({}));
    const extract = normalizeText(summaryData?.extract || "");
    if (!extract) continue;

    pages.push({
      title,
      extract: truncate(extract, 500),
      url: summaryData?.content_urls?.desktop?.page || "",
    });
  }

  return pages;
}

async function getExternalContext(question, transcriptHits) {
  const querySeed = transcriptHits[0]?.text || "";
  const queryTokens = keywordTokens(`${question} ${querySeed}`).slice(0, 8);
  const query = queryTokens.join(" ").trim() || normalizeText(question);
  if (!query) return [];

  return fetchWikipediaSummaries(query);
}

async function getCachedExternalContext(question, transcriptHits) {
  const cacheKey = `rag_external:${crypto.createHash("sha1").update(`${question}\n${transcriptHits[0]?.text || ""}`).digest("hex")}`;
  const cached = await redisService.getTemp(0, cacheKey).catch(() => null);
  if (Array.isArray(cached)) return cached;

  const pages = await getExternalContext(question, transcriptHits);
  await redisService.setTemp(0, cacheKey, pages, 21600).catch(() => {});
  return pages;
}

async function buildRagContext({ userId, videoId, userMessage, mode, ragOptions = null }) {
  const options = ragOptions || (
    mode === "educational" || mode === "academic"
      ? { enabled: true, transcriptTopK: 4, external: true, minScoreForExternalSkip: 8 }
      : { enabled: false, transcriptTopK: 0, external: false }
  );

  if (!options.enabled) {
    return {
      transcriptContext: "",
      externalContext: "",
    };
  }

  const segments = await getSegmentsForVideo(userId, videoId);
  const chunks = buildChunks(segments);
  const transcriptHits = selectTranscriptChunks(
    userMessage,
    chunks,
    Math.max(0, Number(options.transcriptTopK || 0))
  );

  const transcriptContext = transcriptHits.length
    ? transcriptHits
        .map((hit, idx) => (
          `${idx + 1}. [${formatTime(hit.start)}-${formatTime(hit.end)}] ${truncate(hit.text, 700)}`
        ))
        .join("\n")
    : "";

  let externalContext = "";
  if (needsExternalKnowledge(userMessage, transcriptHits, options)) {
    const pages = await getCachedExternalContext(userMessage, transcriptHits);
    if (pages.length) {
      externalContext = pages
        .map((page, idx) => `${idx + 1}. ${page.title}: ${page.extract}`)
        .join("\n");
    }
  }

  return {
    transcriptContext,
    externalContext,
  };
}

module.exports = {
  buildRagContext,
};
