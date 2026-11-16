const sessionManager = require("../utils/session");
const {
  getLatestInsights,
  fetchLatestInsights,
  storeLatestInsights,
} = require("../services/insights");
const { sanitizeBotText } = require("../utils/formatting");

const MAX_SOURCE_CHARS = 7000;
const MAX_POLL_EXPLANATION_CHARS = 180;
const DEFAULT_QUESTION_COUNT = 3;
const MIN_QUESTION_COUNT = 3;
const MAX_QUESTION_COUNT = 5;

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

function normalizeJsonishText(text) {
  return stripCodeFences(text)
    .replace(/^\uFEFF/, "")
    .replace(/[“”]/g, '"')
    .replace(/[‘’]/g, "'")
    .replace(/,\s*([}\]])/g, "$1")
    .trim();
}

function extractJsonCandidate(text) {
  const cleaned = normalizeJsonishText(text);
  const listStart = cleaned.indexOf("[");
  const listEnd = cleaned.lastIndexOf("]");
  if (listStart >= 0 && listEnd > listStart) {
    return cleaned.slice(listStart, listEnd + 1);
  }

  const objectStart = cleaned.indexOf("{");
  const objectEnd = cleaned.lastIndexOf("}");
  if (objectStart >= 0 && objectEnd > objectStart) {
    return cleaned.slice(objectStart, objectEnd + 1);
  }

  return cleaned;
}

function parseQuestionRequest(messageText) {
  const args = normalizeSpace(String(messageText || "").split(" ").slice(1).join(" ")).toLowerCase()
    .split(/\s+/)
    .filter(Boolean);

  let type = "mixed";
  let count = DEFAULT_QUESTION_COUNT;

  for (const arg of args) {
    if (["tf", "truefalse", "true-false", "true_false", "boolean"].includes(arg)) {
      type = "true_false";
      continue;
    }
    if (["mc", "mcq", "multiple", "multiple-choice", "multiple_choice", "quiz"].includes(arg)) {
      type = "multiple_choice";
      continue;
    }

    const parsedCount = Number(arg);
    if (Number.isInteger(parsedCount)) {
      count = Math.max(MIN_QUESTION_COUNT, Math.min(MAX_QUESTION_COUNT, parsedCount));
    }
  }

  return { type, count };
}

function getTypeLabel(type) {
  if (type === "true_false") return "true/false";
  if (type === "multiple_choice") return "multiple choice";
  return "quiz";
}

function buildSourceText(currentVideo, insights) {
  const summary = truncate(insights.summary || "", 1600);
  const transcript = truncate(insights.transcript || "", MAX_SOURCE_CHARS);
  const highlights = Array.isArray(insights.highlights)
    ? insights.highlights
        .slice(0, 4)
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

async function loadQuestionSource(userId, currentVideo) {
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
      temperature: 0.35,
      max_tokens: 320,
    }),
  });

  if (!resp.ok) {
    const text = await resp.text().catch(() => "");
    throw new Error(text || `LLM HTTP ${resp.status}`);
  }

  const data = await resp.json().catch(() => ({}));
  return String(data?.choices?.[0]?.message?.content || "").trim();
}

function parseQuizPayload(item, requestedType) {
  const parsed = item || {};
  const type = parsed.type === "true_false" ? "true_false" : "multiple_choice";
  if (requestedType !== "mixed" && type !== requestedType) {
    throw new Error("Quiz type mismatch");
  }

  const question = sanitizeBotText(parsed.question || "");
  if (!question) throw new Error("Missing question");

  const explanation = truncate(sanitizeBotText(parsed.explanation || ""), MAX_POLL_EXPLANATION_CHARS);
  let correctIndex = Number(parsed.correctIndex);
  if (!Number.isInteger(correctIndex)) correctIndex = -1;

  if (type === "true_false") {
    if (correctIndex < 0 || correctIndex > 1) {
      const answerText = normalizeSpace(parsed.correctAnswer || "").toLowerCase();
      correctIndex = answerText === "false" ? 1 : 0;
    }

    return {
      type,
      question,
      options: ["True", "False"],
      correctIndex,
      explanation,
    };
  }

  const options = Array.isArray(parsed.options)
    ? parsed.options
        .map((opt) => sanitizeBotText(opt))
        .map((opt) => normalizeSpace(opt))
        .filter(Boolean)
        .slice(0, 4)
    : [];

  if (options.length !== 4) throw new Error("Invalid multiple choice options");
  if (correctIndex < 0 || correctIndex >= options.length) throw new Error("Invalid correct index");

  return {
    type,
    question,
    options,
    correctIndex,
    explanation,
  };
}

function parseQuizListPayload(rawText, requestedType, count) {
  const candidate = extractJsonCandidate(rawText);
  if (!candidate || !/^[\[{]/.test(candidate)) throw new Error("Quiz JSON not found");

  const parsed = JSON.parse(candidate);
  const items = Array.isArray(parsed) ? parsed : [parsed];
  if (items.length < 1) throw new Error("No quiz items returned");

  return items.slice(0, count).map((item) => parseQuizPayload(item, requestedType));
}

async function repairQuizJson({ rawText, requestedType, count }) {
  const repaired = await callLLM({
    messages: [
      {
        role: "system",
        content:
          "You repair malformed quiz JSON.\n" +
          "Return strict JSON only.\n" +
          `Return an array with exactly ${count} items.\n` +
          'Each item must use this shape: {"type":"multiple_choice|true_false","question":"string","options":["..."],"correctIndex":0,"explanation":"string"}\n' +
          'For true_false, use options logically equivalent to ["True","False"].\n' +
          "For multiple_choice, provide exactly 4 options and exactly 1 correct answer.\n" +
          "Do not add commentary or markdown.",
      },
      {
        role: "user",
        content:
          `Repair this malformed quiz output into valid JSON.\nRequested type: ${requestedType}\nQuestion count: ${count}\n\n` +
          rawText,
      },
    ],
  });

  return parseQuizListPayload(repaired, requestedType, count);
}

async function generateQuizSet({ currentVideo, sourceText, requestedType, count }) {
  const typeInstruction =
    requestedType === "true_false"
      ? 'Return each item with "type": "true_false" and use True/False logic.'
      : requestedType === "multiple_choice"
        ? 'Return each item with "type": "multiple_choice" and exactly 4 answer options.'
        : 'Choose either "multiple_choice" or "true_false" for each item based on what fits the material best.';

  const messages = [
    {
      role: "system",
      content:
        "You create a short post-video comprehension quiz set from source material.\n" +
        "Use only the provided material. Do not invent facts.\n" +
        "Prefer concept understanding over tiny trivia.\n" +
        `Return strict JSON only as an array with exactly ${count} items.\n` +
        "Each item must use this shape:\n" +
        '{' +
        '"type":"multiple_choice|true_false",' +
        '"question":"string",' +
        '"options":["..."],' +
        '"correctIndex":0,' +
        '"explanation":"string"' +
        '}\n' +
        'For true_false, keep options logically equivalent to ["True","False"].\n' +
        "For multiple_choice, provide exactly 4 options and exactly 1 correct answer.\n" +
        "Make the questions distinct from one another.\n" +
        "Keep the question and options concise and clear.",
    },
    {
      role: "user",
      content:
        `Generate exactly ${count} quiz questions.\n${typeInstruction}\n\n` +
        `Video title: ${normalizeSpace(currentVideo.title || "Untitled video")}\n\n` +
        `Source material:\n${sourceText}`,
    },
  ];

  let lastError = null;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    let raw = "";
    try {
      raw = await callLLM({ messages });
      return parseQuizListPayload(raw, requestedType, count);
    } catch (error) {
      lastError = error;
      if (raw && error instanceof SyntaxError) {
        try {
          return await repairQuizJson({ rawText: raw, requestedType, count });
        } catch (repairError) {
          lastError = repairError;
        }
      }
      messages.push({
        role: "user",
        content:
          `Return valid JSON only as an array of exactly ${count} items. Keep the same rules. Do not add markdown fences or commentary. Escape quotes inside strings correctly.`,
      });
    }
  }

  throw new Error(lastError?.message?.includes("JSON") ? "Could not format quiz output. Please try /question again." : (lastError?.message || "Failed to generate quiz"));
}

function formatQuizText(quiz) {
  const labels = ["A", "B", "C", "D"];
  const optionLines = quiz.options
    .map((option, idx) => `${labels[idx] || idx + 1}. ${option}`)
    .join("\n");
  const answerLabel = quiz.type === "true_false" ? quiz.options[quiz.correctIndex] : labels[quiz.correctIndex];

  return [
    `${quiz.type === "true_false" ? "True/False" : "Multiple choice"} question`,
    "",
    quiz.question,
    "",
    optionLines,
    "",
    `Answer: ${answerLabel}`,
    quiz.explanation ? `Why: ${quiz.explanation}` : "",
  ]
    .filter(Boolean)
    .join("\n");
}

module.exports = async (ctx) => {
  const userId = ctx.from.id;
  const currentVideo = await sessionManager.getCurrentVideo(userId);

  if (!currentVideo) {
    await ctx.reply(
      "No video selected!\n\nPlease send a YouTube link first, or use /watchlist to select a video."
    );
    return;
  }

  const request = parseQuestionRequest(ctx.message?.text || "");
  const statusMsg = await ctx.reply(
    `Preparing ${request.count} ${getTypeLabel(request.type)} questions...`
  );

  void (async () => {
    try {
      const insights = await loadQuestionSource(userId, currentVideo);
      const sourceText = buildSourceText(currentVideo, insights);

      if (!sourceText) {
        await ctx.telegram
          .editMessageText(
            statusMsg.chat.id,
            statusMsg.message_id,
            undefined,
            "I need transcript or summary data first. Sync the video from the extension, then try /question again."
          )
          .catch(() => {});
        return;
      }

      const quizzes = await generateQuizSet({
        currentVideo,
        sourceText,
        requestedType: request.type,
        count: request.count,
      });

      await ctx.telegram.deleteMessage(statusMsg.chat.id, statusMsg.message_id).catch(() => {});

      for (let i = 0; i < quizzes.length; i += 1) {
        const quiz = quizzes[i];
        try {
          await ctx.replyWithPoll(quiz.question, quiz.options, {
            type: "quiz",
            correct_option_id: quiz.correctIndex,
            explanation: quiz.explanation || undefined,
            is_anonymous: false,
          });
        } catch {
          await ctx.reply(formatQuizText(quiz));
        }
      }

      await ctx.reply("Use `/question 5 (mixed questions)`, `/question tf 3 for true/false questions`, or `/question mcq 4` for multiple choice questions.", {
        parse_mode: "Markdown",
      });
    } catch (e) {
      await ctx.telegram
        .editMessageText(
          statusMsg.chat.id,
          statusMsg.message_id,
          undefined,
          e.message || "Could not generate a question right now."
        )
        .catch(() => {});
    }
  })();
};