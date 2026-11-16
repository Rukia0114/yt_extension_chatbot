const db = require("../database");
const redisService = require("../redis");
const { POST_SKIP_COOLDOWN_SECONDS, WATCH_EVENT_COALESCE_MS, WATCH_EVENT_RETRY_MS } = require("./constants");
const { getVideoFeatures, getSegments, buildSegmentContext } = require("./features");
const { buildInteractionHint } = require("./interaction");
const {
  callLLM,
  getFallbackMessage,
  getQuickActionsForMessage,
  getTriggerLabel,
  getTriggerWritingInstruction,
  tailorQuickActions,
  buildPromptStyleInstruction,
} = require("./messages");
const {
  applyModeToPolicy,
  applyProfileToPolicy,
  derivePolicy,
  getAdaptiveCooldownSeconds,
  getMinimumGlobalCooldownSeconds,
  getMinimumTriggerScore,
  getOpenPromptProgressGapSeconds,
  getOpenPromptTtlSeconds,
  getOpenPromptUnansweredSeconds,
  hasPromptBudgetRemaining,
  hasSatisfiedProgressGate,
  shouldSuppressTrigger,
} = require("./policy");
const {
  enqueueProactiveMessage,
  getInteractionProfile,
  getUserProactiveMode,
  pollMessages,
  recordUserFeedback,
  setUserProactiveMode,
  submitProactiveFeedback,
} = require("./state");
const { nowMs, toNumber, truncate } = require("./shared");
const { getSegmentAtTime, pickTrigger } = require("./triggers");

const pendingWatchEvents = new Map();
const watchEventsInFlight = new Set();

function normalizeForSimilarity(text) {
  return String(text || "")
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function tokenizeForSimilarity(text) {
  return normalizeForSimilarity(text)
    .split(" ")
    .map((token) => token.trim())
    .filter((token) => token.length >= 3);
}

function computeDiceSimilarity(a, b) {
  const aTokens = tokenizeForSimilarity(a);
  const bTokens = tokenizeForSimilarity(b);
  if (!aTokens.length || !bTokens.length) return 0;

  const aFreq = {};
  const bFreq = {};
  for (const token of aTokens) aFreq[token] = (aFreq[token] || 0) + 1;
  for (const token of bTokens) bFreq[token] = (bFreq[token] || 0) + 1;

  let overlap = 0;
  for (const [token, count] of Object.entries(aFreq)) {
    overlap += Math.min(count, bFreq[token] || 0);
  }

  return (2 * overlap) / (aTokens.length + bTokens.length);
}

function isTooSimilarProactiveMessage(nextText, previousText) {
  const next = normalizeForSimilarity(nextText);
  const prev = normalizeForSimilarity(previousText);
  if (!next || !prev) return false;
  if (next === prev) return true;

  const shorter = Math.min(next.length, prev.length);
  if (shorter >= 36 && (next.includes(prev) || prev.includes(next))) return true;
  return computeDiceSimilarity(next, prev) >= 0.74;
}

function hasCheckpointContentFocus(text) {
  const normalized = normalizeForSimilarity(text);
  if (!normalized) return false;
  const hasCurrentContentAnchor =
    /\b(this part|this point|this moment|right now|currently|here|speaker|section|idea|topic)\b/.test(normalized);
  const hasMeaningCue =
    /\b(means|about|shows|explains|focuses|covers|matters|key point|takeaway)\b/.test(normalized);
  return hasCurrentContentAnchor && hasMeaningCue;
}

function getVariationHint(reason, sentPromptCount) {
  const hints = [
    "Use a fresh opening phrase that is different from recent prompts.",
    "Prefer a different sentence pattern than the previous proactive message.",
    "Keep wording concrete and avoid repeating common proactive phrases.",
  ];
  const reasonWeight = String(reason || "").length % hints.length;
  const countWeight = Math.max(0, toNumber(sentPromptCount, 0)) % hints.length;
  return hints[(reasonWeight + countWeight) % hints.length];
}

function normalizeChatMode(chatModeRaw) {
  const mode = String(chatModeRaw || "friendly").trim().toLowerCase();
  if (mode === "academic") return "educational";
  if (mode === "normal" || mode === "educational") return mode;
  return "friendly";
}

async function getChatMode(userId, videoId) {
  const modeData = await redisService.getTemp(userId, `chat_mode:${videoId}`);
  if (modeData?.mode) return normalizeChatMode(modeData.mode);

  const video = await db.getVideo(videoId);
  if (video?.metadata) {
    try {
      const meta =
        typeof video.metadata === "string"
          ? JSON.parse(video.metadata || "{}")
          : (video.metadata || {});
      if (meta?.chatMode) return normalizeChatMode(meta.chatMode);
    } catch {
      // Ignore malformed metadata and fall back.
    }
  }

  return "friendly";
}

function buildImportanceContext(features, currentTime) {
  const parts = [];
  const summary = String(features?.summaryFingerprint || "").trim();
  if (summary) {
    parts.push(`Video summary: ${truncate(summary, 220)}`);
  }

  const time = toNumber(currentTime, Number.NaN);
  if (Array.isArray(features?.highlightWindows) && Number.isFinite(time)) {
    const nearby = features.highlightWindows
      .filter((item) => {
        const start = toNumber(item?.start, Number.NaN);
        const end = toNumber(item?.end, Number.NaN);
        return Number.isFinite(start) && Number.isFinite(end) && time >= start - 12 && time <= end + 12;
      })
      .slice(0, 2)
      .map((item) => truncate([item.title, item.text].filter(Boolean).join(": "), 160))
      .filter(Boolean);
    if (nearby.length) {
      parts.push(`Nearby highlights: ${nearby.join(" | ")}`);
    }
  }

  return parts.join("\n");
}

function getWatchEventKey(event) {
  return `${String(event?.userId || "")}:${String(event?.videoId || "")}`;
}

function resetProactiveCycleState(state) {
  state.sentIntroPrompt = 0;
  state.lastProgressMilestone = -1;
  state.sentCompletionPrompt = 0;
  state.sentPromptCount = 0;
  state.triggerSentAt = {};
  state.lastPrompt = null;
  state.openProactive = null;
  state.lastSectionTriggerAt = 0;
  state.lastPauseTriggerAt = 0;
  state.lastConfusionTriggerAt = 0;
  state.lastHesitationTriggerAt = 0;
  state.lastKeyMomentTriggerAt = 0;
  state.lastKeyMomentWindowKey = "";
  state.keyMomentCandidateStartSec = 0;
  state.keyMomentCandidateActiveAtSec = 0;
}

function getReasonPriority(reasonRaw) {
  const reason = String(reasonRaw || "").trim().toLowerCase();
  if (reason === "ended") return 100;
  if (reason === "seeked") return 92;
  if (reason === "seeking") return 80;
  if (reason === "play") return 70;
  if (reason === "pause") return 68;
  if (reason === "url_change" || reason === "tab_url_change") return 60;
  if (reason === "loadedmetadata") return 55;
  if (reason === "pause_tick") return 30;
  if (reason === "progress_tick") return 20;
  if (reason === "init") return 10;
  return 0;
}

function chooseMergedReason(previous, next) {
  const prevReason = String(previous?.reason || "");
  const nextReason = String(next?.reason || "");
  if (!prevReason) return nextReason;
  if (!nextReason) return prevReason;

  if (prevReason === "seeked" && nextReason === "progress_tick") return prevReason;
  if (prevReason === "seeked" && nextReason === "pause_tick") return prevReason;
  if (prevReason === "ended") return prevReason;

  const prevPriority = getReasonPriority(prevReason);
  const nextPriority = getReasonPriority(nextReason);
  return nextPriority >= prevPriority ? nextReason : prevReason;
}

function mergeWatchEvents(previous, next) {
  if (!previous) return { ...next };
  const merged = {
    ...previous,
    ...next,
  };
  merged.reason = chooseMergedReason(previous, next);
  merged.eventAt = Math.max(toNumber(previous?.eventAt, 0), toNumber(next?.eventAt, 0), nowMs());
  merged.currentTime = toNumber(next?.currentTime, toNumber(previous?.currentTime, 0));
  merged.duration = toNumber(next?.duration, toNumber(previous?.duration, 0));
  merged.paused = typeof next?.paused === "boolean" ? next.paused : !!previous?.paused;
  merged.title = String(next?.title || previous?.title || "");
  return merged;
}

function resolvePlaybackTime(currentTimeRaw, eventAtRaw, paused, durationRaw) {
  const currentTime = Math.max(0, toNumber(currentTimeRaw, 0));
  if (paused) return currentTime;

  const eventAt = toNumber(eventAtRaw, 0);
  if (!eventAt) return currentTime;

  const now = nowMs();
  const lagSec = Math.max(0, Math.min(6, (now - eventAt) / 1000));
  const duration = toNumber(durationRaw, 0);
  const adjusted = currentTime + lagSec;
  if (duration > 0) return Math.min(duration, adjusted);
  return adjusted;
}

function getFreshnessWindowSeconds(reasonRaw, paused) {
  if (paused) return 24;
  const reason = String(reasonRaw || "").trim().toLowerCase();
  if (reason === "video_complete" || reason === "ended") return 40;
  if (["key_moment", "definition", "complex_concept", "rhetorical_question", "section_start"].includes(reason)) {
    return 14;
  }
  if (reason === "progress_checkpoint") return 20;
  return 16;
}

function shouldDropStaleMessage({ userId, videoId, triggerReason, triggerAtMs, triggerCurrentTime, paused }) {
  const now = nowMs();
  const freshnessWindowSec = getFreshnessWindowSeconds(triggerReason, paused);
  const generationLagSec = (now - toNumber(triggerAtMs, now)) / 1000;
  if (!paused && generationLagSec > freshnessWindowSec) return true;

  const key = getWatchEventKey({ userId, videoId });
  const pending = pendingWatchEvents.get(key)?.event;
  if (!pending) return false;

  const pendingTime = toNumber(pending.currentTime, Number.NaN);
  const baseTime = toNumber(triggerCurrentTime, Number.NaN);
  if (!Number.isFinite(pendingTime) || !Number.isFinite(baseTime)) return false;

  // If playback moved too far while we were generating, drop this stale message.
  return Math.abs(pendingTime - baseTime) > freshnessWindowSec;
}

async function processWatchEvent({ userId, videoId, title, currentTime, duration, paused, reason, eventAt }) {
  const at = nowMs();
  console.log(`[PROACTIVE] Event for user ${userId}, video ${videoId}: ${reason} at ${currentTime}s (duration: ${duration})`);
  
  const stateKey = `proactive_state:${videoId}`;
  const state = (await redisService.getTemp(userId, stateKey)) || {};
  const effectiveCurrentTime = resolvePlaybackTime(currentTime, eventAt, paused, duration);
  const lastSeenAtMs = toNumber(state.lastSeenAt, 0);
  const staleForTooLong = lastSeenAtMs > 0 && at - lastSeenAtMs > 15 * 60 * 1000;
  if (staleForTooLong) {
    resetProactiveCycleState(state);
  }
  const userMode = await getUserProactiveMode(userId);
  const chatMode = await getChatMode(userId, videoId);
  const interactionProfile = await getInteractionProfile(userId);
  const policy = applyProfileToPolicy(
    applyModeToPolicy(derivePolicy(duration), userMode),
    interactionProfile
  );

  const segments = await getSegments(userId, videoId);
  const features = await getVideoFeatures(userId, videoId, segments);
  const segment = getSegmentAtTime(segments, effectiveCurrentTime);

  const openCreatedAt = Date.parse(state.openProactive?.createdAt || "");
  const openAgeSec = Number.isFinite(openCreatedAt) ? (at - openCreatedAt) / 1000 : Number.POSITIVE_INFINITY;
  const openAtSec = toNumber(state.openProactive?.atSec, -1);
  
  console.log(`[PROACTIVE] Open proactive state: ${state.openProactive?.id || 'none'}, age: ${openAgeSec.toFixed(1)}s`);
  const progressGapSeconds = getOpenPromptProgressGapSeconds(duration);
  const openPromptTtlSeconds = getOpenPromptTtlSeconds(duration);
  const openPromptUnansweredSeconds = getOpenPromptUnansweredSeconds(duration);
  const progressedPastOpen = openAtSec >= 0 && toNumber(effectiveCurrentTime, 0) >= openAtSec + progressGapSeconds;
  const endedOrNearEnd =
    reason === "ended" || (duration > 0 && effectiveCurrentTime >= Math.max(duration - 3, duration * 0.98));
  const unansweredTooLong = openAgeSec >= openPromptUnansweredSeconds;
  const ignoredOpenReason = String(state.openProactive?.triggerReason || "");

  if (
    state.openProactive?.id &&
    !state.openProactive?.resolvedAt &&
    (openAgeSec >= openPromptTtlSeconds || unansweredTooLong || progressedPastOpen || endedOrNearEnd)
  ) {
    // Treat an ignored/expired prompt like a light dismiss so the next valid
    // proactive message can surface naturally instead of being blocked by the
    // previous prompt's full cooldown window.
    state.lastFeedbackAction = "ignore";
    state.lastFeedbackAt = at;
    if (ignoredOpenReason) {
      state.triggerSentAt = {
        ...(state.triggerSentAt || {}),
        [ignoredOpenReason]: at - POST_SKIP_COOLDOWN_SECONDS * 1000,
      };
    }
    state.lastSentAt = at - POST_SKIP_COOLDOWN_SECONDS * 1000;
    state.openProactive = null;
  }
  if (
    state.openProactive?.id &&
    !state.openProactive?.resolvedAt &&
    openAgeSec < openPromptTtlSeconds &&
    openAgeSec < openPromptUnansweredSeconds
  ) {
    state.lastSeenAt = at;
    state.lastPaused = !!paused;
    state.lastCurrentTime = toNumber(effectiveCurrentTime, 0);
    await redisService.setTemp(userId, stateKey, state, 86400);
    return null;
  }
  if (state.openProactive?.resolvedAt || openAgeSec >= openPromptTtlSeconds) {
    state.openProactive = null;
  }

  const workingState = JSON.parse(JSON.stringify(state || {}));
  const trigger = pickTrigger({
    event: { currentTime: effectiveCurrentTime, duration, paused, reason },
    state: workingState,
    segment,
    segments,
    features,
    policy,
  });

  if (!trigger) {
    workingState.lastSeenAt = at;
    workingState.lastPaused = !!paused;
    workingState.lastCurrentTime = toNumber(effectiveCurrentTime, 0);
    await redisService.setTemp(userId, stateKey, workingState, 86400);
    return null;
  }

  if (shouldSuppressTrigger(trigger, interactionProfile, userMode)) {
    workingState.lastSeenAt = at;
    workingState.lastPaused = !!paused;
    workingState.lastCurrentTime = toNumber(effectiveCurrentTime, 0);
    await redisService.setTemp(userId, stateKey, workingState, 86400);
    return null;
  }

  const lastSentAt = toNumber(state.lastSentAt, 0);
  const triggerSentAt = toNumber(state?.triggerSentAt?.[trigger.reason], 0);
  const recentSkip =
    state.lastFeedbackAction === "skip" &&
    at - toNumber(state.lastFeedbackAt, 0) <= 2 * 60 * 1000;
  const previousProactiveText = String(state.lastProactiveText || "");
  const adaptiveCooldownSeconds = getAdaptiveCooldownSeconds({
    trigger,
    policy,
    profile: interactionProfile,
    modeRaw: userMode,
  });
  const minimumGlobalCooldownSeconds = recentSkip
    ? Math.min(getMinimumGlobalCooldownSeconds(policy), POST_SKIP_COOLDOWN_SECONDS)
    : getMinimumGlobalCooldownSeconds(policy);
  const importanceContext = buildImportanceContext(features, effectiveCurrentTime);

  const globalCooldownCheck = at - lastSentAt < minimumGlobalCooldownSeconds * 1000;
  const adaptiveCooldownCheck = at - triggerSentAt < adaptiveCooldownSeconds * 1000;
  const progressGateCheck = !hasSatisfiedProgressGate(state, effectiveCurrentTime, trigger, duration);
  const budgetCheck = !hasPromptBudgetRemaining(state, trigger, duration);
  
  if (globalCooldownCheck) {
    console.log(`[PROACTIVE] BLOCKED: Global cooldown (${Math.floor((at - lastSentAt) / 1000)}s < ${minimumGlobalCooldownSeconds}s)`);
  }
  if (adaptiveCooldownCheck) {
    console.log(`[PROACTIVE] BLOCKED: Adaptive cooldown (${Math.floor((at - triggerSentAt) / 1000)}s < ${adaptiveCooldownSeconds}s)`);
  }
  if (progressGateCheck) {
    console.log(`[PROACTIVE] BLOCKED: Progress gate not satisfied for ${trigger.reason}`);
  }
  if (budgetCheck) {
    console.log(`[PROACTIVE] BLOCKED: Prompt budget exhausted`);
  }
  
  if (globalCooldownCheck || adaptiveCooldownCheck || progressGateCheck || budgetCheck) {
    state.lastSeenAt = at;
    state.lastPaused = !!paused;
    state.lastCurrentTime = toNumber(effectiveCurrentTime, 0);
    await redisService.setTemp(userId, stateKey, state, 86400);
    return null;
  }

  const prompt =
    `Video title: ${truncate(title || "", 120)}\n` +
    `Trigger: ${getTriggerLabel(trigger.reason)} (${trigger.reason})\n` +
    `Trigger score: ${toNumber(trigger.score, 0).toFixed(2)}\n` +
    `Minimum score to send: ${getMinimumTriggerScore(trigger.reason, interactionProfile, userMode).toFixed(2)}\n` +
    `Chat mode: ${chatMode}\n` +
    `Current time: ${Math.floor(toNumber(effectiveCurrentTime, 0))}s\n` +
    (importanceContext ? `${importanceContext}\n` : "") +
    (previousProactiveText
      ? `Recent proactive message (avoid repeating wording): ${truncate(previousProactiveText, 180)}\n`
      : "") +
    `Local context: ${truncate(trigger.detail || "", 420)}\n` +
    (segment ? `Segment window:\n${buildSegmentContext(segments, segment)}\n` : "") +
    `Interaction hint: ${buildInteractionHint(interactionProfile)}\n\n` +
    `${getTriggerWritingInstruction(trigger.reason)}\n` +
    `${buildPromptStyleInstruction(interactionProfile, trigger.reason, chatMode)}\n` +
    `${getVariationHint(trigger.reason, workingState.sentPromptCount)}\n` +
    "Write one short proactive message to help the user understand this moment. " +
    "Use plain text, anchor it in the local context first, and when summary/highlights show this is important, briefly connect it to the video overall without sounding generic.";

  let message = "";
  try {
    console.log(`[PROACTIVE] Calling LLM for trigger: ${trigger.reason}, score: ${trigger.score.toFixed(2)}`);
    message = await callLLM({
      prompt,
      proactiveMode: userMode,
      profile: interactionProfile,
      chatMode,
    });
    if (trigger.reason === "progress_checkpoint" && message && !hasCheckpointContentFocus(message)) {
      console.log(`[PROACTIVE] Rewriting progress checkpoint message for better context`);
      message = await callLLM({
        prompt:
          `${prompt}\n\n` +
          "Rewrite the message to feel natural and grounded in what the video is saying right now. " +
          "Explain the current spoken point clearly in plain language. " +
          "You may optionally add one short next-step cue, but do not force it.",
        proactiveMode: userMode,
        profile: interactionProfile,
        chatMode,
      });
    }
    if (message && previousProactiveText && isTooSimilarProactiveMessage(message, previousProactiveText)) {
      console.log(`[PROACTIVE] Message too similar to previous, rewriting...`);
      message = await callLLM({
        prompt:
          `${prompt}\n\n` +
          "Do not reuse wording from the recent proactive message. " +
          "Rewrite with a different opening phrase and a different follow-up phrasing while keeping the same intent.",
        proactiveMode: userMode,
        profile: interactionProfile,
        chatMode,
      });
    }
  } catch (err) {
    console.error(`[PROACTIVE] LLM call failed for trigger ${trigger.reason}:`, err.message);
    message = getFallbackMessage(trigger.reason);
  }

  if (!message) {
    console.log(`[PROACTIVE] No message generated for trigger ${trigger.reason}`);
    return null;
  }
  const staleByTiming = shouldDropStaleMessage({
    userId,
    videoId,
    triggerReason: trigger.reason,
    triggerAtMs: at,
    triggerCurrentTime: effectiveCurrentTime,
    paused,
  });
  const freshest = pendingWatchEvents.get(getWatchEventKey({ userId, videoId }))?.event;
  const enqueueAtSec =
    staleByTiming && Number.isFinite(toNumber(freshest?.currentTime, Number.NaN))
      ? toNumber(freshest.currentTime, effectiveCurrentTime)
      : effectiveCurrentTime;
  console.log(`[PROACTIVE] Generating message for trigger ${trigger.reason}, score: ${trigger.score.toFixed(2)}, prompt sent`);
  
  const item = await enqueueProactiveMessage(userId, videoId, message, enqueueAtSec, {
    actions: tailorQuickActions(getQuickActionsForMessage(message, trigger.reason), interactionProfile),
    triggerReason: trigger.reason,
  });

  console.log(`[PROACTIVE] Message queued successfully! ID: ${item.id}, Text: "${message.slice(0, 80)}..."`);
  
  workingState.lastSentAt = at;
  workingState.lastSeenAt = at;
  workingState.lastPaused = !!paused;
  workingState.lastCurrentTime = toNumber(enqueueAtSec, 0);
  workingState.lastFeedbackAction = "";
  workingState.sentPromptCount = toNumber(workingState.sentPromptCount, 0) + 1;
  workingState.triggerSentAt = {
    ...(workingState.triggerSentAt || {}),
    [trigger.reason]: at,
  };
  workingState.lastPrompt = {
    reason: trigger.reason,
    score: toNumber(trigger.score, 0),
    atSec: Math.floor(toNumber(enqueueAtSec, 0)),
    createdAt: new Date().toISOString(),
  };
  workingState.openProactive = {
    id: item.id,
    createdAt: item.createdAt,
    atSec: item.atSec,
    triggerReason: trigger.reason,
  };
  workingState.lastProactiveText = String(item.text || "");
  await redisService.setTemp(userId, stateKey, workingState, 86400);
  console.log(`[PROACTIVE] State saved for video ${videoId}, will show message after cooldown`);
  return item;
}

async function flushBufferedWatchEvent(key) {
  const pending = pendingWatchEvents.get(key);
  if (!pending) return;

  if (watchEventsInFlight.has(key)) {
    pending.timer = setTimeout(() => {
      flushBufferedWatchEvent(key).catch(() => {});
    }, WATCH_EVENT_RETRY_MS);
    pendingWatchEvents.set(key, pending);
    return;
  }

  pendingWatchEvents.delete(key);
  watchEventsInFlight.add(key);
  try {
    await processWatchEvent(pending.event);
  } finally {
    watchEventsInFlight.delete(key);
  }
}

async function enqueueWatchEvent(event) {
  const normalized = {
    ...event,
    userId: event?.userId,
    videoId: String(event?.videoId || ""),
    title: String(event?.title || ""),
    currentTime: toNumber(event?.currentTime, 0),
    duration: toNumber(event?.duration, 0),
    paused: !!event?.paused,
    reason: String(event?.reason || ""),
    eventAt: toNumber(event?.eventAt, nowMs()),
  };

  const key = getWatchEventKey(normalized);
  if (!normalized.userId || !normalized.videoId) return { queued: false };

  const existing = pendingWatchEvents.get(key);
  const mergedEvent = existing ? mergeWatchEvents(existing.event, normalized) : normalized;
  if (existing?.timer) clearTimeout(existing.timer);

  const entry = {
    event: mergedEvent,
    timer: setTimeout(() => {
      flushBufferedWatchEvent(key).catch(() => {});
    }, WATCH_EVENT_COALESCE_MS),
  };
  pendingWatchEvents.set(key, entry);
  return { queued: true, key };
}

module.exports = {
  enqueueWatchEvent,
  processWatchEvent,
  pollMessages,
  getUserProactiveMode,
  setUserProactiveMode,
  recordUserFeedback,
  submitProactiveFeedback,
};
