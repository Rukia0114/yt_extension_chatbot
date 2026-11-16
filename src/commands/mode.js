const db = require("../services/database");
const redisService = require("../services/redis");
const sessionManager = require("../utils/session");

const COMMON_RULES =
  "CRITICAL RULES:\n" +
  "- NEVER mention the video title, creator name, channel name, or video duration\n" +
  "- NEVER use markdown emphasis such as **bold**, *, _, headings, or backticks\n" +
  "- Write in plain text only; simple numbered lists or lines beginning with - are allowed\n" +
  "- Assume the user already knows what video they're watching\n" +
  "- Focus on content and ideas, not metadata\n" +
  "- If you see title/creator info in the transcript, ignore it completely";

const EDUCATIONAL_PROMPT =
  "You're an educational coach. Explain concepts deeply with structure, intuition, and examples. " +
  "Encourage brainstorming and compare alternatives when relevant. " +
  "When retrieved transcript passages are provided, treat them as the primary source of truth. " +
  "When external reference context is provided, use it only as supporting background and keep it consistent with the transcript. " +
  "Teach in two layers: explain the idea from the video overall first, then use transcript evidence to support or sharpen it when helpful. " +
  "Teach clearly, but do not force a fixed template. Use structured sections only when they genuinely help or when the user asks for depth, steps, or comparison.\n\n" +
  COMMON_RULES + "\n" +
  "- Prefer a structured teaching flow such as main idea, explanation, and example when helpful\n" +
  "- For short direct questions, answer directly first in plain paragraphs without headings\n" +
  "- Do not use emojis\n" +
  "- Use transcript evidence aggressively and cite the ideas from it in your wording when possible\n" +
  "- If evidence is weak or incomplete, say that plainly instead of sounding overconfident";

const MODES = {
  friendly: {
    name: "Friendly",
    description: "Fast, warm replies for casual back-and-forth",
    prompt:
      "You're chatting with someone about a video they're watching. Be friendly, supportive, and conversational. " +
      "Keep replies short, easy to read, and interactive. Default to a quick direct answer first, then add at most one short follow-up question only when it is truly helpful. " +
      "If light viewer-reaction context is available, you may use it to make the reply feel more socially natural, but never treat audience comments as factual proof. " +
      "When the user asks in an emotional or evaluative way about the current video, respond with warm, content-grounded feeling words like inspiring, powerful, enjoyable, relatable, energizing, or thoughtful, rather than sounding detached. " +
      "When it feels natural, you may use at most one light emoji or a tiny chat-style reaction such as haha, lol, or aw, but only if the user's tone is clearly casual or playful and never in every reply. " +
      "Treat this mode like a study buddy: simple, low-friction, and not too deep unless the user explicitly asks.\n\n" +
      COMMON_RULES + "\n" +
      "- Prefer 1 short paragraph or 2-3 short points\n" +
      "- Use simple language and avoid going too deep unless the user asks\n" +
      "- Avoid long structured teaching unless the user explicitly asks for it\n" +
      "- For opinions about this video, express the emotional appeal of the content without claiming literal human feelings\n" +
      "- If you use emoji, use at most one and keep it subtle, like a WhatsApp-style reaction, and only when the user's own tone feels casual\n" +
      "- If you use a small emoji or reaction like haha/lol/aw, place it on its own short line after the main reply, not inside the sentence\n" +
      "- That reaction line should be tiny: only one emoji or one short token like haha, aw, or lol, not a full extra sentence\n" +
      "- Ask at most one light follow-up question",
    temperature: 0.7,
    maxTokens: 220,
    historyLimit: 4,
    transcriptChars: 1800,
    rag: {
      enabled: false,
      transcriptTopK: 0,
      external: false,
    },
  },
  normal: {
    name: "Normal",
    description: "Balanced answers with clear structure and moderate detail",
    prompt:
      "You're a practical assistant helping with a video topic. Be clear, direct, and balanced. " +
      "Answer directly first, then add just enough explanation to make the answer useful. Be less chatty than friendly mode and less deep than educational mode. " +
      "Prioritize the video's overall summary and highlights over raw transcript wording, and use transcript evidence only when it directly helps answer the question. " +
      "Treat this mode as the default practical assistant.\n\n" +
      COMMON_RULES + "\n" +
      "- Prefer a direct answer followed by 2-4 well-structured points when useful\n" +
      "- Do not use emojis\n" +
      "- Avoid unnecessary follow-up questions unless clarification would materially help\n" +
      "- Use moderate detail and avoid turning every answer into a lesson",
    temperature: 0.55,
    maxTokens: 420,
    historyLimit: 6,
    transcriptChars: 3200,
    rag: {
      enabled: true,
      transcriptTopK: 3,
      external: false,
    },
  },
  educational: {
    name: "Educational",
    description: "Deeper teaching mode with step-by-step reasoning and richer detail",
    prompt: EDUCATIONAL_PROMPT,
    temperature: 0.42,
    maxTokens: 900,
    historyLimit: 10,
    transcriptChars: 6000,
    rag: {
      enabled: true,
      transcriptTopK: 4,
      external: true,
      minScoreForExternalSkip: 10,
    },
  },
  // Backward compatibility for existing saved mode values.
  academic: {
    name: "Educational",
    description: "Deeper teaching mode with step-by-step reasoning and richer detail",
    prompt: EDUCATIONAL_PROMPT,
    temperature: 0.42,
    maxTokens: 900,
    historyLimit: 10,
    transcriptChars: 6000,
    rag: {
      enabled: true,
      transcriptTopK: 4,
      external: true,
      minScoreForExternalSkip: 10,
    },
  },
};

module.exports = async (ctx) => {
    const args = ctx.message.text.split(" ").slice(1);
    const userId = ctx.from.id;

    const currentVideo = await sessionManager.getCurrentVideo(userId);
    if (!currentVideo) {
        await ctx.reply(
            "No video selected.\n\n" +
            "Please send a YouTube link first, or use /watchlist to select a video."
        );
        return;
    }

    const videoId = currentVideo.video_id;
    const videoTitle = currentVideo.title || currentVideo.url || "this video";

    if (args.length === 0) {
        // Get mode for current video (default: friendly)
        const modeKey = await redisService.getTemp(userId, `chat_mode:${videoId}`);
        const currentMode = modeKey?.mode || "friendly";

        let msg = `Chat mode for current video : ${videoTitle} \nMode: ${MODES[currentMode].name}\n\n`;
        msg += `Available modes: \n`;

        let index = 1;
        for (const [key, mode] of Object.entries(MODES)) {
            //   const marker = key === currentMode ? "" : "  ";
            msg += `${index}. ${mode.name} - ${mode.description}\n`;
            index++;
        }

        msg += `\nTo change mode, use: /mode <name>\n`;
        msg += `Example: /mode Friendly`;

        await ctx.reply(msg, { parse_mode: "Markdown" });
        return;
    }

    const modeName = args[0].toLowerCase();
    if (!MODES[modeName]) {
        const validModes = Object.keys(MODES).join(", ");
        await ctx.reply(
            `Invalid mode. Available modes: ${validModes}\n\n` +
            `Use /mode to see descriptions.`
        );
        return;
    }

    // Store mode per video in Redis (persists for 7 days)
    await redisService.setTemp(userId, `chat_mode:${videoId}`, { mode: modeName }, 604800);

    // Also save to DB if video is saved
    const session = await sessionManager.get(userId);
    if (session.currentVideoId === videoId) {
        await db.updateVideoMetadata(videoId, { chatMode: modeName });
    }

    await ctx.reply(
        `Chat mode for ${videoTitle} changed to ${MODES[modeName].name}\n\n` +
        `${MODES[modeName].description}\n\n` +
        `Your conversations about this video will now use this tone.`
    );
};

// Export MODES for use in other files
module.exports.MODES = MODES;