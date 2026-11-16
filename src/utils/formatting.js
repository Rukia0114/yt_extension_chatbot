function splitFriendlyReactionLine(text) {
  const reactionToken = String.raw`(?:[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]+|(?:haha|hehe|lol|lmao|aww?|aw+|yay+|omg))`;
  const trailingPattern = new RegExp(`^(.*?)(?:\\s+)(${reactionToken})([!?.,]*)$`, "iu");
  const match = String(text || "").trim().match(trailingPattern);
  if (!match) return String(text || "").trim();

  const body = String(match[1] || "").trim();
  const reaction = `${String(match[2] || "").trim()}${String(match[3] || "")}`.trim();
  if (!body || !reaction) return String(text || "").trim();
  if (body.includes("\n") || reaction.includes("\n")) return String(text || "").trim();
  return `${body}\n${reaction}`;
}

function compactFriendlyReactionLine(text) {
  const lines = String(text || "").split("\n");
  if (lines.length < 2) return String(text || "").trim();

  const last = String(lines[lines.length - 1] || "").trim();
  if (!last) return String(text || "").trim();

  const emojiOnlyMatch = last.match(/^([\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]+)([!?.,]*)$/u);
  if (emojiOnlyMatch) {
    lines[lines.length - 1] = `${emojiOnlyMatch[1]}${emojiOnlyMatch[2] || ""}`.trim();
    return lines.join("\n").trim();
  }

  const reactionWordMatch = last.match(/^(haha|hehe|lol|lmao|aww?|aw+|yay+|omg)([!?.,]*)(?:\s+.*)?$/iu);
  if (reactionWordMatch) {
    lines[lines.length - 1] = `${reactionWordMatch[1]}${reactionWordMatch[2] || ""}`.trim();
    return lines.join("\n").trim();
  }

  return String(text || "").trim();
}

function sanitizeBotText(input, options = {}) {
  let text = String(input || "");
  if (!text) return "";

  if (!options.preserveEmojis) {
    // Remove common emoji-related code points while keeping normal punctuation.
    text = text
      .replace(/[\u{1F300}-\u{1FAFF}]/gu, "")
      .replace(/[\u{2600}-\u{27BF}]/gu, "")
      .replace(/[\u200D\uFE0F]/gu, "");
  }

  // Allow simple plain-text bullets while removing markdown-style bullet markers.
  text = text
    .replace(/^\s*[•*]\s+/gm, "- ")
    .replace(/^\s*#{1,6}\s+/gm, "")
    .replace(/^\s*>\s?/gm, "");

  // Strip common markdown emphasis while preserving the content.
  text = text
    .replace(/\*\*(.*?)\*\*/gs, "$1")
    .replace(/__(.*?)__/gs, "$1")
    .replace(/`([^`]*)`/g, "$1")
    .replace(/\*([^*\n]+)\*/g, "$1")
    .replace(/_([^_\n]+)_/g, "$1");

  // Remove leftover markdown markers that commonly leak through.
  text = text.replace(/[*_`~]/g, "");

  // Normalize whitespace but preserve line-based point formatting.
  text = text
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .split("\n")
    .map((line) => line.trimEnd())
    .join("\n")
    .trim();

  if (options.separateFriendlyReaction) {
    text = splitFriendlyReactionLine(text);
  }
  if (options.compactFriendlyReaction) {
    text = compactFriendlyReactionLine(text);
  }

  return text;
}

module.exports = {
  sanitizeBotText,
};
