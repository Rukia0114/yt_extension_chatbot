const ChatWindowCore = (() => {
  const Api = globalThis.Api;
  const Storage = globalThis.Storage;
  const Yt = globalThis.Yt;
  const DEFAULT_WINDOW_TITLE = document.title || "Video Chat Window";

  const state = {
    tabId: null,
    followActiveTab: false,
    activeSection: "chat",
    currentVideo: null,
    pollTimer: null,
    proactivePollTimer: null,
    summaryRetryTimer: null,
    serverItems: [],
    proactiveItems: [],
    proactiveSeen: {},
    replyThreadAnchors: [],
    chatMode: "friendly",
    proactiveMode: "balanced",
    pendingJobs: [],
    isSending: false,
    unreadNotificationCount: 0,
    notificationPermissionRequested: false,
    notificationDedup: {},
    unreadSections: {
      insights: false,
      chat: false,
    },
  };

  function $(id) {
    return document.getElementById(id);
  }

  function setText(id, text) {
    const el = $(id);
    if (el) el.textContent = text || "";
  }

  function isShortHeadingLine(line, nextLine = "") {
    const text = String(line || "").trim();
    if (!text) return false;
    if (/^(?:[-*]|\d+\.)\s/.test(text)) return false;
    if (/[.:!?]$/.test(text)) return false;
    const words = text.split(/\s+/).filter(Boolean);
    if (words.length === 0 || words.length > 5) return false;
    if (text.length > 48) return false;
    return !nextLine || !String(nextLine).trim();
  }

  function appendLineWithSelectiveBold(container, line, nextLine = "") {
    const text = String(line || "");
    const bulletMatch = text.match(/^(\s*(?:[-*]|\d+\.)\s+)(.*)$/);
    const prefix = bulletMatch ? bulletMatch[1] : "";
    const body = bulletMatch ? bulletMatch[2] : text;
    const labelMatch = body.match(/^([A-Za-z][A-Za-z0-9'()/ -]{0,40}?):(\s*.*)$/);

    if (prefix) {
      container.appendChild(document.createTextNode(prefix));
    }

    if (labelMatch) {
      const words = labelMatch[1].trim().split(/\s+/).filter(Boolean);
      if (words.length > 0 && words.length <= 5) {
        const strong = document.createElement("strong");
        strong.textContent = labelMatch[1].trim();
        container.appendChild(strong);
        container.appendChild(document.createTextNode(`:${labelMatch[2] || ""}`));
        return;
      }
    }

    if (!prefix && isShortHeadingLine(body, nextLine)) {
      const strong = document.createElement("strong");
      strong.textContent = body.trim();
      container.appendChild(strong);
      return;
    }

    container.appendChild(document.createTextNode(body));
  }

  function renderStructuredText(target, text) {
    if (!target) return;
    target.textContent = "";

    const lines = String(text || "").split("\n");
    lines.forEach((line, index) => {
      if (index > 0) target.appendChild(document.createElement("br"));
      appendLineWithSelectiveBold(target, line, lines[index + 1] || "");
    });
  }

  function setLink(id, text, href) {
    const el = $(id);
    if (!el) return;
    el.textContent = text || "";
    el.href = href || "";
  }

  function setBadge(kind, text) {
    const el = $("boundStatus");
    if (!el) return;
    el.textContent = text;
    el.className = `badge ${kind}`;
  }

  function setLinkedPill(linked) {
    const pill = $("linkedPill");
    if (!pill) return;
    pill.textContent = linked ? "Linked" : "Not linked";
    pill.className = `pill ${linked ? "pill-ok" : "pill-bad"}`;
  }

  function setChatEnabled(enabled) {
    const input = $("chatInput");
    const sendBtn = $("chatSendBtn");
    if (input) input.disabled = !enabled;
    if (sendBtn) sendBtn.disabled = !enabled;
  }

  function getTabIdFromQuery() {
    const url = new URL(location.href);
    const raw = url.searchParams.get("tabId");
    const tabId = Number(raw || 0);
    return Number.isInteger(tabId) && tabId > 0 ? tabId : null;
  }

  function parseYouTubeVideoId(url) {
    if (Yt?.parseYouTubeVideoId) return Yt.parseYouTubeVideoId(url);
    try {
      const u = new URL(url);
      if (u.hostname.includes("youtube.com") && u.pathname === "/watch") return u.searchParams.get("v");
      if (u.hostname === "youtu.be") return u.pathname.replace("/", "");
      return null;
    } catch {
      return null;
    }
  }

  function fmtTime(totalSeconds) {
    const sec = Math.max(0, Math.floor(Number(totalSeconds || 0)));
    const hours = Math.floor(sec / 3600);
    const minutes = Math.floor((sec % 3600) / 60);
    const seconds = sec % 60;

    if (hours > 0) {
      return `${hours}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
    }
    return `${minutes}:${String(seconds).padStart(2, "0")}`;
  }

  function shouldEscalateNotification() {
    return document.hidden || !document.hasFocus();
  }

  function renderSectionUnreadDots() {
    const mapping = {
      insights: $("tabInsights"),
      chat: $("tabChat"),
    };

    for (const [section, button] of Object.entries(mapping)) {
      if (!button) continue;
      const isUnread = !!state.unreadSections?.[section];
      button.classList.toggle("has-dot", isUnread && state.activeSection !== section);
    }
  }

  function setActiveSection(section) {
    state.activeSection = String(section || "chat");
    if (state.unreadSections[state.activeSection]) {
      state.unreadSections[state.activeSection] = false;
    }
    renderSectionUnreadDots();
  }

  function markSectionUnread(section) {
    const key = String(section || "").trim().toLowerCase();
    if (!key || !(key in state.unreadSections)) return;
    if (state.activeSection === key) {
      state.unreadSections[key] = false;
    } else {
      state.unreadSections[key] = true;
    }
    renderSectionUnreadDots();
  }

  function clearSectionUnread(section) {
    const key = String(section || "").trim().toLowerCase();
    if (!key || !(key in state.unreadSections)) return;
    state.unreadSections[key] = false;
    renderSectionUnreadDots();
  }

  function clearAllSectionUnread() {
    for (const key of Object.keys(state.unreadSections)) {
      state.unreadSections[key] = false;
    }
    renderSectionUnreadDots();
  }

  function updateWindowTitle() {
    document.title =
      state.unreadNotificationCount > 0
        ? `(${state.unreadNotificationCount}) ${DEFAULT_WINDOW_TITLE}`
        : DEFAULT_WINDOW_TITLE;
  }

  function clearUnreadNotifications() {
    if (!state.unreadNotificationCount) return;
    state.unreadNotificationCount = 0;
    updateWindowTitle();
  }

  function showToast(message, kind = "info") {
    const stack = $("toastStack");
    if (!stack || !message) return;

    const toast = document.createElement("div");
    toast.className = `toast${kind === "success" ? " is-success" : kind === "error" ? " is-error" : ""}`;
    toast.textContent = String(message);
    stack.appendChild(toast);

    setTimeout(() => {
      toast.remove();
    }, 4200);
  }

  function markNotificationSeenWhenActive() {
    if (!shouldEscalateNotification()) {
      clearUnreadNotifications();
    }
  }

  async function showDesktopNotification(title, message, tag = "") {
    if (!shouldEscalateNotification()) return;
    if (typeof Notification === "undefined") return;

    try {
      if (Notification.permission === "default" && !state.notificationPermissionRequested) {
        state.notificationPermissionRequested = true;
        await Notification.requestPermission();
      }

      if (Notification.permission !== "granted") return;

      const notification = new Notification(title || DEFAULT_WINDOW_TITLE, {
        body: String(message || ""),
        tag: tag || undefined,
        silent: true,
      });

      setTimeout(() => {
        try {
          notification.close();
        } catch {
          // Ignore close failures.
        }
      }, 5000);
    } catch {
      // Notification failures should never break the chat window.
    }
  }

  async function notifyUser({ title, message, kind = "info", dedupeKey = "" } = {}) {
    const text = String(message || "").trim();
    if (!text) return;

    const now = Date.now();
    if (dedupeKey) {
      const lastSeenAt = Number(state.notificationDedup[dedupeKey] || 0);
      if (lastSeenAt > 0) return;
      state.notificationDedup[dedupeKey] = now;

      for (const [key, seenAt] of Object.entries(state.notificationDedup)) {
        if (now - Number(seenAt || 0) > 24 * 60 * 60 * 1000) {
          delete state.notificationDedup[key];
        }
      }
    }

    if (!shouldEscalateNotification()) return;

    showToast(text, kind);
    state.unreadNotificationCount += 1;
    updateWindowTitle();
    await showDesktopNotification(title || DEFAULT_WINDOW_TITLE, text, dedupeKey);
  }

  window.addEventListener("focus", markNotificationSeenWhenActive);
  document.addEventListener("visibilitychange", markNotificationSeenWhenActive);

  return {
    Api,
    Storage,
    state,
    $,
    setText,
    setLink,
    setBadge,
    setLinkedPill,
    setChatEnabled,
    setActiveSection,
    markSectionUnread,
    clearSectionUnread,
    clearAllSectionUnread,
    getTabIdFromQuery,
    parseYouTubeVideoId,
    fmtTime,
    renderStructuredText,
    notifyUser,
  };
})();