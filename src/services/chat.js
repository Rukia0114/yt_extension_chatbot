const db = require("./database");
const redisService = require("./redis");
const { MODES } = require("../commands/mode");
const proactiveService = require("./proactive");
const { buildRagContext } = require("./retrieval");
const { sanitizeBotText } = require("../utils/formatting");
const sessionManager = require("../utils/session");
const PROACTIVE_REPLY_WINDOW_SECONDS = Number(process.env.PROACTIVE_REPLY_WINDOW_SECONDS || 240);
const SHORT_REPLY_MAX_CHARS = Number(process.env.PROACTIVE_SHORT_REPLY_MAX_CHARS || 40);
const FRIENDLY_COMMENT_CACHE_TTL_SECONDS = 6 * 60 * 60;
const FRIENDLY_COMMENT_FETCH_TIMEOUT_MS = 2200;
const CHAT_INTENT_CACHE_VERSION = "v2";
const CHAT_STOP_WORDS = new Set([
  "the", "a", "an", "and", "or", "but", "if", "then", "else", "to", "of", "in", "on", "for", "with",
  "from", "at", "by", "as", "is", "are", "was", "were", "be", "been", "being", "this", "that", "these",
  "those", "it", "its", "they", "them", "their", "we", "our", "you", "your", "i", "my", "me", "he", "she",
  "his", "her", "what", "which", "who", "whom", "how", "when", "where", "why", "can", "could", "should",
  "would", "will", "just", "about", "into", "over", "under", "than", "also", "more", "most", "very",
  "please", "video", "videos", "here", "there", "something", "anything", "someone", "anyone", "thing", "stuff",
]);
const CHAT_META_TERMS = new Set([
  "rag", "retrieval", "augmented", "generation", "ai", "bot", "model", "llm", "prompt", "system", "extension",
  "algorithm", "database", "api", "backend",
]);

function truncate(text, maxLen) {
  if (!text) return "";
  return text.length > maxLen ? text.slice(0, maxLen) + "..." : text;
}

function withTimeout(promise, timeoutMs, fallbackValue) {
  return Promise.race([
    promise,
    new Promise((resolve) => setTimeout(() => resolve(fallbackValue), timeoutMs)),
  ]);
}

function normalizeText(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function shouldAllowFriendlyEmoji(userMessage) {
  const text = String(userMessage || "");
  const normalized = normalizeText(text);
  const lower = normalized.toLowerCase();
  if (!lower) return false;

  if (/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/u.test(text)) return true;
  if (/[!?]{2,}/.test(text)) return true;
  if (/\b(?:haha|hehe|lol|lmao|omg|aw+|aww+|yess+|yay+|bro|pls|pls+|thx|thanks+)\b/i.test(lower)) return true;
  if (/\b(?:hi|hello|hey|yo|sup|nice|cool|wow)\b/i.test(lower) && tokenize(lower).length <= 8) return true;
  return false;
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

function isGuestUserId(userId) {
  return String(userId || "").startsWith("guest:");
}

async function ensureVideoRowForConversation(userId, videoId, video) {
  if (isGuestUserId(userId)) return null;
  if (video?.video_id || video?.videoId) return video;

  let url = `https://www.youtube.com/watch?v=${videoId}`;
  let title = null;
  try {
    const current = await sessionManager.getCurrentVideo(userId);
    const currentVideoId = String(current?.video_id || "");
    if (currentVideoId === String(videoId)) {
      if (current?.url) url = String(current.url);
      if (current?.title) title = String(current.title);
    }
  } catch {
    // Fallback to derived URL only.
  }

  await db.saveVideo(videoId, {
    url,
    title,
    description: null,
    duration: null,
    thumbnail_url: null,
    channel_name: null,
    channel_id: null,
    transcript: null,
    metadata: { source: "session" },
  });

  return db.getVideo(videoId);
}

function tokenize(text) {
  return normalizeText(text)
    .toLowerCase()
    .match(/[a-z][a-z0-9-]{1,29}/g) || [];
}

function informativeTokens(text) {
  return tokenize(text).filter((token) => token.length >= 4 && !CHAT_STOP_WORDS.has(token));
}

function hasVideoContext(videoContext, transcript) {
  return !!(
    normalizeText(videoContext?.summary || "") ||
    normalizeText(videoContext?.highlights || "") ||
    normalizeText(transcript || "")
  );
}

function parseJsonObjectFromText(raw) {
  const text = String(raw || "").trim();
  if (!text) return null;
  const withoutFence = text
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/```$/i, "")
    .trim();
  const start = withoutFence.indexOf("{");
  const end = withoutFence.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) return null;
  try {
    return JSON.parse(withoutFence.slice(start, end + 1));
  } catch {
    return null;
  }
}

function looksLikeNonsenseMessage(message) {
  const text = normalizeText(message);
  if (!text) return true;

  const lower = text.toLowerCase();
  if (/^(.)\1{4,}$/.test(lower.replace(/\s+/g, ""))) return true;
  if (/^[^a-zA-Z]*$/.test(text)) return true;
  if (/^(?:lol|lmao|haha|hehe|hmm|uh+|umm+|asdf+|qwerty+|idk)\W*$/i.test(lower)) return true;

  const tokens = tokenize(text);
  const informative = informativeTokens(text);
  if (tokens.length <= 2 && informative.length === 0 && !text.includes("?")) return true;

  const lettersOnly = lower.replace(/[^a-z]/g, "");
  if (lettersOnly.length >= 8) {
    const vowelCount = (lettersOnly.match(/[aeiou]/g) || []).length;
    if (vowelCount / lettersOnly.length < 0.18 && informative.length === 0) return true;
  }

  return false;
}

function looksLikeHardNonsenseMessage(message) {
  const text = normalizeText(message);
  if (!text) return true;

  const lower = text.toLowerCase();
  if (/^(.)\1{4,}$/.test(lower.replace(/\s+/g, ""))) return true;
  if (/^[^a-zA-Z]*$/.test(text)) return true;
  if (/^(?:lol|lmao|haha|hehe|hmm|uh+|umm+|asdf+|qwerty+|idk)\W*$/i.test(lower)) return true;

  const informative = informativeTokens(text);
  const tokens = tokenize(text);
  if (tokens.length <= 1 && informative.length === 0 && !text.includes("?")) return true;

  const lettersOnly = lower.replace(/[^a-z]/g, "");
  if (lettersOnly.length >= 8) {
    const vowelCount = (lettersOnly.match(/[aeiou]/g) || []).length;
    if (vowelCount / lettersOnly.length < 0.18 && informative.length === 0) return true;
  }

  return false;
}

function looksLikeGreetingMessage(message) {
  return /^(hi|hello|hey|yo|sup|good morning|good afternoon|good evening|hiya|heya)\b[!. ]*$/i.test(
    normalizeText(message)
  );
}

function looksLikeAssistantPersonalQuestion(message) {
  const text = normalizeText(message).toLowerCase();
  if (!text) return false;
  if (
    /\b(?:about|in)\s+(?:this|the)\s+(?:video|talk|part|idea|topic)\b/.test(text) ||
    /\bwhat\s+stands\s+out\b/.test(text)
  ) {
    return false;
  }
  return (
    /\b(?:do|did|would|can)\s+you\s+(?:like|prefer|enjoy|love|hate)\b/.test(text) ||
    /\bwhat(?:'s| is)\s+your\s+(?:favorite|preferred)\b/.test(text) ||
    /\bwhich\s+(?:video|part|idea|topic)\s+do\s+you\s+(?:like|prefer|enjoy)\b/.test(text) ||
    /\bwhat\s+is\s+the\s+(?:video|part|idea|topic)\s+you\s+(?:like|prefer|enjoy)\b/.test(text)
  );
}

function looksLikeVideoOpinionQuestion(message) {
  const text = normalizeText(message).toLowerCase();
  if (!text) return false;
  return (
    /\bdo\s+you\s+(?:love|like|enjoy)\s+(?:this|the)\s+(?:video|talk)\b/.test(text) ||
    /\bwould\s+you\s+(?:love|like|enjoy)\s+(?:this|the)\s+(?:video|talk)\b/.test(text) ||
    /\bwhat\s+do\s+you\s+(?:like|enjoy|love|find interesting)\s+about\s+(?:this|the)\s+(?:video|talk)\b/.test(text) ||
    /\bwhat\s+stands\s+out\s+(?:about|in)\s+(?:this|the)\s+(?:video|talk)\b/.test(text) ||
    /\bwhich\s+(?:part|idea|point|habit|lesson)\s+do\s+you\s+(?:like|prefer|find most interesting)\s+(?:in|about)\s+(?:this|the)\s+(?:video|talk)\b/.test(text) ||
    /\bwhat\s+is\s+good\s+about\s+(?:this|the)\s+(?:video|talk)\b/.test(text)
  );
}

function looksLikeDirectVideoFeelingQuestion(message) {
  const text = normalizeText(message).toLowerCase();
  if (!text) return false;
  return (
    /\bdo\s+you\s+(?:love|like|enjoy)\s+(?:this|the)\s+(?:video|talk)\b/.test(text) ||
    /\bwould\s+you\s+(?:love|like|enjoy)\s+(?:this|the)\s+(?:video|talk)\b/.test(text)
  );
}

function rewriteVideoOpinionQuestion(message) {
  if (!looksLikeVideoOpinionQuestion(message)) return normalizeText(message);
  const text = normalizeText(message).toLowerCase();
  if (looksLikeDirectVideoFeelingQuestion(text)) {
    return "Does this video come across as compelling, enjoyable, or inspiring? Give a direct stance first, then briefly say why using only the video's actual ideas and evidence.";
  }
  if (/\bwhat\s+stands\s+out\b/.test(text)) {
    return "What stands out most positively in this video overall?";
  }
  if (/\bwhat\s+is\s+good\s+about\b/.test(text)) {
    return "What is strongest or most valuable about this video overall?";
  }
  if (/\bwhich\s+(?:part|idea|point|habit|lesson)\b/.test(text)) {
    return "Which idea or part stands out most positively in this video, and why?";
  }
  return "What stands out most positively in this video overall, and why?";
}

function looksLikeGenericVideoQuestion(message) {
  return /\b(summary|summarize|main point|key point|key takeaway|takeaway|highlight|highlights|transcript|speaker|talking about|this part|that part|explain this|explain that|what does .* mean|what did .* mean)\b/i.test(
    normalizeText(message)
  );
}

function looksLikeSystemMetaQuestion(message) {
  const tokens = tokenize(message);
  if (!tokens.length) return false;

  const hasMetaTerm = tokens.some((token) => CHAT_META_TERMS.has(token));
  if (!hasMetaTerm) return false;

  return /\b(what is|what are|tell me about|about|explain|define|definition|how does|how do|why|mean|work|working|using|used|here|this app|this bot|this system)\b/i.test(
    normalizeText(message)
  );
}

function transcriptMentionsMetaTerms(message, transcript) {
  const messageMetaTerms = tokenize(message).filter((token) => CHAT_META_TERMS.has(token));
  if (messageMetaTerms.length === 0) return false;
  const transcriptTokens = new Set(tokenize(truncate(transcript, 12000)));
  return messageMetaTerms.some((token) => transcriptTokens.has(token));
}

function looksLikeContextualFollowUp(message, recent) {
  const text = normalizeText(message).toLowerCase();
  if (!text || !Array.isArray(recent) || recent.length === 0) return false;
  return /^(why|how|what do you mean|can you explain more|explain more|give an example|example|more|go on|continue)\??$/.test(text);
}

function lastAssistantMessageInvitesReply(recent) {
  if (!Array.isArray(recent) || recent.length === 0) return false;
  const lastAssistant = [...recent].reverse().find((item) => normalizeText(item?.response || ""));
  if (!lastAssistant?.response) return false;
  const text = normalizeText(lastAssistant.response).toLowerCase();
  return (
    text.includes("?") ||
    /\b(if you mean|ask that|ask me|tell me|let me know|would you like|do you want|want me to|shall i|should i)\b/.test(text)
  );
}

function looksLikeBriefContextReply(message, recent) {
  const text = normalizeText(message).toLowerCase();
  if (!text || !Array.isArray(recent) || recent.length === 0) return false;
  if (!lastAssistantMessageInvitesReply(recent)) return false;
  if (/^(?:asdf|qwerty|lol|lmao|haha|hehe|hmm|umm?|uh+|idk)\W*$/i.test(text)) return false;
  return looksLikeReactiveReply(text) || /^(yes|yeah|yep|ok|okay|sure|no|nope|nah|maybe|continue|go on|this|that|it|them|same)\b/.test(text);
}

function shouldUseRecentHistory(userMessage, recent) {
  if (!Array.isArray(recent) || recent.length === 0) return false;
  if (looksLikeContextualFollowUp(userMessage, recent)) return true;
  if (looksLikeBriefContextReply(userMessage, recent)) return true;

  const normalized = normalizeText(userMessage).toLowerCase();
  if (!normalized) return false;

  const referentialPattern = /\b(this|that|it|they|them|those|these|he|she|his|her|former|latter)\b/;
  const bridgePattern = /^(and|also|then|so|but|because)\b/;
  const tokens = tokenize(userMessage);
  const informative = informativeTokens(userMessage);

  if (bridgePattern.test(normalized)) return true;
  if (referentialPattern.test(normalized) && tokens.length <= 10) return true;
  if (informative.length === 0 && tokens.length <= 5) return true;

  return false;
}

function messageMatchesTranscript(message, transcript) {
  const messageTokens = informativeTokens(message);
  if (messageTokens.length === 0) return false;

  const transcriptTokens = new Set(informativeTokens(truncate(transcript, 12000)));
  if (transcriptTokens.size === 0) return false;

  let overlap = 0;
  for (const token of messageTokens) {
    if (transcriptTokens.has(token)) overlap += 1;
  }
  return overlap / messageTokens.length >= 0.34 || overlap >= 2;
}

function shouldAnswerForCurrentVideo({ userMessage, transcript, recent, useProactiveContext, videoContext }) {
  if (useProactiveContext) return true;
  if (looksLikeContextualFollowUp(userMessage, recent)) return true;
  if (looksLikeBriefContextReply(userMessage, recent)) return true;
  if (looksLikeVideoOpinionQuestion(userMessage)) return true;
  if (looksLikeSystemMetaQuestion(userMessage) && !transcriptMentionsMetaTerms(userMessage, transcript)) return false;
  if (looksLikeGenericVideoQuestion(userMessage)) return true;
  if (looksLikeHardNonsenseMessage(userMessage)) return false;
  if (messageMatchesTranscript(userMessage, transcript)) return true;

  const normalized = normalizeText(userMessage);
  const messageTokens = informativeTokens(userMessage);
  const hasContext = hasVideoContext(videoContext, transcript);
  const isQuestionLike =
    normalized.includes("?") ||
    /\b(what|why|how|which|who|when|where|is|are|does|do|did|can|could|would|should|explain|compare|tell)\b/i.test(
      normalized
    );

  // Be permissive for normal natural-language questions or broken-English prompts when video context exists.
  if (isQuestionLike && (messageTokens.length >= 1 || tokenize(userMessage).length >= 3)) return true;
  if (hasContext && messageTokens.length >= 2) return true;
  if (hasContext && tokenize(userMessage).length >= 4 && !looksLikeNonsenseMessage(userMessage)) return true;

  return false;
}

function buildOffTopicReply(mode) {
  if (mode === "friendly") {
    return "I can help with the video, but that message does not seem related to it. Ask about the summary, a point from the talk, or something the speaker said.";
  }
  if (mode === "educational" || mode === "academic") {
    return "I only answer based on the current video and its related context. Ask about an idea from the talk, a claim the speaker makes, or a concept mentioned in the transcript.";
  }
  return "That does not seem related to the current video. Ask about the video's ideas, summary, highlights, or a specific part you want explained.";
}

function buildGreetingReply(mode) {
  if (mode === "friendly") {
    return "Hi. I can help with this video. Ask me about the main idea, a specific point, or anything the speaker said.";
  }
  if (mode === "educational" || mode === "academic") {
    return "Hi. I can help you understand this video. Ask about a concept, claim, or part of the talk you want explained.";
  }
  return "Hi. Ask me about this video's ideas, summary, highlights, or a specific part you want explained.";
}

function buildSystemMetaReply(mode) {
  if (mode === "friendly") {
    return "I can help with the current video, but that question is about the app/system rather than the video itself. Ask about the video's ideas or a specific part of the talk.";
  }
  if (mode === "educational" || mode === "academic") {
    return "That question is about the app or system, not the current video. I stay focused on explaining the video's ideas, claims, and examples.";
  }
  return "That looks like a system-level question rather than a video question. Ask about the video's ideas, summary, highlights, or a specific part you want explained.";
}

function buildAssistantPersonalReply(mode) {
  if (mode === "friendly") {
    return "I do not have personal favorites or preferences. If you mean which idea in this video stands out most, ask that and I will answer based on the video.";
  }
  if (mode === "educational" || mode === "academic") {
    return "I do not have personal preferences. If you want, ask which idea or habit seems most important in this video, and I will answer from the video's content.";
  }
  return "I do not have personal preferences. If you mean which idea or part of this video stands out most, ask that and I will answer based on the video.";
}

function buildUnclearReply(mode) {
  if (mode === "friendly") {
    return "I’m not fully sure if you mean the video or the app itself. If you mean the video, mention a point, quote, or idea from it.";
  }
  if (mode === "educational" || mode === "academic") {
    return "I’m not fully sure whether your question is about the current video or about the app/system. If you mean the video, mention the idea or part of the talk you want explained.";
  }
  return "I’m not fully sure whether you mean the current video or the app/system. If you mean the video, mention the idea, summary point, or part you want explained.";
}

function inferIntentHeuristically({ userMessage, transcript, recent, useProactiveContext, videoContext }) {
  if (looksLikeGreetingMessage(userMessage)) return { label: "greeting", confidence: 0.98, source: "heuristic" };
  if (looksLikeVideoOpinionQuestion(userMessage)) {
    return { label: "video_question", confidence: 0.9, source: "heuristic" };
  }
  if (looksLikeAssistantPersonalQuestion(userMessage)) {
    return { label: "assistant_personal", confidence: 0.8, source: "heuristic" };
  }
  if (useProactiveContext || looksLikeContextualFollowUp(userMessage, recent) || looksLikeBriefContextReply(userMessage, recent)) {
    return { label: "follow_up", confidence: 0.9, source: "heuristic" };
  }
  if (looksLikeHardNonsenseMessage(userMessage)) return { label: "nonsense", confidence: 0.97, source: "heuristic" };
  if (looksLikeSystemMetaQuestion(userMessage) && !transcriptMentionsMetaTerms(userMessage, transcript)) {
    return { label: "system_meta", confidence: 0.9, source: "heuristic" };
  }
  if (shouldAnswerForCurrentVideo({ userMessage, transcript, recent, useProactiveContext, videoContext })) {
    return { label: "video_question", confidence: 0.72, source: "heuristic" };
  }
  return { label: "unclear", confidence: 0.45, source: "heuristic" };
}

async function classifyMessageIntent({
  llmBaseUrl,
  llmModel,
  userId,
  videoId,
  userMessage,
  transcript,
  videoContext,
  recent,
  useProactiveContext,
}) {
  const heuristic = inferIntentHeuristically({ userMessage, transcript, recent, useProactiveContext, videoContext });
  if (heuristic.label === "greeting" || heuristic.label === "nonsense") {
    return heuristic;
  }

  const summary = normalizeText(videoContext?.summary || "");
  const highlights = normalizeText(videoContext?.highlights || "");
  const transcriptPreview = truncate(normalizeText(transcript || ""), 600);
  const recentAssistant = Array.isArray(recent) && recent.length > 0
    ? truncate(normalizeText(recent[recent.length - 1]?.response || ""), 240)
    : "";

  const cacheKey = `intent_classifier:${videoId}:${Buffer.from(
    JSON.stringify({
      version: CHAT_INTENT_CACHE_VERSION,
      message: normalizeText(userMessage),
      summary: truncate(summary, 220),
      recentAssistant,
      heuristic: heuristic.label,
    })
  ).toString("base64").slice(0, 120)}`;
  const cached = await redisService.getTemp(userId, cacheKey).catch(() => null);
  if (cached?.label) return cached;

  const raw = await callLLM({
    llmBaseUrl,
    llmModel,
    temperature: 0,
    maxTokens: 120,
    messages: [
      {
        role: "system",
        content:
          "Classify the user's intent. Return ONLY JSON with keys label, confidence, reason.\n" +
          "Allowed labels: video_question, follow_up, system_meta, assistant_personal, greeting, nonsense, unclear.\n" +
          "- video_question: asking about the video's content or ideas\n" +
          "- video_question ALSO includes evaluative questions about the current video, such as what stands out, what is good, or what you like about this video\n" +
          "- follow_up: depends on earlier reply/context\n" +
          "- system_meta: asks about the app, bot, RAG, model, system, prompt, extension, backend, API, etc.\n" +
          "- assistant_personal: asks for the assistant's own favorite, preference, opinion, or taste rather than the video's content\n" +
          "- greeting: hello/hi style message\n" +
          "- nonsense: gibberish or contentless noise\n" +
          "- unclear: ambiguous between video and system/app",
      },
      {
        role: "user",
        content:
          `User message: ${normalizeText(userMessage)}\n\n` +
          `Video summary: ${summary || "(none)"}\n\n` +
          `Video highlights: ${highlights || "(none)"}\n\n` +
          `Recent assistant reply: ${recentAssistant || "(none)"}\n\n` +
          `Transcript preview: ${transcriptPreview || "(none)"}\n\n` +
          `Heuristic guess: ${heuristic.label}`,
      },
    ],
  }).catch(() => "");

  const parsed = parseJsonObjectFromText(raw);
  const label = String(parsed?.label || "").trim().toLowerCase();
  const confidence = Number(parsed?.confidence);
  const allowed = new Set(["video_question", "follow_up", "system_meta", "assistant_personal", "greeting", "nonsense", "unclear"]);
  const out =
    allowed.has(label) && Number.isFinite(confidence) && confidence >= 0.58
      ? {
          label,
          confidence,
          reason: normalizeText(parsed?.reason || ""),
          source: "classifier",
        }
      : heuristic;

  await redisService.setTemp(userId, cacheKey, out, 1800).catch(() => {});
  return out;
}

function buildReplyForIntent(intentLabel, mode) {
  if (intentLabel === "greeting") return buildGreetingReply(mode);
  if (intentLabel === "system_meta") return buildSystemMetaReply(mode);
  if (intentLabel === "assistant_personal") return buildAssistantPersonalReply(mode);
  if (intentLabel === "nonsense") return buildOffTopicReply(mode);
  if (intentLabel === "unclear") return buildUnclearReply(mode);
  return "";
}

function prefersDirectAnswer(userMessage) {
  const normalized = normalizeText(userMessage).toLowerCase();
  const tokens = tokenize(userMessage);
  if (!normalized) return false;
  if (tokens.length > 14) return false;
  if (/\b(why|how|explain|compare|analyze|analysis|example|examples|step by step|in detail|deep|depth)\b/.test(normalized)) {
    return false;
  }
  return /\b(what is|what's|which|who|when|where|best|main|key|top|biggest|most important|takeaway)\b/.test(normalized);
}

function getAnswerStyleInstruction(mode, userMessage) {
  if (mode === "friendly" && looksLikeDirectVideoFeelingQuestion(userMessage)) {
    return "Answer with a direct stance in the first sentence, such as 'Yeah, it feels pretty inspiring' or 'It comes across as genuinely motivating,' then add one or two brief grounded reasons. Do NOT say you lack feelings or personal preferences for this kind of question.";
  }
  if (prefersDirectAnswer(userMessage)) {
    return "Answer briefly and directly. Use plain paragraphs only. Do NOT use headings, labels, numbered lists, or sections like Main idea, Explanation, Example, or Key takeaway unless the user explicitly asked for that format.";
  }
  if (mode === "friendly") {
    return "Keep the answer compact and conversational. Prefer one short paragraph or a few short lines. Avoid heavy structure unless the user asks for it.";
  }
  if (mode === "normal") {
    return "Answer directly first, then add only a small amount of explanation. Avoid long sectioned formatting unless the user explicitly asks for structure.";
  }
  return "Use structure only when it genuinely improves clarity. Prefer natural plain-text paragraphs over labeled sections unless the user explicitly asks for a structured explanation.";
}

function getDynamicMaxTokens(modeConfig, userMessage) {
  if (modeConfig === MODES?.friendly && looksLikeDirectVideoFeelingQuestion(userMessage)) {
    return Math.min(modeConfig.maxTokens || 220, 120);
  }
  if (looksLikeVideoOpinionQuestion(userMessage)) return Math.min(modeConfig.maxTokens || 220, 180);
  if (prefersDirectAnswer(userMessage)) return Math.min(modeConfig.maxTokens || 220, 220);
  return modeConfig.maxTokens;
}

async function getVideoUnderstandingContext(userId, videoId, video) {
  const meta = parseMetadata(video);
  const draft = await redisService.getTemp(userId, `draft_collection:${videoId}`);

  const summary =
    typeof draft?.summary === "string" && draft.summary.trim()
      ? draft.summary.trim()
      : (typeof meta.summary === "string" ? meta.summary.trim() : "");
  const highlights = Array.isArray(draft?.highlights)
    ? draft.highlights
    : (Array.isArray(meta.highlights) ? meta.highlights : []);

  const compactHighlights = highlights
    .slice(0, 5)
    .map((item, index) => {
      const title = normalizeText(item?.title || "");
      const text = normalizeText(item?.text || "");
      if (title && text) return `${index + 1}. ${title}: ${truncate(text, 180)}`;
      if (title) return `${index + 1}. ${title}`;
      if (text) return `${index + 1}. ${truncate(text, 180)}`;
      return "";
    })
    .filter(Boolean)
    .join("\n");

  return {
    summary,
    highlights: compactHighlights,
  };
}

function normalizeCommentText(value) {
  return normalizeText(sanitizeBotText(value || ""));
}

async function fetchFriendlyViewerReactionContext(videoId) {
  const normalizedVideoId = String(videoId || "").trim();
  const apiKey = String(process.env.YOUTUBE_API_KEY || "").trim();
  if (!normalizedVideoId || !apiKey) return "";

  const cacheKey = `friendly_comment_context:${normalizedVideoId}`;
  const cached = await redisService.getTemp(0, cacheKey).catch(() => null);
  if (typeof cached === "string") return cached;

  const url =
    "https://www.googleapis.com/youtube/v3/commentThreads" +
    `?part=snippet&videoId=${encodeURIComponent(normalizedVideoId)}` +
    `&maxResults=8&order=relevance&textFormat=plainText&key=${encodeURIComponent(apiKey)}`;

  const resp = await fetch(url).catch(() => null);
  if (!resp?.ok) return "";

  const data = await resp.json().catch(() => ({}));
  const items = Array.isArray(data?.items) ? data.items : [];
  const selected = items
    .map((item) => {
      const snippet = item?.snippet?.topLevelComment?.snippet || {};
      const text = normalizeCommentText(snippet?.textOriginal || snippet?.textDisplay || "");
      const likeCount = Number(snippet?.likeCount || 0);
      if (!text || text.length < 30 || text.length > 220) return null;
      if (/https?:\/\//i.test(text)) return null;
      return {
        text,
        likeCount: Number.isFinite(likeCount) ? likeCount : 0,
      };
    })
    .filter(Boolean)
    .sort((a, b) => b.likeCount - a.likeCount || b.text.length - a.text.length);

  const seen = new Set();
  const comments = [];
  for (const item of selected) {
    const key = item.text.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    comments.push(item);
    if (comments.length >= 3) break;
  }

  const context = comments.length
    ? comments.map((item, index) => `${index + 1}. ${truncate(item.text, 180)}`).join("\n")
    : "";

  if (context) {
    await redisService.setTemp(0, cacheKey, context, FRIENDLY_COMMENT_CACHE_TTL_SECONDS).catch(() => {});
  }
  return context;
}

function getModeSpecificSystemInstruction(mode, userMessage = "") {
  if (mode === "friendly") {
    if (looksLikeDirectVideoFeelingQuestion(userMessage)) {
      return "For direct feeling questions about the current video, answer as a warm evaluative reaction to the content itself, not as a literal statement about your own human emotions. Start with a clear stance, then briefly support it with concrete ideas from the video. Avoid disclaimers like 'I don't have feelings' or 'I don't have personal preferences' here.";
    }
    if (looksLikeVideoOpinionQuestion(userMessage)) {
      return "For friendly mode, sound warm but stay tightly grounded. For opinion-like questions about the current video, answer in 2 or 3 sentences max, mention only concrete ideas actually supported by the summary, highlights, or transcript evidence, and do not invent extra details, examples, jokes, tone shifts, or audience reactions.";
    }
    if (!shouldAllowFriendlyEmoji(userMessage)) {
      return "For friendly mode, keep the tone warm and natural, but avoid emoji or chat-style reactions unless the user's own tone is clearly casual or playful.";
    }
    return "For friendly mode, sound natural and socially aware. If viewer reactions from YouTube comments are provided, use them only as light audience context and never as factual proof. For emotional or opinion-like questions about the current video, answer with warm, content-grounded language about what feels inspiring, powerful, enjoyable, relatable, or meaningful in the video instead of sounding detached.";
  }
  if (mode === "normal") {
    return "For normal mode, prioritize the video's summary and highlights. Use transcript evidence only when it directly supports the answer or clarifies a specific point the user asked about.";
  }
  return "For educational mode, teach in two layers: explain from the video's overall ideas first, then support or refine that explanation with transcript evidence. If evidence is limited, say so plainly.";
}

function buildUserQuestionContext({
  mode,
  modeConfig,
  videoContext,
  ragContext,
  transcript,
  viewerReactionContext,
  useProactiveContext,
  userMessage,
}) {
  const sections = [];
  const isVideoOpinion = looksLikeVideoOpinionQuestion(userMessage);

  if (videoContext.summary) {
    sections.push(`Video summary:\n${truncate(videoContext.summary, 1800)}`);
  }
  if (videoContext.highlights) {
    sections.push(`Video highlights:\n${videoContext.highlights}`);
  }

  if (mode === "friendly" && viewerReactionContext && !isVideoOpinion) {
    sections.push(
      `Viewer reactions from YouTube comments (social context only, not factual evidence):\n${viewerReactionContext}`
    );
  }

  if (ragContext.transcriptContext) {
    sections.push(
      `${mode === "educational" ? "Transcript evidence" : "Relevant transcript evidence"}:\n${ragContext.transcriptContext}`
    );
  }

  if (ragContext.externalContext) {
    sections.push(`External reference context from trusted sources:\n${ragContext.externalContext}`);
  }

  const shouldIncludeTranscriptBackup =
    !!transcript &&
    (
      mode === "educational" ||
      (!videoContext.summary && !videoContext.highlights)
    );

  if (shouldIncludeTranscriptBackup) {
    const transcriptChars = mode === "friendly"
      ? Math.min(modeConfig.transcriptChars || 1600, 1600)
      : (modeConfig.transcriptChars || 6000);
    sections.push(`Full transcript for backup only (truncated):\n${truncate(transcript, transcriptChars)}`);
  }

  if (useProactiveContext) {
    sections.push(
      "The user is likely replying to the proactive prompt above.\n" +
      "Interpret their short reply in that context and continue naturally.\n" +
      `User reply: ${userMessage}`
    );
  } else {
    sections.push(`User question: ${userMessage}`);
  }

  return sections.filter(Boolean).join("\n\n");
}

function looksLikeReactiveReply(message) {
  const text = normalizeText(message).toLowerCase();
  if (!text) return false;
  if (text.length > SHORT_REPLY_MAX_CHARS) return false;
  if (text.includes("?")) return false;

  const ackLike = new Set([
    "ok",
    "okay",
    "yes",
    "yep",
    "yeah",
    "no",
    "nope",
    "nah",
    "idk",
    "not sure",
    "dont know",
    "don't know",
    "nothing",
    "none",
    "skip",
    "continue",
    "go on",
    "next",
    "sure",
    "fine",
    "got it",
  ]);

  if (ackLike.has(text)) return true;
  if (text.split(/\s+/).length <= 4) return true;
  return false;
}

async function callLLM({ llmBaseUrl, llmModel, messages, temperature, maxTokens }) {
  const resp = await fetch(`${llmBaseUrl}/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: llmModel,
      messages,
      stream: false,
      temperature,
      ...(Number.isFinite(maxTokens) ? { max_tokens: maxTokens } : {}),
    }),
  });

  if (!resp.ok) {
    const t = await resp.text().catch(() => "");
    throw new Error(t || `LLM HTTP ${resp.status}`);
  }

  const data = await resp.json().catch(() => ({}));
  return String(data?.choices?.[0]?.message?.content || "").trim();
}

async function callLLMStream({ llmBaseUrl, llmModel, messages, temperature, maxTokens, onDelta }) {
  const resp = await fetch(`${llmBaseUrl}/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: llmModel,
      messages,
      stream: true,
      temperature,
      ...(Number.isFinite(maxTokens) ? { max_tokens: maxTokens } : {}),
    }),
  });

  if (!resp.ok) {
    const t = await resp.text().catch(() => "");
    throw new Error(t || `LLM HTTP ${resp.status}`);
  }

  if (!resp.body) return "";

  const decoder = new TextDecoder();
  let buffer = "";
  let fullText = "";

  for await (const chunk of resp.body) {
    buffer += decoder.decode(chunk, { stream: true });

    while (true) {
      const boundary = buffer.indexOf("\n\n");
      if (boundary === -1) break;
      const eventBlock = buffer.slice(0, boundary);
      buffer = buffer.slice(boundary + 2);

      const lines = eventBlock
        .split("\n")
        .map((line) => line.trim())
        .filter((line) => line.startsWith("data:"));

      for (const line of lines) {
        const payload = line.replace(/^data:\s*/, "");
        if (!payload || payload === "[DONE]") continue;
        let parsed;
        try {
          parsed = JSON.parse(payload);
        } catch {
          continue;
        }
        const delta = String(parsed?.choices?.[0]?.delta?.content || "");
        if (!delta) continue;
        fullText += delta;
        if (typeof onDelta === "function") await onDelta(delta);
      }
    }
  }

  return fullText.trim();
}

async function getMode(userId, videoId) {
  const modeData = await redisService.getTemp(userId, `chat_mode:${videoId}`);
  if (modeData?.mode && MODES[modeData.mode]) return modeData.mode;
  if (isGuestUserId(userId)) return "friendly";

  const video = await db.getVideo(videoId);
  if (video?.metadata) {
    const meta =
      typeof video.metadata === "string"
        ? JSON.parse(video.metadata || "{}")
        : video.metadata;
    if (meta?.chatMode && MODES[meta.chatMode]) return meta.chatMode;
  }

  return "friendly";
}

async function chatForVideo({ userId, videoId, userMessage }) {
  if (!userMessage || !userMessage.trim()) throw new Error("Message is required");

//   const llmBaseUrl = process.env.LLM_BASE_URL || "http://llm:11434/v1";
//   const llmModel = process.env.LLM_MODEL || "llama3.2:3b-instruct-q8_0";
const llmBaseUrl = process.env.LLM_BASE_URL || "http://host.docker.internal:11434/v1";
const llmModel = process.env.LLM_MODEL || "gpt-oss-20b";
  const effectiveUserMessage = rewriteVideoOpinionQuestion(userMessage);

  const mode = await getMode(userId, videoId);
  const modeConfig = MODES[mode] || MODES.friendly;

  const guestUser = isGuestUserId(userId);
  let video = guestUser ? null : await db.getVideo(videoId);
  video = await ensureVideoRowForConversation(userId, videoId, video);
  const videoContext = await getVideoUnderstandingContext(userId, videoId, video);
  let transcript = video?.transcript || "";

  if (!transcript) {
    const draft = await redisService.getTemp(userId, `draft_transcript:${videoId}`);
    if (draft?.text) transcript = String(draft.text);
  }

  const contextItems = await redisService.getContext(userId, videoId);
  const allRecent = Array.isArray(contextItems)
    ? contextItems.slice(-(modeConfig.historyLimit || 10))
    : [];
  const recent = shouldUseRecentHistory(userMessage, allRecent) ? allRecent : [];
  const latestProactive = await redisService.getTemp(userId, `last_proactive:${videoId}`);
  const proactiveCreatedAt = Date.parse(latestProactive?.createdAt || "");
  const proactiveAgeSec = Number.isFinite(proactiveCreatedAt)
    ? Math.max(0, (Date.now() - proactiveCreatedAt) / 1000)
    : Number.POSITIVE_INFINITY;
  const useProactiveContext =
    !!latestProactive?.text &&
    proactiveAgeSec <= PROACTIVE_REPLY_WINDOW_SECONDS &&
    looksLikeReactiveReply(userMessage);

  const intent = await classifyMessageIntent({
    llmBaseUrl,
    llmModel,
    userId,
    videoId,
    userMessage: effectiveUserMessage,
    transcript,
    videoContext,
    recent,
    useProactiveContext,
  });
  if (!["video_question", "follow_up"].includes(intent.label)) {
    const botResponse = buildReplyForIntent(intent.label, mode) || buildUnclearReply(mode);
    await redisService.addToContext(userId, videoId, userMessage, botResponse);
    if (!guestUser) {
      await db.saveConversation(userId, videoId, userMessage, botResponse);
    }
    return { reply: botResponse, mode };
  }

  const ragContext = await buildRagContext({
    userId,
    videoId,
    userMessage: effectiveUserMessage,
    mode,
    ragOptions: modeConfig.rag,
  });
  const viewerReactionContext = mode === "friendly"
    ? await withTimeout(fetchFriendlyViewerReactionContext(videoId), FRIENDLY_COMMENT_FETCH_TIMEOUT_MS, "")
    : "";

  const messages = [
    {
      role: "system",
      content:
        modeConfig.prompt +
        (recent.length === 0 && !useProactiveContext
          ? "\n\nTreat this user message as a standalone question unless it explicitly refers to a previous reply."
          : "") +
        (effectiveUserMessage !== normalizeText(userMessage)
          ? "\n\nInterpret video-opinion phrasing like 'what do you like about this video?' as a request for what stands out positively in the video, not as a question about your personal preferences."
          : "") +
        "\n\n" + getModeSpecificSystemInstruction(mode, effectiveUserMessage) +
        "\n\n" + getAnswerStyleInstruction(mode, userMessage) +
        "\n\nBase your answer on the video's overall ideas first. If a video summary or highlights are provided, treat them as the main understanding of the video. Use transcript passages as supporting evidence only, and avoid over-quoting or turning the reply into a transcript recap." +
        "\n\nIMPORTANT: Always answer the user's CURRENT question directly. Do NOT repeat previous answers.",
    },
    ...recent.flatMap((r) => [
      { role: "user", content: r.message || "" },
      { role: "assistant", content: r.response || "" },
    ]),
    ...(useProactiveContext
      ? [
          {
            role: "assistant",
            content:
              "Proactive prompt shown to user just before this reply:\n" +
              `${truncate(String(latestProactive.text || ""), 400)}`,
          },
        ]
      : []),
    {
      role: "user",
      content: buildUserQuestionContext({
        mode,
        modeConfig,
        videoContext,
        ragContext,
        transcript,
        viewerReactionContext,
        useProactiveContext,
        userMessage: effectiveUserMessage,
      }),
    },
  ];

  const rawBotResponse = await callLLM({
    llmBaseUrl,
    llmModel,
    messages,
    temperature: modeConfig.temperature ?? 0.6,
    maxTokens: getDynamicMaxTokens(modeConfig, userMessage),
  });
  const botResponse = sanitizeBotText(rawBotResponse, {
    preserveEmojis: mode === "friendly" && shouldAllowFriendlyEmoji(userMessage),
    separateFriendlyReaction: mode === "friendly" && shouldAllowFriendlyEmoji(userMessage),
    compactFriendlyReaction: mode === "friendly" && shouldAllowFriendlyEmoji(userMessage),
  });

  await redisService.addToContext(userId, videoId, userMessage, botResponse);
  if (!guestUser) {
    await db.saveConversation(userId, videoId, userMessage, botResponse);
  }
  proactiveService
    .recordUserFeedback({
      userId,
      userMessage,
      usedProactiveContext: useProactiveContext,
    })
    .catch(() => {});
  if (useProactiveContext) {
    await redisService.deleteTemp(userId, `last_proactive:${videoId}`);
  }

  return { reply: botResponse, mode };
}

async function streamChatForVideo({ userId, videoId, userMessage, onDelta }) {
  if (!userMessage || !userMessage.trim()) throw new Error("Message is required");

//   const llmBaseUrl = process.env.LLM_BASE_URL || "http://llm:11434/v1";
//   const llmModel = process.env.LLM_MODEL || "llama3.2:3b-instruct-q8_0";
const llmBaseUrl = process.env.LLM_BASE_URL || "http://host.docker.internal:1234/v1";
const llmModel = process.env.LLM_MODEL || "openai/gpt-oss-20b";
  const effectiveUserMessage = rewriteVideoOpinionQuestion(userMessage);

  const mode = await getMode(userId, videoId);
  const modeConfig = MODES[mode] || MODES.friendly;

  const guestUser = isGuestUserId(userId);
  let video = guestUser ? null : await db.getVideo(videoId);
  video = await ensureVideoRowForConversation(userId, videoId, video);
  const videoContext = await getVideoUnderstandingContext(userId, videoId, video);
  let transcript = video?.transcript || "";

  if (!transcript) {
    const draft = await redisService.getTemp(userId, `draft_transcript:${videoId}`);
    if (draft?.text) transcript = String(draft.text);
  }

  const contextItems = await redisService.getContext(userId, videoId);
  const allRecent = Array.isArray(contextItems)
    ? contextItems.slice(-(modeConfig.historyLimit || 10))
    : [];
  const recent = shouldUseRecentHistory(userMessage, allRecent) ? allRecent : [];
  const latestProactive = await redisService.getTemp(userId, `last_proactive:${videoId}`);
  const proactiveCreatedAt = Date.parse(latestProactive?.createdAt || "");
  const proactiveAgeSec = Number.isFinite(proactiveCreatedAt)
    ? Math.max(0, (Date.now() - proactiveCreatedAt) / 1000)
    : Number.POSITIVE_INFINITY;
  const useProactiveContext =
    !!latestProactive?.text &&
    proactiveAgeSec <= PROACTIVE_REPLY_WINDOW_SECONDS &&
    looksLikeReactiveReply(userMessage);

  const intent = await classifyMessageIntent({
    llmBaseUrl,
    llmModel,
    userId,
    videoId,
    userMessage: effectiveUserMessage,
    transcript,
    videoContext,
    recent,
    useProactiveContext,
  });
  if (!["video_question", "follow_up"].includes(intent.label)) {
    const botResponse = buildReplyForIntent(intent.label, mode) || buildUnclearReply(mode);
    if (typeof onDelta === "function") await onDelta(botResponse);
    await redisService.addToContext(userId, videoId, userMessage, botResponse);
    if (!guestUser) {
      await db.saveConversation(userId, videoId, userMessage, botResponse);
    }
    return { reply: botResponse, mode };
  }

  const ragContext = await buildRagContext({
    userId,
    videoId,
    userMessage: effectiveUserMessage,
    mode,
    ragOptions: modeConfig.rag,
  });
  const viewerReactionContext = mode === "friendly"
    ? await withTimeout(fetchFriendlyViewerReactionContext(videoId), FRIENDLY_COMMENT_FETCH_TIMEOUT_MS, "")
    : "";

  const messages = [
    {
      role: "system",
      content:
        modeConfig.prompt +
        (recent.length === 0 && !useProactiveContext
          ? "\n\nTreat this user message as a standalone question unless it explicitly refers to a previous reply."
          : "") +
        (effectiveUserMessage !== normalizeText(userMessage)
          ? "\n\nInterpret video-opinion phrasing like 'what do you like about this video?' as a request for what stands out positively in the video, not as a question about your personal preferences."
          : "") +
        "\n\n" + getModeSpecificSystemInstruction(mode, effectiveUserMessage) +
        "\n\n" + getAnswerStyleInstruction(mode, userMessage) +
        "\n\nBase your answer on the video's overall ideas first. If a video summary or highlights are provided, treat them as the main understanding of the video. Use transcript passages as supporting evidence only, and avoid over-quoting or turning the reply into a transcript recap." +
        "\n\nIMPORTANT: Always answer the user's CURRENT question directly. Do NOT repeat previous answers.",
    },
    ...recent.flatMap((r) => [
      { role: "user", content: r.message || "" },
      { role: "assistant", content: r.response || "" },
    ]),
    ...(useProactiveContext
      ? [
          {
            role: "assistant",
            content:
              "Proactive prompt shown to user just before this reply:\n" +
              `${truncate(String(latestProactive.text || ""), 400)}`,
          },
        ]
      : []),
    {
      role: "user",
      content: buildUserQuestionContext({
        mode,
        modeConfig,
        videoContext,
        ragContext,
        transcript,
        viewerReactionContext,
        useProactiveContext,
        userMessage: effectiveUserMessage,
      }),
    },
  ];

  const rawBotResponse = await callLLMStream({
    llmBaseUrl,
    llmModel,
    messages,
    temperature: modeConfig.temperature ?? 0.6,
    maxTokens: getDynamicMaxTokens(modeConfig, userMessage),
    onDelta,
  });
  const botResponse = sanitizeBotText(rawBotResponse, {
    preserveEmojis: mode === "friendly" && shouldAllowFriendlyEmoji(userMessage),
    separateFriendlyReaction: mode === "friendly" && shouldAllowFriendlyEmoji(userMessage),
    compactFriendlyReaction: mode === "friendly" && shouldAllowFriendlyEmoji(userMessage),
  });

  await redisService.addToContext(userId, videoId, userMessage, botResponse);
  if (!guestUser) {
    await db.saveConversation(userId, videoId, userMessage, botResponse);
  }
  proactiveService
    .recordUserFeedback({
      userId,
      userMessage,
      usedProactiveContext: useProactiveContext,
    })
    .catch(() => {});
  if (useProactiveContext) {
    await redisService.deleteTemp(userId, `last_proactive:${videoId}`);
  }

  return { reply: botResponse, mode };
}

module.exports = { chatForVideo, streamChatForVideo };