const {
  PAUSE_TRIGGER_SECONDS,
  GLOBAL_COOLDOWN_SECONDS,
  DEFINITION_SCORE_THRESHOLD,
  COMPLEX_SCORE_THRESHOLD,
  SECTION_COOLDOWN_SECONDS,
  SEEK_JUMP_SECONDS,
  OPEN_PROACTIVE_TTL_SECONDS,
  OPEN_PROACTIVE_UNANSWERED_SECONDS,
  POST_SKIP_COOLDOWN_SECONDS,
  OPEN_PROACTIVE_PROGRESS_SECONDS,
} = require("./constants");
const { clamp, clampRange, sanitizeProactiveMode, toNumber } = require("./shared");
const { summarizeInteractionProfile } = require("./interaction");

function derivePolicy(durationSecRaw) {
  const durationSec = toNumber(durationSecRaw, 0);
  if (durationSec <= 0) {
    return {
      pauseSeconds: PAUSE_TRIGGER_SECONDS,
      globalCooldownSeconds: GLOBAL_COOLDOWN_SECONDS,
      sectionCooldownSeconds: SECTION_COOLDOWN_SECONDS,
      definitionThreshold: DEFINITION_SCORE_THRESHOLD,
      complexThreshold: COMPLEX_SCORE_THRESHOLD,
    };
  }

  const pauseSeconds = Math.round(
    clampRange(durationSec * 0.04, Math.max(6, PAUSE_TRIGGER_SECONDS * 0.6), Math.max(12, PAUSE_TRIGGER_SECONDS))
  );
  const globalCooldownSeconds = Math.round(
    clampRange(durationSec * 0.1, Math.max(16, GLOBAL_COOLDOWN_SECONDS * 0.55), Math.max(42, GLOBAL_COOLDOWN_SECONDS))
  );
  const sectionCooldownSeconds = Math.round(
    clampRange(durationSec * 0.15, Math.max(20, SECTION_COOLDOWN_SECONDS * 1.5), Math.max(65, SECTION_COOLDOWN_SECONDS * 3))
  );

  const shortness = clamp((600 - durationSec) / 600, 0, 1);
  const thresholdDelta = shortness * 0.06;
  const definitionThreshold = clamp(DEFINITION_SCORE_THRESHOLD - thresholdDelta, 0.5, 0.9);
  const complexThreshold = clamp(COMPLEX_SCORE_THRESHOLD - thresholdDelta, 0.5, 0.92);

  return {
    pauseSeconds,
    globalCooldownSeconds,
    sectionCooldownSeconds,
    definitionThreshold,
    complexThreshold,
  };
}

function applyModeToPolicy(basePolicy, modeRaw) {
  const mode = sanitizeProactiveMode(modeRaw);
  const policy = { ...basePolicy };

  if (mode === "calm") {
    policy.pauseSeconds = Math.round(policy.pauseSeconds * 1.35);
    policy.globalCooldownSeconds = Math.round(policy.globalCooldownSeconds * 1.45);
    policy.sectionCooldownSeconds = Math.round(policy.sectionCooldownSeconds * 1.35);
    policy.definitionThreshold = clamp(policy.definitionThreshold + 0.05, 0.5, 0.95);
    policy.complexThreshold = clamp(policy.complexThreshold + 0.05, 0.5, 0.95);
    return policy;
  }

  if (mode === "active") {
    policy.pauseSeconds = Math.round(policy.pauseSeconds * 0.72);
    policy.globalCooldownSeconds = Math.round(policy.globalCooldownSeconds * 0.72);
    policy.sectionCooldownSeconds = Math.round(policy.sectionCooldownSeconds * 0.78);
    policy.definitionThreshold = clamp(policy.definitionThreshold - 0.05, 0.45, 0.95);
    policy.complexThreshold = clamp(policy.complexThreshold - 0.05, 0.45, 0.95);
    return policy;
  }

  return policy;
}

function applyProfileToPolicy(basePolicy, profile) {
  const policy = { ...basePolicy };
  const skipCount = toNumber(profile?.skipCount, 0);
  const explainCount = toNumber(profile?.explainCount, 0);
  const exampleCount = toNumber(profile?.exampleCount, 0);
  const engagedCount = toNumber(profile?.engagedCount, 0);
  const total = skipCount + explainCount + exampleCount + engagedCount;

  if (total < 3) return policy;

  const skipRate = skipCount / total;
  const learningRate = (explainCount + exampleCount + engagedCount) / total;

  if (skipRate >= 0.45) {
    policy.globalCooldownSeconds = Math.round(policy.globalCooldownSeconds * 1.2);
    policy.sectionCooldownSeconds = Math.round(policy.sectionCooldownSeconds * 1.15);
    policy.definitionThreshold = clamp(policy.definitionThreshold + 0.03, 0.5, 0.95);
    policy.complexThreshold = clamp(policy.complexThreshold + 0.03, 0.5, 0.95);
    return policy;
  }

  if (learningRate >= 0.65) {
    policy.globalCooldownSeconds = Math.round(policy.globalCooldownSeconds * 0.88);
    policy.sectionCooldownSeconds = Math.round(policy.sectionCooldownSeconds * 0.9);
    policy.definitionThreshold = clamp(policy.definitionThreshold - 0.03, 0.45, 0.95);
    policy.complexThreshold = clamp(policy.complexThreshold - 0.03, 0.45, 0.95);
  }

  return policy;
}

function getModeCooldownFactor(modeRaw) {
  const mode = sanitizeProactiveMode(modeRaw);
  if (mode === "calm") return 1.25;
  if (mode === "active") return 0.82;
  return 1;
}

function getJumpThresholdSeconds(durationSecRaw) {
  const durationSec = toNumber(durationSecRaw, 0);
  if (durationSec <= 0) return SEEK_JUMP_SECONDS;
  return Math.round(clampRange(durationSec * 0.08, SEEK_JUMP_SECONDS, Math.max(45, SEEK_JUMP_SECONDS * 2)));
}

function getOpenPromptProgressGapSeconds(durationSecRaw) {
  const durationSec = toNumber(durationSecRaw, 0);
  if (durationSec <= 0) return OPEN_PROACTIVE_PROGRESS_SECONDS;
  return Math.round(clampRange(durationSec * 0.08, 12, OPEN_PROACTIVE_PROGRESS_SECONDS));
}

function getOpenPromptTtlSeconds(durationSecRaw) {
  const durationSec = toNumber(durationSecRaw, 0);
  if (durationSec <= 0) return OPEN_PROACTIVE_TTL_SECONDS;
  return Math.round(clampRange(durationSec * 0.14, 45, OPEN_PROACTIVE_TTL_SECONDS));
}

function getOpenPromptUnansweredSeconds(durationSecRaw) {
  const durationSec = toNumber(durationSecRaw, 0);
  if (durationSec <= 0) return OPEN_PROACTIVE_UNANSWERED_SECONDS;
  return Math.round(clampRange(durationSec * 0.05, 10, 20));
}

function getPromptBudgetForDuration(durationSecRaw) {
  const durationSec = toNumber(durationSecRaw, 0);
  if (durationSec <= 0) return 5;
  // Raised baseline so proactive can check in more than once per section.
  if (durationSec <= 240) return 5;
  if (durationSec <= 420) return 6;
  if (durationSec <= 600) return 7;
  return 8;
}

function isHighPriorityTrigger(reason) {
  return [
    "video_complete",
    "key_moment",
    "complex_concept",
    "rewatch_confusion",
    "hesitation_confusion",
    "long_pause",
    "rhetorical_question",
  ].includes(String(reason || ""));
}

function getUserCooldownFactor(profile) {
  const summary = summarizeInteractionProfile(profile);
  if (summary.skipHeavy) return 1.2;
  if (summary.engagedHeavy) return 0.9;
  return 1;
}

function getConfidenceCooldownFactor(score) {
  const normalized = toNumber(score, 0);
  if (normalized >= 0.72) return 0.78;
  if (normalized >= 0.6) return 0.92;
  if (normalized >= 0.5) return 1;
  return 1.15;
}

function getTriggerBaseCooldownSeconds(reason, policy) {
  const globalBase = toNumber(policy?.globalCooldownSeconds, GLOBAL_COOLDOWN_SECONDS);
  if (reason === "video_complete") return clamp(globalBase * 0.35, 12, 30);
  if (reason === "key_moment") return clamp(globalBase * 0.64, 22, 58);
  if (reason === "long_pause") return clamp(globalBase * 0.55, 20, 50);
  if (reason === "rhetorical_question") return clamp(globalBase * 0.68, 24, 60);
  if (reason === "definition") return clamp(globalBase * 0.78, 28, 75);
  if (reason === "complex_concept") return clamp(globalBase * 0.72, 24, 70);
  if (reason === "rewatch_confusion") return clamp(globalBase * 0.62, 20, 55);
  if (reason === "hesitation_confusion") return clamp(globalBase * 0.66, 20, 60);
  if (reason === "resume_after_break") return clamp(globalBase * 0.58, 18, 48);
  if (reason === "forward_jump") return clamp(globalBase * 0.64, 18, 52);
  if (reason === "section_start") return clamp(globalBase * 0.95, 30, 90);
  if (reason === "progress_checkpoint") return clamp(globalBase * 0.9, 28, 80);
  return clamp(globalBase * 0.85, 24, 80);
}

function getAdaptiveCooldownSeconds({ trigger, policy, profile, modeRaw }) {
  const base = getTriggerBaseCooldownSeconds(trigger?.reason, policy);
  const modeFactor = getModeCooldownFactor(modeRaw);
  const userFactor = getUserCooldownFactor(profile);
  const confidenceFactor = getConfidenceCooldownFactor(trigger?.score);
  return Math.round(clamp(base * modeFactor * userFactor * confidenceFactor, 10, 180));
}

function getMinimumGlobalCooldownSeconds(policy) {
  const base = toNumber(policy?.globalCooldownSeconds, GLOBAL_COOLDOWN_SECONDS);
  const result = Math.round(clamp(base * 0.33, 8, 30)); // Reduced from 12 to 8
  console.log(`[POLICY] Min global cooldown: ${base}s -> min=${result}s`);
  return result;
}

function getProgressRequirementSeconds({ trigger, duration }) {
  const score = toNumber(trigger?.score, 0);
  if (trigger?.reason === "video_complete") return 0;
  if (trigger?.reason === "key_moment") return score >= 0.7 ? 12 : 16;
  if (trigger?.reason === "long_pause") return 10;
  if (trigger?.reason === "resume_after_break") return 12;
  if (trigger?.reason === "forward_jump") return 12;
  if (trigger?.reason === "section_start") {
    return Math.round(clamp((duration > 0 ? duration * 0.04 : 24) * (score >= 0.6 ? 0.75 : 1), 18, 45));
  }
  if (trigger?.reason === "progress_checkpoint") return 20;
  if (trigger?.reason === "definition") return score >= 0.65 ? 16 : 22;
  if (trigger?.reason === "complex_concept") return score >= 0.65 ? 14 : 20;
  if (trigger?.reason === "rewatch_confusion") return 12;
  if (trigger?.reason === "hesitation_confusion") return 12;
  if (trigger?.reason === "rhetorical_question") return 16;
  return 18;
}

function hasSatisfiedProgressGate(state, currentTime, trigger, duration) {
  const lastPrompt = state?.lastPrompt;
  console.log(`[POLICY] Progress gate check for ${trigger.reason}, lastPrompt: ${lastPrompt?.reason || 'none'}`);
  
  if (!lastPrompt || !lastPrompt.reason) {
    console.log(`[POLICY] Progress gate passed (no previous prompt)`);
    return true;
  }
  if (trigger?.reason === "video_complete") {
    console.log(`[POLICY] Progress gate passed (video_complete is high priority)`);
    return true;
  }

  const requiredDelta = getProgressRequirementSeconds({ trigger, duration });
  if (requiredDelta <= 0) {
    console.log(`[POLICY] Progress gate passed (requiredDelta <= 0)`);
    return true;
  }

  const lastAtSec = toNumber(lastPrompt.atSec, Number.NaN);
  if (!Number.isFinite(lastAtSec)) {
    console.log(`[POLICY] Progress gate passed (lastAtSec not finite)`);
    return true;
  }

  const movedSeconds = Math.abs(toNumber(currentTime, 0) - lastAtSec);
  console.log(`[POLICY] Moved ${movedSeconds.toFixed(1)}s >= ${requiredDelta}s? ${movedSeconds >= requiredDelta}`);
  
  if (movedSeconds >= requiredDelta) {
    console.log(`[POLICY] Progress gate satisfied`);
    return true;
  }

  const differentReason = trigger?.reason !== lastPrompt.reason;
  const minimumSatisfied = movedSeconds >= Math.max(10, Math.round(requiredDelta * 0.6));
  
  if (differentReason && minimumSatisfied) {
    console.log(`[POLICY] Progress gate passed (different reason, sufficient movement)`);
    return true;
  }
  
  console.log(`[POLICY] Progress gate NOT satisfied`);
  return false;
}

function hasPromptBudgetRemaining(state, trigger, durationSecRaw) {
  const sentCount = toNumber(state?.sentPromptCount, 0);
  const budget = getPromptBudgetForDuration(durationSecRaw);
  if (sentCount < budget) return true;
  return isHighPriorityTrigger(trigger?.reason);
}

function getMinimumTriggerScore(reason, profile, modeRaw) {
  let threshold = 0.5;
  if (reason === "video_complete") threshold = 0.48;
  else if (reason === "key_moment") threshold = 0.54;
  else if (reason === "long_pause") threshold = 0.5;
  else if (reason === "rhetorical_question") threshold = 0.5;
  else if (reason === "definition") threshold = 0.56;
  else if (reason === "complex_concept") threshold = 0.56;
  else if (reason === "rewatch_confusion") threshold = 0.54;
  else if (reason === "hesitation_confusion") threshold = 0.52;
  else if (reason === "resume_after_break") threshold = 0.49;
  else if (reason === "forward_jump") threshold = 0.5;
  else if (reason === "section_start") threshold = 0.5;
  else if (reason === "progress_checkpoint") threshold = 0.52;

  const mode = sanitizeProactiveMode(modeRaw);
  const summary = summarizeInteractionProfile(profile);

  if (mode === "calm") threshold += 0.03;
  if (mode === "active") threshold -= 0.02;
  if (summary.skipHeavy) threshold += 0.03;
  if (summary.engagedHeavy) threshold -= 0.01;

  return clamp(threshold, 0.45, 0.9);
}

function shouldSuppressTrigger(trigger, profile, modeRaw) {
  const score = toNumber(trigger?.score, 0);
  const minScore = getMinimumTriggerScore(trigger?.reason, profile, modeRaw);
  return score < minScore;
}

module.exports = {
  derivePolicy,
  applyModeToPolicy,
  applyProfileToPolicy,
  getJumpThresholdSeconds,
  getOpenPromptProgressGapSeconds,
  getOpenPromptTtlSeconds,
  getOpenPromptUnansweredSeconds,
  getAdaptiveCooldownSeconds,
  getMinimumGlobalCooldownSeconds,
  hasSatisfiedProgressGate,
  hasPromptBudgetRemaining,
  getMinimumTriggerScore,
  shouldSuppressTrigger,
  POST_SKIP_COOLDOWN_SECONDS,
};
