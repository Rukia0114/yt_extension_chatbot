const { normalizeText, toNumber } = require("./shared");

function classifyInteractionFeedback(message) {
  const text = normalizeText(message).toLowerCase();
  console.log(`[INTERACTION] Classifying: "${text.slice(0, 60)}..."`);
  
  if (!text) {
    console.log(`[INTERACTION] Returning empty (no text)`);
    return "";
  }
  
  if (text === "skip this for now." || text === "skip") {
    console.log(`[INTERACTION] Classified as "skip"`);
    return "skip";
  }
  
  if (text === "can you explain this simply?" || text.includes("explain") || text.includes("simple")) {
    console.log(`[INTERACTION] Classified as "explain"`);
    return "explain";
  }
  
  if (text === "can you give a quick example?" || text.includes("example")) {
    console.log(`[INTERACTION] Classified as "example"`);
    return "example";
  }
  
  const wordCount = text.split(/\s+/).length;
  if (wordCount <= 4) {
    console.log(`[INTERACTION] Classified as "ack" (short: ${wordCount} words)`);
    return "ack";
  }
  
  console.log(`[INTERACTION] Classified as "engaged"`);
  return "engaged";
}

function summarizeInteractionProfile(profile) {
  const skipCount = toNumber(profile?.skipCount, 0);
  const explainCount = toNumber(profile?.explainCount, 0);
  const exampleCount = toNumber(profile?.exampleCount, 0);
  const engagedCount = toNumber(profile?.engagedCount, 0);
  const total = skipCount + explainCount + exampleCount + engagedCount;

  return {
    skipCount,
    explainCount,
    exampleCount,
    engagedCount,
    total,
    skipHeavy: total >= 3 && skipCount >= explainCount + exampleCount + 1,
    explainHeavy: total >= 3 && explainCount >= exampleCount + 1,
    exampleHeavy: total >= 3 && exampleCount >= explainCount + 1,
    engagedHeavy: total >= 3 && engagedCount >= skipCount + 1,
  };
}

function buildInteractionHint(profile) {
  const summary = summarizeInteractionProfile(profile);
  const { skipCount, explainCount, exampleCount, total } = summary;
  if (total < 2) return "Keep the message concise and concrete.";

  if (skipCount >= explainCount + exampleCount + 1) {
    return "User often skips prompts. Keep it very concise and low-friction.";
  }
  if (exampleCount >= explainCount + 1) {
    return "User prefers concrete examples. Include a mini example when possible.";
  }
  if (explainCount >= exampleCount + 1) {
    return "User prefers simple explanations. Favor plain-language explanation.";
  }
  return "User engages with learning prompts. Keep it interactive and practical.";
}

module.exports = {
  classifyInteractionFeedback,
  summarizeInteractionProfile,
  buildInteractionHint,
};
