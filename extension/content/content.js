const Yt = globalThis.Yt || {};
let extensionContextAlive = true;
let attachTimer = null;
let urlWatchTimer = null;
const cleanupTimers = new Set();

function invalidateExtensionContext() {
  extensionContextAlive = false;
  if (attachTimer) clearInterval(attachTimer);
  if (urlWatchTimer) clearInterval(urlWatchTimer);
  for (const timer of cleanupTimers) clearInterval(timer);
  cleanupTimers.clear();
}

function isContextInvalidatedError(error) {
  return /Extension context invalidated/i.test(String(error?.message || error || ""));
}

function safeSendRuntimeMessage(payload) {
  if (!extensionContextAlive) return;
  try {
    if (!chrome?.runtime?.id) {
      invalidateExtensionContext();
      return;
    }
    chrome.runtime.sendMessage(payload);
  } catch (error) {
    if (isContextInvalidatedError(error)) {
      invalidateExtensionContext();
      return;
    }
    throw error;
  }
}

function getVideoId() {
  if (Yt.parseYouTubeVideoId) return Yt.parseYouTubeVideoId(location.href);
  try {
    const u = new URL(location.href);
    return u.searchParams.get("v");
  } catch {
    return null;
  }
}

function getTitle() {
  const el = document.querySelector("h1 yt-formatted-string");
  return el?.textContent?.trim() || document.title;
}

function getTimes() {
  const v = document.querySelector("video");
  if (!v) return null;
  return { currentTime: v.currentTime || 0, duration: v.duration || 0, paused: v.paused };
}

function sendUpdate(reason) {
  if (!extensionContextAlive) return;
  const videoId = getVideoId();
  const times = getTimes();
  if (!videoId || !times) return;

  safeSendRuntimeMessage({
    type: "WATCH_UPDATE",
    reason,
    eventAt: Date.now(),
    provider: "youtube",
    videoId,
    url: location.href,
    title: getTitle(),
    ...times,
  });
}

sendUpdate("init");

function attachVideoListeners() {
  if (!extensionContextAlive) return false;
  const v = document.querySelector("video");
  if (!v) return false;

  const baseHandler = (reason) => () => sendUpdate(reason);
  v.addEventListener("play", baseHandler("play"));
  v.addEventListener("pause", baseHandler("pause"));
  v.addEventListener("seeking", baseHandler("seeking"));
  v.addEventListener("seeked", baseHandler("seeked"));
  v.addEventListener("ended", baseHandler("ended"));
  v.addEventListener("loadedmetadata", baseHandler("loadedmetadata"));

  let lastTickAt = 0;
  v.addEventListener("timeupdate", () => {
    const now = Date.now();
    if (now - lastTickAt < 2500) return;
    lastTickAt = now;
    sendUpdate(v.paused ? "pause_tick" : "progress_tick");
  });

  // Catch long pauses even when no natural media events fire.
  let lastPausePulseAt = 0;
  const pausePulseTimer = setInterval(() => {
    if (!extensionContextAlive) return;
    if (!v.paused) return;
    const now = Date.now();
    if (now - lastPausePulseAt < 2500) return;
    lastPausePulseAt = now;
    sendUpdate("pause_tick");
  }, 1000);
  cleanupTimers.add(pausePulseTimer);

  return true;
}

let tries = 0;
attachTimer = setInterval(() => {
  if (!extensionContextAlive) return;
  tries += 1;
  if (attachVideoListeners() || tries > 20) clearInterval(attachTimer);
}, 250);

// YouTube SPA navigation detection
let lastHref = location.href;
urlWatchTimer = setInterval(() => {
  if (!extensionContextAlive) return;
  if (location.href !== lastHref) {
    lastHref = location.href;
    sendUpdate("url_change");
  }
}, 500);

// Popup/side panel can query current state or seek video
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.type === "GET_WATCH_STATE") {
    try {
      const url = location.href;
      const videoId = getVideoId();
      const title = getTitle();
      const times = getTimes() || { currentTime: 0, duration: 0, paused: true };

      sendResponse({
        provider: "youtube",
        videoId,
        url,
        title,
        ...times,
      });
    } catch {
      sendResponse(null);
    }
    return true;
  }

  if (msg?.type === "SEEK_TO") {
    const seekTo = Math.max(0, Number(msg.seconds || 0));
    
    function doSeek() {
      const v = document.querySelector("video");
      if (!v) {
        // Retry if video not ready
        setTimeout(doSeek, 100);
        return;
      }
      
      try {
        v.currentTime = seekTo;
        if (v.paused) {
          v.play().catch(() => {});
        }
        sendResponse({ success: true });
      } catch (e) {
        sendResponse({ success: false, error: e.message });
      }
    }
    
    doSeek();
    return true; // Keep channel open for async response
  }
});
