const {
  COMPLEX_SCORE_THRESHOLD,
  DEFINITION_SCORE_THRESHOLD,
  KEY_MOMENT_MAX_DELAY_SECONDS,
  KEY_MOMENT_MIN_DELAY_SECONDS,
  PAUSE_TRIGGER_SECONDS,
  RESUME_BREAK_SECONDS,
  SECTION_COOLDOWN_SECONDS,
} = require("./constants");
const {
  computeComplexityScore,
  computeDefinitionScore,
  computeSegmentImportanceScore,
  extractCandidateTerms,
  getSegmentAtTime,
  hasRhetoricalQuestion,
  isLikelySectionBoundary,
  updateSeenTerms,
} = require("./features");
const { getJumpThresholdSeconds, getMinimumTriggerScore } = require("./policy");
const { clamp, nowMs, toNumber } = require("./shared");

function getCurrentHighlightWindow(currentTime, features) {
  const time = toNumber(currentTime, Number.NaN);
  if (!Number.isFinite(time) || !Array.isArray(features?.highlightWindows)) return null;

  let best = null;
  for (const item of features.highlightWindows) {
    const start = toNumber(item?.start, Number.NaN);
    const end = toNumber(item?.end, Number.NaN);
    if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) continue;
    if (time < start - 8 || time > end + 8) continue;
    if (!best || end - start < best.end - best.start) {
      best = { ...item, start, end };
    }
  }

  return best;
}

function getHighlightKey(window) {
  if (!window) return "";
  return `${Math.round(toNumber(window.start, 0))}:${Math.round(toNumber(window.end, 0))}:${String(window.title || "").slice(0, 40)}`;
}

function getKeyMomentReadyAtSec({ currentTime, state, importanceScore, highlightWindow }) {
  if (highlightWindow) {
    const durationSec = Math.max(0, highlightWindow.end - highlightWindow.start);
    const idealDelaySec = clamp(durationSec * 0.35, KEY_MOMENT_MIN_DELAY_SECONDS, KEY_MOMENT_MAX_DELAY_SECONDS);
    const maxUsefulDelaySec = Math.max(8, durationSec - 6);
    return highlightWindow.start + Math.min(idealDelaySec, maxUsefulDelaySec);
  }

  if (importanceScore < 0.54) {
    state.keyMomentCandidateStartSec = 0;
    state.keyMomentCandidateActiveAtSec = 0;
    return Number.POSITIVE_INFINITY;
  }

  const lastActiveAtSec = toNumber(state.keyMomentCandidateActiveAtSec, Number.NaN);
  const candidateStartSec = toNumber(state.keyMomentCandidateStartSec, Number.NaN);
  if (
    !Number.isFinite(candidateStartSec) ||
    !Number.isFinite(lastActiveAtSec) ||
    toNumber(currentTime, 0) - lastActiveAtSec > 12
  ) {
    state.keyMomentCandidateStartSec = toNumber(currentTime, 0);
  }
  state.keyMomentCandidateActiveAtSec = toNumber(currentTime, 0);
  return toNumber(state.keyMomentCandidateStartSec, toNumber(currentTime, 0)) + 16;
}

function shouldSuppressTrigger(trigger, profile, modeRaw) {
  const score = toNumber(trigger?.score, 0);
  const minScore = getMinimumTriggerScore(trigger?.reason, profile, modeRaw);
  return score < minScore;
}

function pickTrigger({ event, state, segment, segments, features, policy }) {
  const currentTime = toNumber(event.currentTime, 0);
  const duration = toNumber(event.duration, 0);
  const paused = !!event.paused;
  const reason = String(event.reason || "");
  const at = nowMs();
  const lastSeenAt = toNumber(state.lastSeenAt, 0);
  const inactivitySec = lastSeenAt > 0 ? (at - lastSeenAt) / 1000 : 0;
  const lastCurrentTime = toNumber(state.lastCurrentTime, currentTime);
  const deltaSec = Math.abs(currentTime - lastCurrentTime);
  const jumpThreshold = getJumpThresholdSeconds(duration);
  const nearEnd = duration > 0 && currentTime >= Math.max(0, Math.min(duration - 8, duration * 0.97));

  if (currentTime <= 8 && lastCurrentTime >= 45) {
    state.sentIntroPrompt = 0;
    state.lastProgressMilestone = -1;
    state.sentCompletionPrompt = 0;
    state.sentPromptCount = 0;
    state.triggerSentAt = {};
    state.lastPrompt = null;
    state.lastKeyMomentWindowKey = "";
    state.keyMomentCandidateStartSec = 0;
    state.keyMomentCandidateActiveAtSec = 0;
  }

  if (paused) {
    if (!state.pauseStartedAt) state.pauseStartedAt = at;
    const pauseSec = (at - state.pauseStartedAt) / 1000;
    console.log(`[TRIGGER] Paused check: ${pauseSec.toFixed(1)}s >= ${policy?.pauseSeconds}s?`);
    
    if (
      pauseSec >= toNumber(policy?.pauseSeconds, PAUSE_TRIGGER_SECONDS) &&
      toNumber(state.lastPauseTriggerAt, 0) < toNumber(state.pauseStartedAt, 0)
    ) {
      console.log(`[TRIGGER] long_pause fired at ${Math.floor(currentTime)}s`);
      state.lastPauseTriggerAt = at;
      return { reason: "long_pause", detail: `Paused around ${Math.floor(currentTime)}s`, score: 0.57 };
    }
  } else {
    state.pauseStartedAt = 0;
  }

  if (!paused && reason === "play" && inactivitySec >= RESUME_BREAK_SECONDS) {
    console.log(`[TRIGGER] resume_after_break fired after ${inactivitySec.toFixed(1)}s inactivity`);
    return {
      reason: "resume_after_break",
      detail: `Welcome back. You resumed around ${Math.floor(currentTime)}s after a short break.`,
      score: 0.52,
    };
  }

  if ((reason === "ended" || nearEnd) && !state.sentCompletionPrompt) {
    console.log(`[TRIGGER] video_complete fired at ${Math.floor(currentTime)}s`);
    state.sentCompletionPrompt = 1;
    return {
      reason: "video_complete",
      detail: `The video is ending around ${Math.floor(currentTime)}s.`,
      score: 0.62,
    };
  }

  if (/^(seeked|seeking)$/.test(reason) && currentTime + 8 < lastCurrentTime) {
    console.log(`[TRIGGER] Rewatch check: seek ${lastCurrentTime}s -> ${currentTime}s, diff: ${(lastCurrentTime - currentTime).toFixed(1)}s`);
    const previous = Array.isArray(state.seekBackEvents) ? state.seekBackEvents : [];
    const recent = [...previous, at].filter((ts) => at - toNumber(ts, 0) <= 90 * 1000);
    state.seekBackEvents = recent;
    
    if (
      recent.length >= 2 &&
      at - toNumber(state.lastConfusionTriggerAt, 0) >=
        toNumber(policy?.sectionCooldownSeconds, SECTION_COOLDOWN_SECONDS) * 1000
    ) {
      console.log(`[TRIGGER] rewatch_confusion fired after ${recent.length} seeks`);
      state.lastConfusionTriggerAt = at;
      return {
        reason: "rewatch_confusion",
        detail: `You rewatched this part near ${Math.floor(currentTime)}s a few times.`,
        score: 0.6,
      };
    }
  }

  if (reason === "pause") {
    state.lastPauseAt = at;
  }
  if (reason === "play") {
    const lastPauseAt = toNumber(state.lastPauseAt, 0);
    if (lastPauseAt > 0 && at - lastPauseAt <= 12 * 1000) {
      const previous = Array.isArray(state.hesitationEvents) ? state.hesitationEvents : [];
      const recent = [...previous, at].filter((ts) => at - toNumber(ts, 0) <= 90 * 1000);
      state.hesitationEvents = recent;
      if (
        recent.length >= 3 &&
        at - toNumber(state.lastHesitationTriggerAt, 0) >=
          toNumber(policy?.sectionCooldownSeconds, SECTION_COOLDOWN_SECONDS) * 1000
      ) {
        state.lastHesitationTriggerAt = at;
        return {
          reason: "hesitation_confusion",
          detail: `There were several quick pauses around ${Math.floor(currentTime)}s.`,
          score: 0.56,
        };
      }
    }
  }

  if (!paused && deltaSec >= jumpThreshold && /^(seeked|seeking|progress_tick)$/.test(reason)) {
    return {
      reason: "forward_jump",
      detail: `You jumped to around ${Math.floor(currentTime)}s. Want a quick bridge from the previous section?`,
      score: 0.54,
    };
  }

  if (segment && Number.isInteger(segment.index)) {
    const segmentTerms = extractCandidateTerms(segment.text || "");
    const importanceScore = computeSegmentImportanceScore(segment.text, currentTime, features);
    const currentHighlightWindow = getCurrentHighlightWindow(currentTime, features);
    const keyMomentReadyAtSec = getKeyMomentReadyAtSec({
      currentTime,
      state,
      importanceScore,
      highlightWindow: currentHighlightWindow,
    });
    const highlightKey = getHighlightKey(currentHighlightWindow);
    const defScore = Math.min(
      1,
      computeDefinitionScore(segment.text, segmentTerms, features?.termDocFreq || {}, state) + importanceScore * 0.12
    );
    const complexScore = Math.min(
      1,
      computeComplexityScore(segment.text, segmentTerms, features, state) + importanceScore * 0.1
    );
    const rhetorical = hasRhetoricalQuestion(segment.text);

    const lastKeyMomentAt = toNumber(state.lastKeyMomentTriggerAt, 0);
    console.log(`[TRIGGER] Key moment check: importance=${importanceScore.toFixed(2)} >= 0.54? readyAt=${keyMomentReadyAtSec.toFixed(1)}, currentTime=${currentTime}`);
    
    if (
      importanceScore >= 0.54 &&
      currentTime >= keyMomentReadyAtSec &&
      (!highlightKey || state.lastKeyMomentWindowKey !== highlightKey) &&
      at - lastKeyMomentAt >= toNumber(policy?.sectionCooldownSeconds, SECTION_COOLDOWN_SECONDS) * 1000
    ) {
      console.log(`[TRIGGER] key_moment fired! Score: ${importanceScore.toFixed(2)}`);
      state.lastKeyMomentTriggerAt = at;
      state.lastKeyMomentWindowKey = highlightKey;
      state.keyMomentCandidateStartSec = 0;
      state.keyMomentCandidateActiveAtSec = 0;
      return {
        reason: "key_moment",
        detail: segment.text,
        score: importanceScore,
      };
    } else {
      if (importanceScore < 0.54) console.log(`[TRIGGER] key_moment blocked: importance too low`);
      if (currentTime < keyMomentReadyAtSec) console.log(`[TRIGGER] key_moment blocked: not ready yet`);
      if (highlightKey && state.lastKeyMomentWindowKey === highlightKey) console.log(`[TRIGGER] key_moment blocked: same window`);
      if (at - lastKeyMomentAt < policy?.sectionCooldownSeconds * 1000) console.log(`[TRIGGER] key_moment blocked: cooldown`);
    }

    if (segment.index !== state.lastSegmentIndex) {
      console.log(`[TRIGGER] New segment detected at index ${segment.index}`);
      state.lastSegmentIndex = segment.index;
      updateSeenTerms(state, segmentTerms);

      if (rhetorical && (defScore >= 0.45 || complexScore >= 0.48)) {
        console.log(`[TRIGGER] rhetorical_question fired: def=${defScore.toFixed(2)}, complex=${complexScore.toFixed(2)}`);
        return {
          reason: "rhetorical_question",
          detail: segment.text,
          score: Math.max(defScore, complexScore),
        };
      }
      if (defScore >= toNumber(policy?.definitionThreshold, DEFINITION_SCORE_THRESHOLD)) {
        console.log(`[TRIGGER] definition fired: def=${defScore.toFixed(2)} >= ${policy?.definitionThreshold}`);
        return {
          reason: "definition",
          detail: segment.text,
          score: defScore,
        };
      }
      if (complexScore >= toNumber(policy?.complexThreshold, COMPLEX_SCORE_THRESHOLD)) {
        console.log(`[TRIGGER] complex_concept fired: complex=${complexScore.toFixed(2)} >= ${policy?.complexThreshold}`);
        return {
          reason: "complex_concept",
          detail: segment.text,
          score: complexScore,
        };
      }

      const lastSectionAt = toNumber(state.lastSectionTriggerAt, 0);
      if (
        isLikelySectionBoundary({ segments, segment, currentTime }) &&
        at - lastSectionAt >= toNumber(policy?.sectionCooldownSeconds, SECTION_COOLDOWN_SECONDS) * 1000
      ) {
        console.log(`[TRIGGER] section_start fired`);
        state.lastSectionTriggerAt = at;
        return {
          reason: "section_start",
          detail: `Entered a new section around ${Math.floor(segment.start)}s`,
          score: 0.5,
        };
      }
    }
  }

  if (!segment) {
    console.log(`[TRIGGER] No segment found at ${currentTime}s`);
    if (
      !state.sentIntroPrompt &&
      currentTime <= 20 &&
      /^(init|play|url_change|tab_url_change|loadedmetadata|progress_tick)$/.test(reason)
    ) {
      console.log(`[TRIGGER] section_start (intro) fired`);
      state.sentIntroPrompt = 1;
      return {
        reason: "section_start",
        detail: "You just started this video.",
        score: 0.56,
      };
    }
  }

  if (duration > 0 && /^(play|progress_tick|pause_tick|seeked|seeking)$/.test(reason)) {
    const ratio = currentTime / duration;
    const milestone = Math.floor(ratio * 4);
    const safeMilestone = Math.max(0, Math.min(3, milestone));
    const lastMilestone = toNumber(state.lastProgressMilestone, -1);
    const lastMilestoneAt = toNumber(state.lastMilestoneTriggerAt, 0);
    const minGap = toNumber(policy?.sectionCooldownSeconds, SECTION_COOLDOWN_SECONDS) * 1000;

    console.log(`[TRIGGER] Progress checkpoint: ratio=${ratio.toFixed(3)}, milestone=${safeMilestone}, last=${lastMilestone}, gap=${(at - lastMilestoneAt) / 1000}s`);
    
    if (safeMilestone >= 1 && safeMilestone > lastMilestone && at - lastMilestoneAt >= minGap) {
      console.log(`[TRIGGER] progress_checkpoint fired at ${Math.round(ratio * 100)}%`);
      state.lastProgressMilestone = safeMilestone;
      state.lastMilestoneTriggerAt = at;
      return {
        reason: "progress_checkpoint",
        detail: `You reached about ${Math.round(ratio * 100)}% of the video.`,
        score: 0.56,
      };
    }
  }

  console.log(`[TRIGGER] No trigger fired for event: ${reason}`);
  return null;
}

module.exports = {
  getSegmentAtTime,
  pickTrigger,
  shouldSuppressTrigger,
};
