const db = require("../database");
const redisService = require("../redis");
const { toNumber, normalizeText, truncate } = require("./shared");

const STOP_WORDS = new Set([
  "the", "a", "an", "and", "or", "but", "if", "then", "else", "to", "of", "in", "on", "for", "with",
  "from", "at", "by", "as", "is", "are", "was", "were", "be", "being", "been", "this", "that", "these",
  "those", "it", "its", "they", "them", "their", "we", "our", "you", "your", "i", "my", "me", "he", "she",
  "his", "her", "what", "which", "who", "whom", "how", "when", "where", "why", "can", "could", "should",
  "would", "will", "just", "about", "into", "over", "under", "than", "also", "more", "most", "very",
]);

const COMPLEX_LEXICON = [
  "tradeoff", "latency", "throughput", "architecture", "consistency", "concurrency", "distributed",
  "deadlock", "idempotent", "event loop", "embedding", "tokenization", "consensus", "quorum",
  "sharding", "invariant", "heuristic", "normalization", "causal", "entropy", "complexity",
];

function tokenizeWords(text) {
  return normalizeText(text)
    .toLowerCase()
    .match(/[a-z][a-z0-9-]{1,29}/g) || [];
}

function extractAcronyms(text) {
  const matches = String(text || "").match(/\b[A-Z]{2,8}\b/g) || [];
  return matches.map((token) => token.toLowerCase());
}

function extractCandidateTerms(text) {
  const words = tokenizeWords(text).filter((word) => !STOP_WORDS.has(word));
  const terms = [];

  for (const word of words) {
    if (word.length >= 4) terms.push(word);
  }

  for (let i = 0; i < words.length - 1; i += 1) {
    const a = words[i];
    const b = words[i + 1];
    if (!a || !b) continue;
    if (a.length < 3 || b.length < 3) continue;
    terms.push(`${a} ${b}`);
  }

  for (const acronym of extractAcronyms(text)) {
    terms.push(acronym);
  }

  return Array.from(new Set(terms)).slice(0, 50);
}

function countMatches(text, regexes) {
  let count = 0;
  for (const regex of regexes) {
    if (regex.test(text)) count += 1;
  }
  return count;
}

function median(values) {
  if (!Array.isArray(values) || values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) return sorted[middle];
  return (sorted[middle - 1] + sorted[middle]) / 2;
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

function normalizeHighlights(highlights) {
  return (Array.isArray(highlights) ? highlights : [])
    .map((item) => {
      const title = normalizeText(item?.title || "");
      const text = normalizeText(item?.text || "");
      const start = toNumber(item?.startSec, toNumber(item?.start, Number.NaN));
      const end = toNumber(item?.endSec, toNumber(item?.end, Number.NaN));
      return {
        title,
        text,
        start: Number.isFinite(start) ? start : Number.NaN,
        end: Number.isFinite(end) ? end : Number.NaN,
      };
    })
    .filter((item) => item.title || item.text);
}

async function getInsightSnapshot(userId, videoId) {
  const draft = await redisService.getTemp(userId, `draft_collection:${videoId}`);
  const video = await db.getVideo(videoId);
  const meta = parseMetadata(video);

  const summary =
    typeof draft?.summary === "string" && draft.summary.trim()
      ? draft.summary.trim()
      : (typeof meta.summary === "string" ? meta.summary.trim() : "");
  const highlights = normalizeHighlights(
    Array.isArray(draft?.highlights)
      ? draft.highlights
      : meta.highlights
  );

  return { summary, highlights };
}

function buildInsightWindows(highlights) {
  return normalizeHighlights(highlights)
    .map((item) => ({
      start: item.start,
      end: item.end,
      title: item.title,
      text: item.text,
    }))
    .filter((item) => Number.isFinite(item.start) && Number.isFinite(item.end) && item.end >= item.start);
}

function buildVideoFeatures(segments, insightSnapshot = {}) {
  const docFreq = {};
  const firstSeen = {};
  const lengths = [];

  for (let i = 0; i < segments.length; i += 1) {
    const text = normalizeText(segments[i]?.text || "");
    if (!text) continue;
    lengths.push(tokenizeWords(text).length);

    const terms = extractCandidateTerms(text);
    for (const term of terms) {
      docFreq[term] = (docFreq[term] || 0) + 1;
      if (firstSeen[term] === undefined) firstSeen[term] = i;
    }
  }

  const entries = Object.entries(docFreq)
    .filter(([, count]) => count >= 2)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 500);

  const compactFreq = {};
  const compactFirstSeen = {};
  for (const [term, count] of entries) {
    compactFreq[term] = count;
    compactFirstSeen[term] = firstSeen[term];
  }

  const summaryText = normalizeText(insightSnapshot.summary || "");
  const summaryTerms = extractCandidateTerms(summaryText).slice(0, 80);
  const highlightWindows = buildInsightWindows(insightSnapshot.highlights);
  const highlightTerms = Array.from(new Set(
    normalizeHighlights(insightSnapshot.highlights)
      .flatMap((item) => extractCandidateTerms(`${item.title} ${item.text}`))
  )).slice(0, 120);

  return {
    segmentCount: segments.length,
    medianWordsPerSegment: median(lengths),
    termDocFreq: compactFreq,
    termFirstSeenSegment: compactFirstSeen,
    summaryFingerprint: truncate(summaryText, 300),
    highlightFingerprint: highlightWindows.map((item) => `${item.start}:${item.end}:${item.title}:${item.text}`).join("|").slice(0, 600),
    summaryTerms,
    highlightTerms,
    highlightWindows,
  };
}

async function getVideoFeatures(userId, videoId, segments) {
  const insightSnapshot = await getInsightSnapshot(userId, videoId);
  const cacheKey = `proactive_features:${videoId}`;
  const cached = await redisService.getTemp(userId, cacheKey);
  const summaryFingerprint = truncate(normalizeText(insightSnapshot.summary || ""), 300);
  const highlightFingerprint = buildInsightWindows(insightSnapshot.highlights)
    .map((item) => `${item.start}:${item.end}:${item.title}:${item.text}`)
    .join("|")
    .slice(0, 600);
  if (
    cached?.segmentCount === segments.length &&
    cached?.termDocFreq &&
    cached?.summaryFingerprint === summaryFingerprint &&
    cached?.highlightFingerprint === highlightFingerprint
  ) {
    return cached;
  }

  const features = buildVideoFeatures(segments, insightSnapshot);
  await redisService.setTemp(userId, cacheKey, features, 86400);
  return features;
}

function computeDefinitionScore(segmentText, segmentTerms, featureTerms, state) {
  const text = normalizeText(segmentText);
  const lower = text.toLowerCase();
  if (!text) return 0;

  const strongPatterns = countMatches(lower, [/\bdefined as\b/, /\brefers to\b/, /\bin other words\b/, /\bmeans\b/]);
  const mediumPatterns = countMatches(lower, [/\bis\s+(an?|the)\b/, /\bare\s+(an?|the)\b/, /:\s+[a-z]/, /\([^)]{3,40}\)/]);

  let noveltyBoost = 0;
  const seen = state.termSeen || {};
  for (const term of segmentTerms) {
    if (!featureTerms[term]) continue;
    if (!seen[term]) noveltyBoost += 1;
  }

  const shortExplanatory = tokenizeWords(text).length <= 35 ? 0.12 : 0;
  const score =
    Math.min(0.45, strongPatterns * 0.25) +
    Math.min(0.28, mediumPatterns * 0.1) +
    Math.min(0.22, noveltyBoost * 0.05) +
    shortExplanatory;

  return Math.min(1, score);
}

function computeComplexityScore(segmentText, segmentTerms, features, state) {
  const text = normalizeText(segmentText);
  const lower = text.toLowerCase();
  if (!text) return 0;

  const words = tokenizeWords(text);
  const punctuationHits = (text.match(/[,:;()]/g) || []).length;
  const acronyms = extractAcronyms(text).length;
  const baseline = Math.max(12, toNumber(features?.medianWordsPerSegment, 18));

  let lexiconHits = 0;
  for (const term of COMPLEX_LEXICON) {
    if (lower.includes(term)) lexiconHits += 1;
  }

  const seen = state.termSeen || {};
  let novelTermCount = 0;
  for (const term of segmentTerms) {
    if (!features?.termDocFreq?.[term]) continue;
    if (!seen[term]) novelTermCount += 1;
  }

  const lenScore = words.length > baseline * 1.2 ? 0.2 : words.length > baseline ? 0.12 : 0;
  const punctScore = punctuationHits >= 4 ? 0.15 : punctuationHits >= 2 ? 0.08 : 0;
  const acronymScore = acronyms >= 2 ? 0.18 : acronyms === 1 ? 0.08 : 0;
  const lexiconScore = Math.min(0.28, lexiconHits * 0.12);
  const noveltyScore = Math.min(0.22, novelTermCount * 0.05);

  return Math.min(1, lenScore + punctScore + acronymScore + lexiconScore + noveltyScore);
}

function computeSegmentImportanceScore(segmentText, currentTime, features) {
  const text = normalizeText(segmentText);
  if (!text) return 0;

  const segmentTerms = new Set(extractCandidateTerms(text));
  const summaryTerms = new Set(Array.isArray(features?.summaryTerms) ? features.summaryTerms : []);
  const highlightTerms = new Set(Array.isArray(features?.highlightTerms) ? features.highlightTerms : []);

  let summaryOverlap = 0;
  for (const term of segmentTerms) {
    if (summaryTerms.has(term)) summaryOverlap += 1;
  }

  let highlightOverlap = 0;
  for (const term of segmentTerms) {
    if (highlightTerms.has(term)) highlightOverlap += 1;
  }

  const summaryScore = Math.min(0.32, summaryOverlap * 0.06);
  const highlightScore = Math.min(0.34, highlightOverlap * 0.07);

  const time = toNumber(currentTime, Number.NaN);
  let timingScore = 0;
  if (Number.isFinite(time) && Array.isArray(features?.highlightWindows)) {
    for (const window of features.highlightWindows) {
      const start = toNumber(window?.start, Number.NaN);
      const end = toNumber(window?.end, Number.NaN);
      if (!Number.isFinite(start) || !Number.isFinite(end)) continue;
      if (time >= start - 8 && time <= end + 8) {
        timingScore = 0.34;
        break;
      }
    }
  }

  return Math.min(1, summaryScore + highlightScore + timingScore);
}

function updateSeenTerms(state, terms) {
  const seen = state.termSeen || {};
  for (const term of terms) {
    seen[term] = 1;
  }
  const keys = Object.keys(seen);
  if (keys.length > 800) {
    const trimmed = {};
    for (let i = keys.length - 800; i < keys.length; i += 1) {
      const key = keys[i];
      if (key) trimmed[key] = 1;
    }
    state.termSeen = trimmed;
    return;
  }
  state.termSeen = seen;
}

function hasRhetoricalQuestion(text) {
  return normalizeText(text).includes("?");
}

function hasBoundaryCue(text) {
  const lower = normalizeText(text).toLowerCase();
  if (!lower) return false;
  return /\b(now let'?s|let'?s move|moving on|next,|next we|in this section|the next part|another key|up next|finally|to summarize|we'?ll look at|we will look at|let'?s talk about)\b/.test(lower);
}

function isLikelySectionBoundary({ segments, segment, currentTime }) {
  if (!segment || !Number.isInteger(segment.index)) return false;

  const previous = Array.isArray(segments) ? segments[segment.index - 1] : null;
  const previousEnd = toNumber(previous?.end, toNumber(previous?.endSec, toNumber(segment.start, 0)));
  const currentStart = toNumber(segment.start, 0);
  const gapSeconds = Math.max(0, currentStart - previousEnd);
  const freshAtBoundary = toNumber(currentTime, 0) <= currentStart + 6;

  if (!freshAtBoundary) return false;
  if (currentStart <= 20) return true;
  if (gapSeconds >= 2.5) return true;
  return hasBoundaryCue(segment.text);
}

function getSegmentAtTime(segments, currentTime) {
  if (!Array.isArray(segments) || segments.length === 0) return null;
  const time = toNumber(currentTime, 0);
  for (let i = 0; i < segments.length; i += 1) {
    const segment = segments[i] || {};
    const start = toNumber(segment.start, toNumber(segment.startSec, 0));
    const end = toNumber(segment.end, toNumber(segment.endSec, start + 6));
    if (time >= start && time <= end) {
      return {
        index: i,
        start,
        end,
        text: normalizeText(segment.text || ""),
      };
    }
  }
  return null;
}

function buildSegmentContext(segments, segment) {
  if (!segment || !Number.isInteger(segment.index) || !Array.isArray(segments) || segments.length === 0) {
    return "";
  }

  const previous = segments[segment.index - 1];
  const current = segments[segment.index];
  const next = segments[segment.index + 1];
  const items = [];

  if (previous?.text) items.push(`Previous: ${truncate(normalizeText(previous.text), 220)}`);
  if (current?.text) items.push(`Current: ${truncate(normalizeText(current.text), 260)}`);
  if (next?.text) items.push(`Next: ${truncate(normalizeText(next.text), 220)}`);

  return items.join("\n");
}

async function getSegments(userId, videoId) {
  console.log(`[FEATURES] Getting segments for user ${userId}, video ${videoId}`);
  
  const draftSegments = await redisService.getTemp(userId, `draft_segments:${videoId}`);
  if (Array.isArray(draftSegments) && draftSegments.length > 0) {
    console.log(`[FEATURES] Returning ${draftSegments.length} draft segments from Redis`);
    return draftSegments;
  }

  const video = await db.getVideo(videoId);
  let meta = {};
  try {
    meta = video && (typeof video.metadata === "string" ? JSON.parse(video.metadata || "{}") : (video.metadata || {}));
  } catch {
    meta = {};
  }
  
  const fromMeta = meta?.whisper?.segments;
  if (Array.isArray(fromMeta) && fromMeta.length > 0) {
    console.log(`[FEATURES] Returning ${fromMeta.length} segments from video metadata`);
    return fromMeta;
  }
  
  console.log(`[FEATURES] No segments found for video ${videoId}`);
  return [];
}

module.exports = {
  extractCandidateTerms,
  getVideoFeatures,
  computeDefinitionScore,
  computeComplexityScore,
  computeSegmentImportanceScore,
  updateSeenTerms,
  hasRhetoricalQuestion,
  isLikelySectionBoundary,
  getSegmentAtTime,
  buildSegmentContext,
  getSegments,
};
