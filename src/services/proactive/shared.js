function nowMs() {
  return Date.now();
}

function truncate(text, maxLen) {
  if (!text) return "";
  return text.length > maxLen ? text.slice(0, maxLen) + "..." : text;
}

function toNumber(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function clampRange(value, a, b) {
  return clamp(value, Math.min(a, b), Math.max(a, b));
}

function normalizeText(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function sanitizeProactiveMode(modeRaw) {
  const mode = String(modeRaw || "balanced").trim().toLowerCase();
  if (mode === "calm" || mode === "balanced" || mode === "active") return mode;
  return "balanced";
}

module.exports = {
  nowMs,
  truncate,
  toNumber,
  clamp,
  clampRange,
  normalizeText,
  sanitizeProactiveMode,
};
