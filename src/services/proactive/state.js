const redisService = require("../redis");
const {
  GLOBAL_COOLDOWN_SECONDS,
  MAX_QUEUE_ITEMS,
  POST_SKIP_COOLDOWN_SECONDS,
  PROACTIVE_MODE_KEY,
  PROACTIVE_MODE_TTL_SECONDS,
  PROACTIVE_PROFILE_KEY,
  PROACTIVE_PROFILE_TTL_SECONDS,
} = require("./constants");
const { classifyInteractionFeedback } = require("./interaction");
const { nowMs, sanitizeProactiveMode, toNumber } = require("./shared");

async function getQueue(userId, videoId) {
  const queue = await redisService.getTemp(userId, `proactive_queue:${videoId}`);
  return Array.isArray(queue) ? queue : [];
}

async function setQueue(userId, videoId, queue) {
  await redisService.setTemp(userId, `proactive_queue:${videoId}`, queue.slice(-MAX_QUEUE_ITEMS), 86400);
}

async function getUserProactiveMode(userId) {
  const value = await redisService.getTemp(userId, PROACTIVE_MODE_KEY);
  const raw = value && typeof value === "object" ? value.mode : value;
  return sanitizeProactiveMode(raw);
}

async function setUserProactiveMode(userId, modeRaw) {
  const mode = sanitizeProactiveMode(modeRaw);
  await redisService.setTemp(userId, PROACTIVE_MODE_KEY, { mode }, PROACTIVE_MODE_TTL_SECONDS);
  return mode;
}

async function getInteractionProfile(userId) {
  const profile = await redisService.getTemp(userId, PROACTIVE_PROFILE_KEY);
  if (!profile || typeof profile !== "object") {
    return {
      skipCount: 0,
      explainCount: 0,
      exampleCount: 0,
      engagedCount: 0,
      lastAction: "",
      updatedAt: "",
    };
  }
  return profile;
}

async function setInteractionProfile(userId, profile) {
  await redisService.setTemp(userId, PROACTIVE_PROFILE_KEY, profile, PROACTIVE_PROFILE_TTL_SECONDS);
}

async function recordUserFeedback({ userId, userMessage, usedProactiveContext = false }) {
  const action = classifyInteractionFeedback(userMessage);
  if (!action) return null;
  if (!usedProactiveContext && !["skip", "explain", "example"].includes(action)) return null;

  const profile = await getInteractionProfile(userId);
  const next = {
    skipCount: toNumber(profile.skipCount, 0),
    explainCount: toNumber(profile.explainCount, 0),
    exampleCount: toNumber(profile.exampleCount, 0),
    engagedCount: toNumber(profile.engagedCount, 0),
    lastAction: action,
    updatedAt: new Date().toISOString(),
  };

  if (action === "skip") next.skipCount += 1;
  else if (action === "explain") next.explainCount += 1;
  else if (action === "example") next.exampleCount += 1;
  else if (action === "engaged" || action === "ack") next.engagedCount += 1;

  await setInteractionProfile(userId, next);
  return next;
}

async function submitProactiveFeedback({ userId, videoId, proactiveId, action }) {
  const stateKey = `proactive_state:${videoId}`;
  const state = (await redisService.getTemp(userId, stateKey)) || {};
  const open = state.openProactive;
  const normalizedAction = String(action || "").trim().toLowerCase();
  const at = nowMs();

  if (open?.id && proactiveId && String(open.id) !== String(proactiveId)) {
    return { ok: false, resolved: false };
  }

  if (open?.id) {
    state.openProactive = {
      ...open,
      resolvedAt: new Date().toISOString(),
      action: normalizedAction,
    };
  } else {
    state.openProactive = null;
  }

  state.lastFeedbackAction = normalizedAction;
  state.lastFeedbackAt = at;

  if (normalizedAction === "skip") {
    const profile = await getInteractionProfile(userId);
    await setInteractionProfile(userId, {
      skipCount: toNumber(profile.skipCount, 0) + 1,
      explainCount: toNumber(profile.explainCount, 0),
      exampleCount: toNumber(profile.exampleCount, 0),
      engagedCount: toNumber(profile.engagedCount, 0),
      lastAction: "skip",
      updatedAt: new Date().toISOString(),
    });
    state.lastSentAt = at - Math.max(0, GLOBAL_COOLDOWN_SECONDS - POST_SKIP_COOLDOWN_SECONDS) * 1000;
  }

  await redisService.setTemp(userId, stateKey, state, 86400);

  const latest = await redisService.getTemp(userId, `last_proactive:${videoId}`);
  if (!proactiveId || String(latest?.id || "") === String(proactiveId)) {
    await redisService.deleteTemp(userId, `last_proactive:${videoId}`);
  }

  return { ok: true, resolved: true };
}

async function enqueueProactiveMessage(userId, videoId, message, currentTime, extras = {}) {
  const queue = await getQueue(userId, videoId);
  const item = {
    id: `${nowMs()}-${Math.random().toString(36).slice(2, 8)}`,
    role: "assistant",
    text: message,
    createdAt: new Date().toISOString(),
    proactive: true,
    atSec: Math.floor(toNumber(currentTime, 0)),
    actions: Array.isArray(extras.actions) ? extras.actions : [],
    triggerReason: String(extras.triggerReason || ""),
  };
  queue.push(item);
  await setQueue(userId, videoId, queue);
  await redisService.setTemp(
    userId,
    `last_proactive:${videoId}`,
    {
      id: item.id,
      text: item.text,
      createdAt: item.createdAt,
      atSec: item.atSec,
    },
    1800
  );
  return item;
}

async function pollMessages({ userId, videoId }) {
  console.log(`[PROACTIVE STATE] Polling for user ${userId}, video ${videoId}`);
  const queue = await getQueue(userId, videoId);
  console.log(`[PROACTIVE STATE] Found ${queue?.length || 0} items in queue`);
  
  if (queue && queue.length > 0) {
    console.log(`[PROACTIVE STATE] Queue items:`, JSON.stringify(queue, null, 2));
    await redisService.deleteTemp(userId, `proactive_queue:${videoId}`);
    console.log(`[PROACTIVE STATE] Cleared queue from Redis`);
  }
  
  return queue || [];
}

module.exports = {
  getQueue,
  setQueue,
  getUserProactiveMode,
  setUserProactiveMode,
  getInteractionProfile,
  setInteractionProfile,
  recordUserFeedback,
  submitProactiveFeedback,
  enqueueProactiveMessage,
  pollMessages,
};
