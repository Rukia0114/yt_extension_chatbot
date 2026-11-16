// src/services/notify.js
const fetch = globalThis.fetch || require("node-fetch");

function buildNtfyUrl(baseUrl, topic) {
  const cleanBase = (baseUrl || "https://ntfy.sh").replace(/\/+$/, "");
  const cleanTopic = String(topic || "").trim().replace(/^\/+/, "");
  return `${cleanBase}/${cleanTopic}`;
}

async function sendNtfy({ baseUrl, topic, token, title, message, tags = [] }) {
  if (!topic) return false;

  const url = buildNtfyUrl(baseUrl, topic);
  const headers = {
    "Content-Type": "text/plain; charset=utf-8",
  };

  if (title) headers.Title = title;
  if (tags.length) headers.Tags = tags.join(",");
  if (token) headers.Authorization = `Bearer ${token}`;

  try {
    const resp = await fetch(url, {
      method: "POST",
      headers,
      body: message || "",
    });
    return resp.ok;
  } catch (e) {
    console.error("ntfy send failed:", e.message);
    return false;
  }
}

module.exports = { sendNtfy };