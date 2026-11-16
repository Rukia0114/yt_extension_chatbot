const express = require("express");
const router = express.Router();

const pairing = require("../services/pairing");
const db = require("../services/database");
const redisService = require("../services/redis");
const sessionManager = require("../utils/session");
const { chatForVideo, streamChatForVideo } = require("../services/chat");
const { MODES } = require("../commands/mode");
const proactiveService = require("../services/proactive");
const {
  fetchLatestInsights,
  getLatestInsights,
  storeLatestInsights,
} = require("../services/insights");
const { saveCurrentVideoForUser } = require("../services/watchlistSave");

function buildGuestUserId(deviceId) {
  return `guest:${String(deviceId || "").trim()}`;
}

function sendServerError(res, error, status = 500) {
  const code = Number(status) || 500;
  if (code >= 500) {
    console.error(error);
    return res.status(code).json({ error: "Internal server error" });
  }
  const message = typeof error === "string" ? error : (error?.message || "Request failed");
  return res.status(code).json({ error: message });
}

async function resolveActor(deviceId, { allowGuest = false } = {}) {
  const linkedUserId = await db.getUserIdByDeviceId(deviceId);
  if (linkedUserId) return { userId: linkedUserId, linked: true };
  if (!allowGuest) return null;
  return { userId: buildGuestUserId(deviceId), linked: false };
}

router.post("/pair/start", async (req, res) => {
  try {
    const { deviceId } = req.body || {};
    const code = await pairing.startPair(deviceId);

    const botUsername = process.env.TELEGRAM_BOT_USERNAME;
    if (!botUsername) throw new Error("Missing TELEGRAM_BOT_USERNAME");

    const botLink = `https://t.me/${botUsername}?start=pair_${code}`;
    res.json({ code, botLink });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

router.get("/pair/status", async (req, res) => {
  try {
    const deviceId = String(req.query.deviceId || "");
    const linked = await pairing.isLinked(deviceId);
    res.json({ linked });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

router.post("/events/watch", async (req, res) => {
  try {
    const { deviceId, provider, videoId, url, title, currentTime, duration, paused } = req.body || {};
    if (!pairing.isValidDeviceId(deviceId)) return res.status(400).json({ error: "Invalid deviceId" });

    const actor = await resolveActor(deviceId, { allowGuest: true });
    if (!actor?.userId) return res.status(401).json({ error: "Device not linked" });
    const userId = actor.userId;

    if (provider !== "youtube") return res.status(400).json({ error: "Unsupported provider" });
    if (!url || !videoId) return res.status(400).json({ error: "Missing url/videoId" });

    console.log(`[WATCH EVENT] User: ${userId}, Video: ${videoId}, Reason: ${req.body?.reason}, Paused: ${paused}, Time: ${currentTime}s`);

    await sessionManager.setTempCurrentVideo(userId, {
      provider,
      videoId,
      url,
      title,
      currentTime,
      duration,
      paused,
    });

    try {
      const result = await proactiveService.enqueueWatchEvent({
        userId,
        videoId: String(videoId),
        title: String(title || ""),
        currentTime: Number(currentTime || 0),
        duration: Number(duration || 0),
        paused: !!paused,
        reason: String(req.body?.reason || ""),
        eventAt: Number(req.body?.eventAt || Date.now()),
      });
      console.log(`[WATCH EVENT] Enqueued:`, result);
    } catch (e) {
      console.error(`[WATCH EVENT] Enqueue failed:`, e);
    }

    res.sendStatus(204);
  } catch (e) {
    console.error(`[WATCH EVENT] Error:`, e);
    sendServerError(res, e);
  }
});

router.get("/video/:videoId", async (req, res) => {
  try {
    const deviceId = String(req.query.deviceId || "");
    if (!pairing.isValidDeviceId(deviceId)) return res.status(400).json({ error: "Invalid deviceId" });

    const actor = await resolveActor(deviceId, { allowGuest: true });
    if (!actor?.userId) return res.status(401).json({ error: "Device not linked" });
    const userId = actor.userId;

    const videoId = String(req.params.videoId || "");
    const insights = await getLatestInsights(userId, videoId);

    if (!insights.video && !insights.summary && insights.highlights.length === 0) {
      return res.json({
        videoId,
        url: null,
        summary: null,
        highlights: [],
        segments: [],
        processing: true,
      });
    }

    return res.json({
      videoId,
      url: insights.url,
      summary: insights.summary,
      highlights: insights.highlights,
      segments: insights.segments,
      processing: false,
    });
  } catch (e) {
    sendServerError(res, e);
  }
});

router.post("/video/:videoId/save", async (req, res) => {
  try {
    const deviceId = String(req.query.deviceId || "");
    if (!pairing.isValidDeviceId(deviceId)) return res.status(400).json({ error: "Invalid deviceId" });

    const actor = await resolveActor(deviceId, { allowGuest: false });
    if (!actor?.userId) {
      return res.status(401).json({
        error: "Save to watchlist requires Telegram link. Other extension features work in guest mode.",
      });
    }
    const userId = actor.userId;

    const videoId = String(req.params.videoId || "");
    const session = await sessionManager.get(userId);
    const currentVideoId = String(session?.tempData?.currentVideo?.videoId || "");
    if (!videoId || currentVideoId !== videoId) {
      return res.status(400).json({ error: "Current extension video does not match save target" });
    }

    const result = await saveCurrentVideoForUser(userId);
    if (!result.ok) {
      return res.status(400).json({ error: result.error });
    }

    return res.json({
      ok: true,
      videoId: result.videoId,
      title: result.title,
      message: result.message,
    });
  } catch (e) {
    return sendServerError(res, e);
  }
});

router.post("/video/:videoId/summary", async (req, res) => {
    try {
      const deviceId = String(req.query.deviceId || "");
      if (!pairing.isValidDeviceId(deviceId)) return res.status(400).json({ error: "Invalid deviceId" });
      const actor = await resolveActor(deviceId, { allowGuest: true });
      if (!actor?.userId) return res.status(401).json({ error: "Device not linked" });
      const userId = actor.userId;
  
      const videoId = String(req.params.videoId || "");
  
      const urlFromBody = req.body?.url || "";
      const session = await sessionManager.get(userId);
      const temp = session?.tempData?.currentVideo;
      const existing = await getLatestInsights(userId, videoId);
      const videoUrl = urlFromBody || (temp?.videoId === videoId ? temp.url : "") || existing.url || "";
  
      if (!videoUrl) {
        return res.status(400).json({ error: "Missing url for summary generation" });
      }

      const insights = await fetchLatestInsights(videoUrl, videoId);
      const saved = await storeLatestInsights(userId, videoId, insights, {
        persistToDb: session.currentVideoId === videoId,
      });

      res.json({
        summary: saved.summary,
        highlights: saved.highlights,
        segments: saved.segments,
      });
    } catch (e) {
      if (e.status === 409) {
        return res.status(202).json({
          processing: true,
          summary: null,
          highlights: [],
          segments: [],
        });
      }
      sendServerError(res, e, e.status || 500);
    }
  });

router.post("/video/:videoId/transcribe", async (req, res) => {
    try {
      const deviceId = String(req.query.deviceId || "");
      if (!pairing.isValidDeviceId(deviceId)) return res.status(400).json({ error: "Invalid deviceId" });
      const actor = await resolveActor(deviceId, { allowGuest: true });
      if (!actor?.userId) return res.status(401).json({ error: "Device not linked" });
      const userId = actor.userId;
  
      const videoId = String(req.params.videoId || "");
      const urlFromBody = req.body?.url || "";
      const session = await sessionManager.get(userId);
      const temp = session?.tempData?.currentVideo;
      const videoUrl = urlFromBody || (temp?.videoId === videoId ? temp.url : "");
  
      if (!videoUrl) return res.status(400).json({ error: "Missing url for transcribe" });
  
      const whisperUrl = process.env.WHISPER_URL || "http://whisper:9000";
      const resp = await fetch(`${whisperUrl}/transcribe/youtube`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url: videoUrl, video_id: videoId }),
      });
  
      if (!resp.ok) {
        const errText = await resp.text();
        console.error("Whisper transcribe failed", resp.status, errText);
        return res.status(502).json({ error: "Transcription service failed" });
      }
  
      const data = await resp.json();
      const transcript = typeof data.text === "string" ? data.text : "";
      const segments = Array.isArray(data.segments) ? data.segments : [];
      const progress = Number(data.progress || 0);
      const transcriptReady = !!data.done;
  
      // Store any partial or completed transcript drafts for chat/RAG use.
      if (transcript) {
        await redisService.setTemp(userId, `draft_transcript:${videoId}`, { text: transcript }, 86400);
      }
      if (segments.length) {
        await redisService.setTemp(userId, `draft_segments:${videoId}`, segments, 86400);
      }
  
      res.json({ transcriptReady, progress, processing: !transcriptReady });
    } catch (e) {
      sendServerError(res, e);
    }
  });

router.get("/video/:videoId/transcribe/status", async (req, res) => {
  try {
    const deviceId = String(req.query.deviceId || "");
    if (!pairing.isValidDeviceId(deviceId)) return res.status(400).json({ error: "Invalid deviceId" });

    const actor = await resolveActor(deviceId, { allowGuest: true });
    if (!actor?.userId) return res.status(401).json({ error: "Device not linked" });
    const userId = actor.userId;

    const videoId = String(req.params.videoId || "");
    const whisperUrl = process.env.WHISPER_URL || "http://whisper:9000";
    const resp = await fetch(`${whisperUrl}/transcribe/status/${encodeURIComponent(videoId)}`);
    if (!resp.ok) {
      const errText = await resp.text().catch(() => "");
      console.error("Whisper status failed", resp.status, errText);
      return res.status(502).json({ error: "Transcription status unavailable" });
    }

    const data = await resp.json().catch(() => ({}));
    const transcript = typeof data.text === "string" ? data.text : "";
    const segments = Array.isArray(data.segments) ? data.segments : [];
    if (transcript) {
      await redisService.setTemp(userId, `draft_transcript:${videoId}`, { text: transcript }, 86400);
    }
    if (segments.length) {
      await redisService.setTemp(userId, `draft_segments:${videoId}`, segments, 86400);
    }

    return res.json({
      videoId,
      transcriptReady: !!data.done,
      progress: Number(data.progress || 0),
      processing: !data.done,
    });
  } catch (e) {
    return sendServerError(res, e);
  }
});

  router.post("/chat/send", async (req, res) => {
    try {
      const deviceId = String(req.query.deviceId || "");
      if (!pairing.isValidDeviceId(deviceId)) return res.status(400).json({ error: "Invalid deviceId" });
      const actor = await resolveActor(deviceId, { allowGuest: true });
      if (!actor?.userId) return res.status(401).json({ error: "Device not linked" });
      const userId = actor.userId;
  
      const { videoId, message } = req.body || {};
      if (!videoId) return res.status(400).json({ error: "Missing videoId" });
  
      const out = await chatForVideo({
        userId,
        videoId: String(videoId),
        userMessage: String(message || ""),
      });
  
      res.json(out);
    } catch (e) {
      sendServerError(res, e);
    }
  });

router.post("/chat/send/stream", async (req, res) => {
  try {
    const deviceId = String(req.query.deviceId || "");
    if (!pairing.isValidDeviceId(deviceId)) return res.status(400).json({ error: "Invalid deviceId" });

    const actor = await resolveActor(deviceId, { allowGuest: true });
    if (!actor?.userId) return res.status(401).json({ error: "Device not linked" });
    const userId = actor.userId;

    const { videoId, message } = req.body || {};
    if (!videoId) return res.status(400).json({ error: "Missing videoId" });

    res.setHeader("Content-Type", "application/x-ndjson; charset=utf-8");
    res.setHeader("Cache-Control", "no-cache, no-transform");
    res.setHeader("X-Accel-Buffering", "no");

    const out = await streamChatForVideo({
      userId,
      videoId: String(videoId),
      userMessage: String(message || ""),
      onDelta: async (delta) => {
        res.write(`${JSON.stringify({ type: "chunk", delta: String(delta || "") })}\n`);
      },
    });

    res.write(`${JSON.stringify({ type: "done", reply: out.reply, mode: out.mode })}\n`);
    res.end();
  } catch (e) {
    if (!res.headersSent) {
      return sendServerError(res, e);
    }
    console.error(e);
    res.write(`${JSON.stringify({ type: "error", error: "Stream failed" })}\n`);
    res.end();
  }
});

  router.get("/chat/history", async (req, res) => {
    try {
      const deviceId = String(req.query.deviceId || "");
      if (!pairing.isValidDeviceId(deviceId)) return res.status(400).json({ error: "Invalid deviceId" });
      const actor = await resolveActor(deviceId, { allowGuest: true });
      if (!actor?.userId) return res.status(401).json({ error: "Device not linked" });
      const userId = actor.userId;
  
      const videoId = String(req.query.videoId || "");
      const limit = Math.min(Number(req.query.limit || 40), 200);
      if (!videoId) return res.status(400).json({ error: "Missing videoId" });
  
      let items = [];
      if (actor.linked) {
        const rows = await db.getConversationHistory(userId, videoId, limit);
        items = rows.flatMap((r) => [
          { role: "user", text: r.message_text, createdAt: r.created_at },
          { role: "assistant", text: r.bot_response || "", createdAt: r.created_at },
        ]);
      } else {
        const ctx = await redisService.getContext(userId, videoId);
        const recent = Array.isArray(ctx) ? ctx.slice(-limit) : [];
        items = recent.flatMap((r) => [
          { role: "user", text: r.message || "", createdAt: new Date(r.timestamp || Date.now()).toISOString() },
          { role: "assistant", text: r.response || "", createdAt: new Date(r.timestamp || Date.now()).toISOString() },
        ]);
      }
  
      res.json({ videoId, items });
    } catch (e) {
      sendServerError(res, e);
    }
  });

router.get("/chat/mode", async (req, res) => {
  try {
    const deviceId = String(req.query.deviceId || "");
    if (!pairing.isValidDeviceId(deviceId)) return res.status(400).json({ error: "Invalid deviceId" });

    const actor = await resolveActor(deviceId, { allowGuest: true });
    if (!actor?.userId) return res.status(401).json({ error: "Device not linked" });
    const userId = actor.userId;

    const videoId = String(req.query.videoId || "");
    if (!videoId) return res.status(400).json({ error: "Missing videoId" });

    const modeData = await redisService.getTemp(userId, `chat_mode:${videoId}`);
    let mode = modeData?.mode && MODES[modeData.mode] ? modeData.mode : "";

    if (!mode && actor.linked) {
      const video = await db.getVideo(videoId);
      const meta =
        video && (typeof video.metadata === "string"
          ? JSON.parse(video.metadata || "{}")
          : (video.metadata || {}));
      if (meta?.chatMode && MODES[meta.chatMode]) {
        mode = String(meta.chatMode);
      }
    }

    if (!mode) mode = "friendly";
    if (mode === "academic") mode = "educational";

    res.json({
      videoId,
      mode,
      options: [
        { id: "friendly", label: "Friendly" },
        { id: "normal", label: "Normal" },
        { id: "educational", label: "Educational" },
      ],
    });
  } catch (e) {
    sendServerError(res, e);
  }
});

router.post("/chat/mode", async (req, res) => {
  try {
    const deviceId = String(req.query.deviceId || "");
    if (!pairing.isValidDeviceId(deviceId)) return res.status(400).json({ error: "Invalid deviceId" });

    const actor = await resolveActor(deviceId, { allowGuest: true });
    if (!actor?.userId) return res.status(401).json({ error: "Device not linked" });
    const userId = actor.userId;

    const videoId = String(req.body?.videoId || "");
    if (!videoId) return res.status(400).json({ error: "Missing videoId" });

    const rawMode = String(req.body?.mode || "").toLowerCase().trim();
    const mode = rawMode === "academic" ? "educational" : rawMode;
    if (!["friendly", "normal", "educational"].includes(mode)) {
      return res.status(400).json({ error: "Invalid mode" });
    }

    await redisService.setTemp(userId, `chat_mode:${videoId}`, { mode }, 604800);

    if (actor.linked && await db.videoExists(videoId)) {
      await db.updateVideoMetadata(videoId, { chatMode: mode });
    }

    res.json({ ok: true, videoId, mode });
  } catch (e) {
    sendServerError(res, e);
  }
});

  router.delete("/chat/history", async (req, res) => {
    try {
      const deviceId = String(req.query.deviceId || "");
      if (!pairing.isValidDeviceId(deviceId)) {
        return res.status(400).json({ error: "Invalid deviceId" });
      }
      const actor = await resolveActor(deviceId, { allowGuest: true });
      if (!actor?.userId) return res.status(401).json({ error: "Device not linked" });
      const userId = actor.userId;
  
      const videoId = String(req.query.videoId || "");
      if (!videoId) {
        return res.status(400).json({ error: "Missing videoId" });
      }
  
      if (actor.linked) {
        await db.deleteUserConversations(userId, videoId);
      }
      await redisService.clearContext(userId, videoId);
  
      res.json({
        ok: true,
        videoId,
        cleared: true,
      });
    } catch (e) {
      sendServerError(res, e);
    }
  });

router.get("/proactive/poll", async (req, res) => {
  try {
    const deviceId = String(req.query.deviceId || "");
    if (!pairing.isValidDeviceId(deviceId)) return res.status(400).json({ error: "Invalid deviceId" });

    const actor = await resolveActor(deviceId, { allowGuest: true });
    if (!actor?.userId) return res.status(401).json({ error: "Device not linked" });
    const userId = actor.userId;

    const videoId = String(req.query.videoId || "");
    if (!videoId) return res.status(400).json({ error: "Missing videoId" });

    console.log(`[PROACTIVE POLL] User: ${userId}, Video: ${videoId}`);
    
    const items = await proactiveService.pollMessages({ userId, videoId });
    console.log(`[PROACTIVE POLL] Returning ${items?.length || 0} items:`, JSON.stringify(items, null, 2));
    
    res.json({ videoId, items: Array.isArray(items) ? items : [] });
  } catch (e) {
    console.error(`[PROACTIVE POLL] Error:`, e);
    sendServerError(res, e);
  }
});

router.post("/proactive/feedback", async (req, res) => {
  try {
    const deviceId = String(req.query.deviceId || "");
    if (!pairing.isValidDeviceId(deviceId)) return res.status(400).json({ error: "Invalid deviceId" });

    const actor = await resolveActor(deviceId, { allowGuest: true });
    if (!actor?.userId) return res.status(401).json({ error: "Device not linked" });
    const userId = actor.userId;

    const videoId = String(req.body?.videoId || "");
    if (!videoId) return res.status(400).json({ error: "Missing videoId" });

    const out = await proactiveService.submitProactiveFeedback({
      userId,
      videoId,
      proactiveId: String(req.body?.proactiveId || ""),
      action: String(req.body?.action || ""),
    });
    res.json(out);
  } catch (e) {
    sendServerError(res, e);
  }
});

router.get("/proactive/settings", async (req, res) => {
  try {
    const deviceId = String(req.query.deviceId || "");
    if (!pairing.isValidDeviceId(deviceId)) return res.status(400).json({ error: "Invalid deviceId" });

    const actor = await resolveActor(deviceId, { allowGuest: true });
    if (!actor?.userId) return res.status(401).json({ error: "Device not linked" });
    const userId = actor.userId;

    const mode = await proactiveService.getUserProactiveMode(userId);
    res.json({ mode });
  } catch (e) {
    sendServerError(res, e);
  }
});

router.post("/proactive/settings", async (req, res) => {
  try {
    const deviceId = String(req.query.deviceId || "");
    if (!pairing.isValidDeviceId(deviceId)) return res.status(400).json({ error: "Invalid deviceId" });

    const actor = await resolveActor(deviceId, { allowGuest: true });
    if (!actor?.userId) return res.status(401).json({ error: "Device not linked" });
    const userId = actor.userId;

    const mode = await proactiveService.setUserProactiveMode(userId, req.body?.mode);
    res.json({ mode });
  } catch (e) {
    sendServerError(res, e);
  }
});

router.get("/config", (_req, res) => {
  res.json({
    botUsername: (process.env.TELEGRAM_BOT_USERNAME || "").trim().replace(/^@/, ""),
  });
});

module.exports = router;