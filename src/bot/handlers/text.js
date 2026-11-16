const sessionManager = require("../../utils/session");
const db = require("../../services/database");
const redisService = require("../../services/redis");
const { MODES } = require("../../commands/mode");
const { fetchYouTubeMetadata } = require("../../services/youtubeMetadata");
const { buildRagContext } = require("../../services/retrieval");
const { sanitizeBotText } = require("../../utils/formatting");

function truncate(text, maxLen) {
    if (!text) return "";
    return text.length > maxLen ? text.slice(0, maxLen) + "…" : text;
}

function shouldAllowFriendlyEmoji(userMessage) {
    const text = String(userMessage || "");
    const normalized = text.replace(/\s+/g, " ").trim();
    const lower = normalized.toLowerCase();
    if (!lower) return false;

    if (/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/u.test(text)) return true;
    if (/[!?]{2,}/.test(text)) return true;
    if (/\b(?:haha|hehe|lol|lmao|omg|aw+|aww+|yess+|yay+|bro|pls|pls+|thx|thanks+)\b/i.test(lower)) return true;
    if (/\b(?:hi|hello|hey|yo|sup|nice|cool|wow)\b/i.test(lower) && lower.split(/\s+/).length <= 8) return true;
    return false;
}

async function streamChatCompletionToTelegram({
    ctx,
    statusMsg,
    messages,
    llmBaseUrl,
    llmModel,
    temperature = 0.6,
    maxTokens,
    preserveEmojis = false,
}) {
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

    if (!resp.ok || !resp.body) {
        const t = await resp.text().catch(() => "");
        throw new Error(t || `LLM HTTP ${resp.status}`);
    }

    const reader = resp.body.getReader();
    const decoder = new TextDecoder("utf-8");

    let buffer = "";
    let out = "";
    let lastEdit = 0;

    const LIMIT = 3500;

    while (true) {
        const { value, done } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const parts = buffer.split("\n\n");
        buffer = parts.pop() || "";

        for (const part of parts) {
            const line = part.trim();
            if (!line.startsWith("data:")) continue;

            const dataStr = line.slice(5).trim();
            if (dataStr === "[DONE]") break;

            let jsonObj;
            try {
                jsonObj = JSON.parse(dataStr);
            } catch {
                continue;
            }

            const delta = jsonObj?.choices?.[0]?.delta?.content;
            if (typeof delta === "string" && delta.length) {
                out += delta;

                const now = Date.now();
                if (now - lastEdit > 1000) {
                    lastEdit = now;
                    const displayRaw = out.length > LIMIT ? out.slice(-LIMIT) : out;
                    const display = sanitizeBotText(displayRaw, {
                        preserveEmojis,
                        separateFriendlyReaction: preserveEmojis,
                        compactFriendlyReaction: preserveEmojis,
                    });

                    await ctx.telegram
                        .editMessageText(statusMsg.chat.id, statusMsg.message_id, undefined, display || "…")
                        .catch(() => { });
                }
            }
        }
    }

    const finalText = sanitizeBotText(out.length > LIMIT ? out.slice(-LIMIT) : out, {
        preserveEmojis,
        separateFriendlyReaction: preserveEmojis,
        compactFriendlyReaction: preserveEmojis,
    });
    await ctx.telegram
        .editMessageText(statusMsg.chat.id, statusMsg.message_id, undefined, finalText || "(empty)")
        .catch(() => { });

    return sanitizeBotText(out, {
        preserveEmojis,
        separateFriendlyReaction: preserveEmojis,
        compactFriendlyReaction: preserveEmojis,
    });
}

module.exports = (llmBaseUrl, llmModel) => async (ctx) => {
    const text = ctx.message.text;
    const userId = ctx.from.id;

    const youtubeRegex =
        /(?:https?:\/\/)?(?:www\.)?(?:youtube\.com\/watch\?v=|youtu\.be\/)([a-zA-Z0-9_-]{11})/;
    const match = text.match(youtubeRegex);

    if (match) {
        const videoId = match[1];
        const videoUrl = `https://www.youtube.com/watch?v=${videoId}`;
        const existingVideo = await db.getVideo(videoId);
        const fetchedMeta = await fetchYouTubeMetadata(videoUrl);
        const videoTitle =
            fetchedMeta?.title ||
            existingVideo?.title ||
            null;

        await db.createOrUpdateUser(userId, {
            username: ctx.from.username,
            first_name: ctx.from.first_name,
            last_name: ctx.from.last_name,
            language_code: ctx.from.language_code,
        });

        await sessionManager.setTempCurrentVideo(userId, {
            provider: "youtube",
            videoId,
            url: videoUrl,
            title: videoTitle,
            currentTime: 0,
            duration: 0,
            paused: true,
        });

        await ctx.reply(
            `New YouTube video selected.\n\n` +
            `${videoTitle ? `Title: ${videoTitle}\n` : ""}` +
            `Source: temporary synced/pasted video\n\n` +
            `You can now:\n` +
            `- Chat about this video by sending messages\n` +
            `- Use /summary to get a summary of the video\n` +
            `- Use /recommendations for similar videos\n` +
            `- Use /watchlist to see all your watchlist\n` +
            `- Use /source to switch between the watchlist video and this temporary video\n` +
            `- Use /save to save current video to your watchlist\n` +
            `- Use /question to generate MC question about the video\n` +
            `- Use /mode to set chat tone for this video\n` +
            `- Use /clear to clear the current session and start new chat`
        );
        return;
    }

    if (!text.startsWith("/")) {
        const currentVideo = await sessionManager.getCurrentVideo(userId);

        if (!currentVideo) {
            await ctx.reply("Please send a YouTube link first using /start, or type /help for commands.");
            return;
        }

        const videoId = currentVideo.video_id;
        const videoMetaLines = [
            currentVideo.title ? `Title: ${currentVideo.title}` : "",
            currentVideo.url ? `URL: ${currentVideo.url}` : "",
            currentVideo.channel_name ? `Channel: ${currentVideo.channel_name}` : "",
        ].filter(Boolean);

        let transcript = currentVideo.transcript || "";
        if (!transcript) {
            const draft = await redisService.getTemp(userId, `draft_transcript:${videoId}`);
            if (draft?.text) transcript = String(draft.text);
        }

        // Get chat mode for this video (default: friendly)
        const modeData = await redisService.getTemp(userId, `chat_mode:${videoId}`);
        let chatMode = modeData?.mode;

        // 2) If not in Redis, check DB metadata (for saved videos)
        if (!chatMode) {
            const video = await db.getVideo(videoId);
            if (video?.metadata) {
                const meta = typeof video.metadata === "string"
                    ? JSON.parse(video.metadata || "{}")
                    : (video.metadata || {});
                if (meta.chatMode) {
                    chatMode = meta.chatMode;
                    // Restore to Redis for future use
                    await redisService.setTemp(userId, `chat_mode:${videoId}`, { mode: chatMode }, 604800);
                }
            }
        }

        // 3) Default to friendly if still not found
        chatMode = chatMode || "friendly";

        // Get mode config from MODES (imported from mode.js)
        const modeConfig = MODES[chatMode] || MODES.friendly;
        const systemPrompt = modeConfig.prompt;
        const temperature = modeConfig.temperature;
        const contextItems = await redisService.getContext(userId, videoId);
        const recent = Array.isArray(contextItems)
            ? contextItems.slice(-(modeConfig.historyLimit || 10))
            : [];
        const ragContext = await buildRagContext({
            userId,
            videoId,
            userMessage: text,
            mode: chatMode,
            ragOptions: modeConfig.rag,
        });


        const messages = [
            {
                role: "system",
                content: systemPrompt + "\n\nIMPORTANT: Always answer the user's CURRENT question directly. Do NOT repeat or summarize previous answers. Each response should address only what the user is asking right now.",
            },
            ...recent.flatMap((r) => [
                { role: "user", content: r.message || "" },
                { role: "assistant", content: r.response || "" },
            ]),
            {
                role: "user",
                content:
                    (videoMetaLines.length ? `Video metadata:\n${videoMetaLines.join("\n")}\n\n` : "") +
                    (ragContext.transcriptContext ? `Retrieved transcript passages:\n${ragContext.transcriptContext}\n\n` : "") +
                    (ragContext.externalContext ? `External reference context from trusted sources:\n${ragContext.externalContext}\n\n` : "") +
                    (transcript ? `Transcript (truncated):\n${truncate(transcript, modeConfig.transcriptChars || 6000)}\n\n` : "") +
                    `User question: ${text}\n`,
            },
        ];



        const statusMsg = await ctx.reply("…");

        let botResponse = "";
        try {
            botResponse = await streamChatCompletionToTelegram({
                ctx,
                statusMsg,
                messages,
                llmBaseUrl,
                llmModel,
                temperature,
            maxTokens: modeConfig.maxTokens,
            preserveEmojis: chatMode === "friendly" && shouldAllowFriendlyEmoji(text),
            });
        } catch (e) {
            await ctx.reply(`Something went wrong: ${e.message}`);
            return;
        }

        await redisService.addToContext(userId, videoId, text, botResponse);

        const session = await sessionManager.get(userId);
        if (session.currentVideoId && session.currentVideoId === videoId) {
            await db.saveConversation(userId, videoId, text, botResponse);
        }
    }
};