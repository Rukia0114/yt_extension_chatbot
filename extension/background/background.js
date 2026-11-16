// background/background.js
importScripts(
  "/shared/youtube.js",
  "/shared/storage.js",
  "/shared/api.js"
);

const Yt = globalThis.Yt || {};
const Storage = globalThis.Storage || {};
const Api = globalThis.Api || {};
const CHAT_WINDOW_BOUNDS_KEY = "chatWindowBounds";

function parseYouTubeVideoId(url) {
  if (Yt.parseYouTubeVideoId) return Yt.parseYouTubeVideoId(url);
  try {
    const u = new URL(url);
    if (u.hostname.includes("youtube.com") && u.pathname === "/watch") return u.searchParams.get("v");
    if (u.hostname === "youtu.be") return u.pathname.replace("/", "");
    return null;
  } catch {
    return null;
  }
}

async function isLinked(deviceId) {
  try {
    const data = await Api.fetchPairStatus(deviceId);
    return !!data.linked;
  } catch {
    return false;
  }
}

async function postWatchEvent(payload) {
  const deviceId = await Storage.getDeviceId();
  if (!(await isLinked(deviceId))) return;
  await Api.postWatchUpdate(deviceId, payload);
}

async function getActiveYouTubeTab() {
  let tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tabs || tabs.length === 0) {
    tabs = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  }

  const [tab] = tabs;
  const videoId = parseYouTubeVideoId(tab?.url || "");
  if (!tab?.id || !videoId) return null;
  return { tab, videoId };
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

async function getSavedChatWindowBounds() {
  const data = await chrome.storage.local.get([CHAT_WINDOW_BOUNDS_KEY]);
  const bounds = data?.[CHAT_WINDOW_BOUNDS_KEY];
  if (!bounds || typeof bounds !== "object") return null;

  const width = Number(bounds.width);
  const height = Number(bounds.height);
  const left = Number(bounds.left);
  const top = Number(bounds.top);

  if (![width, height, left, top].every(Number.isFinite)) return null;

  return {
    width: Math.round(width),
    height: Math.round(height),
    left: Math.round(left),
    top: Math.round(top),
  };
}

async function saveChatWindowBounds(windowId) {
  try {
    const win = await chrome.windows.get(windowId);
    if (
      !win ||
      typeof win.left !== "number" ||
      typeof win.top !== "number" ||
      typeof win.width !== "number" ||
      typeof win.height !== "number"
    ) {
      return;
    }

    await chrome.storage.local.set({
      [CHAT_WINDOW_BOUNDS_KEY]: {
        left: win.left,
        top: win.top,
        width: win.width,
        height: win.height,
      },
    });
  } catch {
    // Ignore storage/bounds persistence failures.
  }
}

async function getAdaptiveChatWindowBounds(tabWindowId) {
  const saved = await getSavedChatWindowBounds();
  if (saved) return saved;

  let baseWindow = null;
  try {
    if (typeof tabWindowId === "number") {
      baseWindow = await chrome.windows.get(tabWindowId);
    }
  } catch {
    baseWindow = null;
  }

  const baseLeft = typeof baseWindow?.left === "number" ? baseWindow.left : 80;
  const baseTop = typeof baseWindow?.top === "number" ? baseWindow.top : 40;
  const baseWidth = typeof baseWindow?.width === "number" ? baseWindow.width : 1440;
  const baseHeight = typeof baseWindow?.height === "number" ? baseWindow.height : 900;

  const width = Math.round(clamp(baseWidth * 0.3, 380, 460));
  const height = Math.round(clamp(baseHeight * 0.88, 620, 920));
  const left = Math.round(Math.max(0, baseLeft + baseWidth - width - 16));
  const top = Math.round(Math.max(0, baseTop + 24));

  return { width, height, left, top };
}

async function findExistingChatWindow() {
  const tabs = await chrome.tabs.query({});
  const chatWindowUrl = chrome.runtime.getURL("chat-window/chat-window.html");

  for (const tab of tabs) {
    const url = String(tab?.url || "");
    if (!url.startsWith(chatWindowUrl)) continue;
    if (!tab.id || typeof tab.windowId !== "number") continue;
    return {
      tabId: tab.id,
      windowId: tab.windowId,
    };
  }

  return null;
}

async function openChatWindowForContext() {
  const existing = await findExistingChatWindow();
  if (existing?.windowId) {
    await chrome.windows.update(existing.windowId, { focused: true });
    if (existing.tabId) {
      await chrome.tabs.update(existing.tabId, { active: true });
    }
    return { ok: true, reused: true, windowId: existing.windowId };
  }

  const current = await getActiveYouTubeTab();
  const tabWindowId = current?.tab?.windowId;

  const bounds = await getAdaptiveChatWindowBounds(tabWindowId);
  const url = chrome.runtime.getURL("chat-window/chat-window.html");

  const created = await chrome.windows.create({
    url,
    type: "popup",
    width: bounds.width,
    height: bounds.height,
    left: bounds.left,
    top: bounds.top,
    focused: true,
  });

  if (!created?.id) {
    throw new Error("Failed to open chat window.");
  }

  return { ok: true, reused: false, windowId: created.id };
}

// Track last video per tab (avoid duplicate updates)
const lastYouTubeVideoIdByTab = new Map();

chrome.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
  if (!changeInfo.url) return;

  const url = changeInfo.url;
  const videoId = parseYouTubeVideoId(url);
  if (!videoId) return;

  const prev = lastYouTubeVideoIdByTab.get(tabId);
  if (prev === videoId) return;

  lastYouTubeVideoIdByTab.set(tabId, videoId);

  await postWatchEvent({
    type: "WATCH_UPDATE",
    reason: "tab_url_change",
    eventAt: Date.now(),
    provider: "youtube",
    videoId,
    url,
    title: tab?.title || "",
    currentTime: 0,
    duration: 0,
    paused: true,
  }).catch(console.error);
});

chrome.tabs.onRemoved.addListener((tabId) => {
  lastYouTubeVideoIdByTab.delete(tabId);
});

chrome.windows.onBoundsChanged?.addListener((win) => {
  if (!win?.id) return;
  saveChatWindowBounds(win.id).catch(() => {});
});

chrome.action.onClicked.addListener(async () => {
  try {
    await openChatWindowForContext();
  } catch (e) {
    console.error("Failed to open action window:", e);
  }
});

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.type === "WATCH_UPDATE") {
    (async () => {
      await postWatchEvent(msg);
    })().catch(console.error);
    return;
  }

  if (msg?.type === "OPEN_CHAT_WINDOW") {
    (async () => {
      try {
        const result = await openChatWindowForContext();
        sendResponse(result);
      } catch (e) {
        sendResponse({ ok: false, error: e.message || String(e) });
      }
    })();
    return true;
  }
});