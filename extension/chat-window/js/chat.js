const ChatWindowChat = (() => {
  const {
    Api,
    Storage,
    state,
    $,
    setText,
    renderStructuredText,
    markSectionUnread,
    notifyUser,
  } = ChatWindowCore;
  const LATEST_EXCHANGE_COUNT = 2;
  const CHAT_HISTORY_LIMIT = 20;
  const AUTO_SKIP_PROACTIVE_MS = 10 * 1000;

  function autoResizeInput() {
    const input = $("chatInput");
    if (!input) return;
    input.style.height = "auto";
    input.style.height = `${Math.min(input.scrollHeight, 140)}px`;
  }

  function normalizeChatMode(modeRaw) {
    const mode = String(modeRaw || "friendly").trim().toLowerCase();
    if (mode === "friendly" || mode === "normal" || mode === "educational") return mode;
    if (mode === "academic") return "educational";
    return "friendly";
  }

  function normalizeProactiveMode(modeRaw) {
    const mode = String(modeRaw || "balanced").trim().toLowerCase();
    if (mode === "calm" || mode === "balanced" || mode === "active") return mode;
    return "balanced";
  }

  function formatTriggerReasonLabel(reasonRaw) {
    const reason = String(reasonRaw || "").trim().toLowerCase();
    if (reason === "key_moment") return "Key idea";
    if (reason === "definition") return "New term";
    if (reason === "complex_concept") return "Difficult part";
    if (reason === "rewatch_confusion") return "Rewatch";
    if (reason === "hesitation_confusion") return "Hesitation";
    if (reason === "resume_after_break") return "Welcome back";
    if (reason === "forward_jump") return "Jumped ahead";
    if (reason === "section_start") return "New section";
    if (reason === "progress_checkpoint") return "Checkpoint";
    if (reason === "long_pause") return "Paused";
    if (reason === "video_complete") return "Complete";
    if (reason === "rhetorical_question") return "Key question";
    return "";
  }

  function normalizeTextKey(value) {
    return String(value || "").replace(/\s+/g, " ").trim().toLowerCase();
  }

  function truncateForNotification(value, maxLength = 120) {
    const text = String(value || "").replace(/\s+/g, " ").trim();
    if (text.length <= maxLength) return text;
    return `${text.slice(0, Math.max(0, maxLength - 1)).trimEnd()}...`;
  }

  function getCreatedAtMs(item) {
    const createdAtMs = Date.parse(String(item?.createdAt || ""));
    return Number.isFinite(createdAtMs) ? createdAtMs : 0;
  }

  function shouldAutoSkipProactive(item, now = Date.now()) {
    if (!item?.proactive) return false;
    if (item.resolved || item.replyAttached || item.autoSkipPending) return false;
    const createdAtMs = getCreatedAtMs(item);
    if (!createdAtMs) return false;
    return now - createdAtMs >= AUTO_SKIP_PROACTIVE_MS;
  }

  function isHistoryOnlyExchange(exchange, now = Date.now()) {
    if (!Array.isArray(exchange) || exchange.length === 0) return false;
    const hasUserReply = exchange.some((item) => item?.role === "user");
    if (hasUserReply) return false;
    return exchange.some((item) => shouldAutoSkipProactive(item, now) || (item?.proactive && item?.resolved && !item?.replyAttached));
  }

  function markProactiveThreadUsed(threadId) {
    if (!threadId) return;
    const target = state.proactiveItems.find((entry) => entry.id === threadId);
    if (target) target.replyAttached = true;
  }

  function addReplyThreadAnchor(threadId, userText) {
    if (!threadId || !userText) return;
    state.replyThreadAnchors = [
      ...(state.replyThreadAnchors || []),
      {
        threadId,
        userText: String(userText),
        userTextKey: normalizeTextKey(userText),
        createdAtMs: Date.now(),
        matched: false,
      },
    ].slice(-20);
  }

  function getLikelyReplyThreadId(options = {}) {
    if (options.replyToProactiveId) return String(options.replyToProactiveId);

    const candidates = [...(state.proactiveItems || [])]
      .filter((item) => item?.id && !item.replyAttached)
      .sort((a, b) => new Date(b?.createdAt || 0).getTime() - new Date(a?.createdAt || 0).getTime());

    const latest = candidates[0];
    if (!latest) return "";

    const ageMs = Date.now() - new Date(latest.createdAt || 0).getTime();
    if (!Number.isFinite(ageMs) || ageMs > 4 * 60 * 1000) return "";
    return String(latest.id);
  }

  function annotateServerItemsWithThreads(items) {
    const annotated = (Array.isArray(items) ? items : []).map((item) => ({ ...item }));
    const anchors = state.replyThreadAnchors || [];
    if (!annotated.length || !anchors.length) return annotated;

    for (const anchor of anchors) {
      if (!anchor?.threadId || !anchor?.userTextKey || anchor.matched) continue;

      for (let i = annotated.length - 1; i >= 0; i -= 1) {
        const item = annotated[i];
        if (item.role !== "user" || item.threadId) continue;
        if (normalizeTextKey(item.text) !== anchor.userTextKey) continue;

        item.threadId = anchor.threadId;
        if (annotated[i + 1]?.role === "assistant" && !annotated[i + 1].proactive) {
          annotated[i + 1].threadId = anchor.threadId;
        }
        anchor.matched = true;
        break;
      }
    }

    state.replyThreadAnchors = anchors.filter((anchor) => !anchor.matched || Date.now() - anchor.createdAtMs < 10 * 60 * 1000);
    return annotated;
  }

  async function handleProactiveAction(item, action) {
    if (!item?.id || !action?.id) return;
    try {
      const deviceId = await Storage.getDeviceId();
      await Api.sendProactiveFeedback(deviceId, {
        videoId: state.currentVideo?.videoId,
        proactiveId: item.id,
        action: action.id,
      });
    } catch {
      // Keep action taps resilient; the chat send below can still proceed.
    }

    const target = state.proactiveItems.find((entry) => entry.id === item.id);
    if (target) {
      target.actions = [];
      target.resolved = true;
      target.replyAttached = !!action.message;
      target.archived = !action.message;
    }
    renderMergedConversation();

    if (action.message) {
      await sendMessageText(action.message, { replyToProactiveId: item.id });
      return;
    }

    setText("chatStatus", "Skipped. I will wait for a better moment.");
  }

  function createQuickActionButton(item, action) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "quickActionBtn";
    btn.textContent = action.label;
    btn.addEventListener("click", async () => {
      await handleProactiveAction(item, action);
    });
    return btn;
  }

  function createChatMessage(item) {
    const wrap = document.createElement("div");
    wrap.className = `chatMessage ${item.role === "assistant" ? "assistant" : "user"}`;
    if (item.pending) wrap.classList.add("pending");
    if (item.error) wrap.classList.add("error");
    if (item.proactive) wrap.classList.add("proactive");

    const role = document.createElement("div");
    role.className = "chatRole";
    if (item.role === "assistant" && item.proactive) {
      role.textContent = "Bot";
      const badge = document.createElement("span");
      badge.className = "chatRoleBadge";
      badge.textContent = "Proactive";
      role.appendChild(badge);
      const reasonLabel = formatTriggerReasonLabel(item.triggerReason);
      if (reasonLabel) {
        const reasonBadge = document.createElement("span");
        reasonBadge.className = "chatRoleBadge is-secondary";
        reasonBadge.textContent = reasonLabel;
        role.appendChild(reasonBadge);
      }
    } else {
      role.textContent = item.role === "assistant" ? "Bot" : "You";
    }

    const text = document.createElement("div");
    text.className = "chatText";
    renderStructuredText(text, item.text || "");

    wrap.appendChild(role);
    wrap.appendChild(text);

    if (
      item.role === "assistant" &&
      item.proactive &&
      !item.pending &&
      !item.error &&
      Array.isArray(item.actions) &&
      item.actions.length > 0
    ) {
      const actions = document.createElement("div");
      actions.className = "proactiveQuickActions";
      for (const action of item.actions) {
        actions.appendChild(createQuickActionButton(item, action));
      }
      wrap.appendChild(actions);
    }

    return wrap;
  }

  function createEmptyState(message) {
    const empty = document.createElement("div");
    empty.className = "chatEmpty";
    empty.textContent = message;
    return empty;
  }

  function groupConversation(items) {
    const exchanges = [];

    for (const item of items || []) {
      const current = exchanges[exchanges.length - 1];
      const threadId = String(item?.threadId || "");

      if (
        threadId &&
        current &&
        current.some((m) => String(m?.id || "") === threadId || String(m?.threadId || "") === threadId)
      ) {
        current.push(item);
        continue;
      }

      if (item.role === "assistant" && item.proactive) {
        exchanges.push([item]);
        continue;
      }

      if (item.role === "user") {
        // If the current exchange started from a proactive prompt and no user has replied yet,
        // keep the reply in the same exchange for better conversational continuity.
        if (current && current.some((m) => m.proactive) && !current.some((m) => m.role === "user")) {
          current.push(item);
        } else {
          exchanges.push([item]);
        }
        continue;
      }

      if (current) current.push(item);
      else exchanges.push([item]);
    }

    return exchanges;
  }

  function getPendingRenderItems() {
    const items = [];

    for (const job of state.pendingJobs) {
      items.push({
        role: "user",
        text: job.message,
        pending: job.status === "queued" || job.status === "sending",
        localId: `${job.id}:user`,
        threadId: job.threadId || "",
      });

      items.push({
        role: "assistant",
        text:
          job.status === "queued"
            ? "Queued..."
            : job.status === "sending"
              ? (job.reply || "Thinking...")
              : job.status === "error"
                ? `Error: ${job.errorMessage || "Failed to send"}`
                : (job.reply || ""),
        pending: job.status === "queued" || job.status === "sending",
        error: job.status === "error",
        localId: `${job.id}:assistant`,
        threadId: job.threadId || "",
      });
    }

    return items;
  }

  function renderChatItems(items) {
    const latestRoot = $("latestExchange");
    const historyRoot = $("historyList");
    if (!latestRoot || !historyRoot) return;

    latestRoot.innerHTML = "";
    historyRoot.innerHTML = "";

    const exchanges = groupConversation(items);
    if (exchanges.length === 0) {
      latestRoot.appendChild(createEmptyState("No messages yet. Start the conversation above."));
      historyRoot.appendChild(createEmptyState("Past conversation will appear here."));
      return;
    }

    const historyOnly = [];
    const activeExchanges = [];
    const now = Date.now();

    for (const exchange of exchanges) {
      if (isHistoryOnlyExchange(exchange, now)) historyOnly.push(exchange);
      else activeExchanges.push(exchange);
    }

    const latest = activeExchanges.slice(-LATEST_EXCHANGE_COUNT);
    const history = [...historyOnly, ...activeExchanges.slice(0, -LATEST_EXCHANGE_COUNT)];

    for (const exchange of [...latest].reverse()) {
      const latestBlock = document.createElement("div");
      latestBlock.className = "exchangeBlock latestExchangeBlock";
      for (const item of exchange) {
        latestBlock.appendChild(createChatMessage(item));
      }
      latestRoot.appendChild(latestBlock);
    }

    if (history.length === 0) {
      historyRoot.appendChild(createEmptyState("No past conversation yet."));
      return;
    }

    for (const exchange of [...history].reverse()) {
      const block = document.createElement("div");
      block.className = "exchangeBlock historyExchange";
      for (const item of exchange) {
        block.appendChild(createChatMessage(item));
      }
      historyRoot.appendChild(block);
    }
  }

  function renderMergedConversation() {
    const persisted = [...state.serverItems, ...state.proactiveItems].sort((a, b) => {
      const at = new Date(a?.createdAt || 0).getTime();
      const bt = new Date(b?.createdAt || 0).getTime();
      return at - bt;
    });
    renderChatItems([...persisted, ...getPendingRenderItems()]);
  }

  function clearChat(message = "") {
    const latestRoot = $("latestExchange");
    const historyRoot = $("historyList");
    if (!latestRoot || !historyRoot) return;

    latestRoot.innerHTML = "";
    historyRoot.innerHTML = "";

    if (message) {
      latestRoot.appendChild(createEmptyState(message));
      historyRoot.appendChild(createEmptyState("Past conversation will appear here."));
    }
  }

  function resetEphemeralMessages() {
    state.proactiveItems = [];
    state.proactiveSeen = {};
  }

  async function autoSkipExpiredProactiveItems() {
    const staleItems = (state.proactiveItems || []).filter((item) => shouldAutoSkipProactive(item));
    if (staleItems.length === 0) return false;

    let changed = false;
    const deviceId = await Storage.getDeviceId();

    for (const item of staleItems) {
      item.autoSkipPending = true;
      try {
        await Api.sendProactiveFeedback(deviceId, {
          videoId: state.currentVideo?.videoId,
          proactiveId: item.id,
          action: "skip",
        });
      } catch {
        item.autoSkipPending = false;
        continue;
      }

      item.autoSkipPending = false;
      item.actions = [];
      item.resolved = true;
      item.archived = true;
      changed = true;
    }

    return changed;
  }

  async function loadChatForCurrentVideo() {
    if (!state.currentVideo?.videoId) {
      state.serverItems = [];
      clearChat("No active YouTube video for this window.");
      return;
    }

    try {
      setText("chatStatus", state.isSending ? "Waiting for response..." : "Loading chat...");
      const deviceId = await Storage.getDeviceId();
      const data = await Api.fetchChatHistory(deviceId, state.currentVideo.videoId, CHAT_HISTORY_LIMIT);
      state.serverItems = annotateServerItemsWithThreads(data.items);
      renderMergedConversation();
      if (!state.isSending) setText("chatStatus", "");
    } catch (e) {
      state.serverItems = [];
      renderMergedConversation();
      setText("chatStatus", `Chat load failed: ${e.message}`);
    }
  }

  function mergeProactiveItems(items) {
    if (!Array.isArray(items) || items.length === 0) return false;
    let changed = false;
    const seen = state.proactiveSeen || {};
    let latestAdded = null;

    for (const item of items) {
      const id = String(item?.id || "");
      if (!id || seen[id]) continue;
      seen[id] = true;
      state.proactiveItems.push({
        id,
        role: "assistant",
        text: String(item?.text || ""),
        createdAt: item?.createdAt || new Date().toISOString(),
        proactive: true,
        triggerReason: String(item?.triggerReason || ""),
        actions: Array.isArray(item?.actions) ? item.actions : [],
        resolved: false,
        replyAttached: false,
      });
      latestAdded = item;
      changed = true;
    }

    state.proactiveSeen = seen;
    if (changed && state.proactiveItems.length > 40) {
      state.proactiveItems = state.proactiveItems.slice(-40);
    }
    if (latestAdded?.id) {
      markSectionUnread("chat");
      notifyUser({
        title: "New message",
        message: truncateForNotification(latestAdded.text || "The bot has a new check-in for this video."),
        dedupeKey: `proactive:${latestAdded.id}`,
      }).catch(() => {});
    }
    return changed;
  }

  async function pollProactiveForCurrentVideo() {
    if (!state.currentVideo?.videoId) return;
    try {
      let changed = false;
      
      // Debug: Check current video state
      console.log(`[PROACTIVE POLL] Video ID: ${state.currentVideo.videoId}`);
      
      if (await autoSkipExpiredProactiveItems()) {
        changed = true;
        console.log(`[PROACTIVE POLL] Skipped expired items`);
      }
      
      const deviceId = await Storage.getDeviceId();
      console.log(`[PROACTIVE POLL] Device ID: ${deviceId}`);
      
      const data = await Api.pollProactiveMessages(deviceId, state.currentVideo.videoId);
      console.log(`[PROACTIVE POLL] API Response:`, JSON.stringify(data, null, 2));
      
      if (mergeProactiveItems(data?.items)) {
        changed = true;
        console.log(`[PROACTIVE POLL] Merged new proactive items`);
      } else {
        console.log(`[PROACTIVE POLL] No new proactive items to merge`);
      }
      
      if (changed) {
        renderMergedConversation();
        console.log(`[PROACTIVE POLL] Conversation rendered`);
      }
    } catch (e) {
      console.error(`[PROACTIVE POLL] Error:`, e.message);
      // Keep this silent; polling should never interrupt normal chat UX.
    }
  }

  async function sendMessageText(rawMessage, options = {}) {
    if (!state.currentVideo?.videoId) {
      setText("chatStatus", "No active YouTube video.");
      return;
    }

    const message = String(rawMessage || "").trim();
    if (!message) {
      setText("chatStatus", "Type a message first.");
      return;
    }

    const job = {
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      message,
      status: "queued",
      reply: "",
      errorMessage: "",
      threadId: getLikelyReplyThreadId(options),
    };

    if (job.threadId) {
      markProactiveThreadUsed(job.threadId);
      addReplyThreadAnchor(job.threadId, message);
    }

    state.pendingJobs.push(job);

    if (options.clearInput) {
      const input = $("chatInput");
      if (input) {
        input.value = "";
        input.style.height = "auto";
      }
    }

    renderMergedConversation();
    setText("chatStatus", state.isSending ? "Added to queue." : "Sending...");
    await processSendQueue();
  }

  async function sendMessage() {
    const input = $("chatInput");
    await sendMessageText(input?.value || "", { clearInput: true });
  }

  async function processSendQueue() {
    if (state.isSending) return;
    if (!state.currentVideo?.videoId) return;

    state.isSending = true;

    try {
      while (true) {
        const job = state.pendingJobs.find((item) => item.status === "queued");
        if (!job) break;

        job.status = "sending";
        renderMergedConversation();
        setText("chatStatus", "Waiting for response...");

        try {
          const deviceId = await Storage.getDeviceId();
          const result = await Api.sendChatMessageStream(
            deviceId,
            state.currentVideo.videoId,
            job.message,
            {
              onChunk: async (delta) => {
                job.reply += String(delta || "");
                renderMergedConversation();
              },
            }
          );

          job.status = "done";
          job.reply = String(result?.reply || "").trim();
          renderMergedConversation();
          markSectionUnread("chat");
          await notifyUser({
            title: "Bot replied",
            message: truncateForNotification(job.reply || "A new reply is ready."),
            dedupeKey: `reply:${job.id}`,
          });

          state.pendingJobs = state.pendingJobs.filter((item) => item.id !== job.id);
          await loadChatForCurrentVideo();
        } catch (e) {
          job.status = "error";
          job.errorMessage = e.message || String(e);
          renderMergedConversation();
        }
      }
    } finally {
      state.isSending = false;
      setText(
        "chatStatus",
        state.pendingJobs.some((item) => item.status === "error")
          ? "Some messages failed."
          : ""
      );
    }
  }

  async function clearCurrentVideoHistory() {
    if (!state.currentVideo?.videoId) {
      setText("chatStatus", "No active YouTube video.");
      return;
    }
  
    const confirmed = window.confirm("Delete all chat history for this video?");
    if (!confirmed) return;
  
    try {
      setText("chatStatus", "Clearing chat history...");
  
      const deviceId = await Storage.getDeviceId();
      await Api.clearChatHistory(deviceId, state.currentVideo.videoId);
  
      state.serverItems = [];
      state.pendingJobs = [];
      resetEphemeralMessages();
  
      renderMergedConversation();
      setText("chatStatus", "Chat history cleared.");
    } catch (e) {
      setText("chatStatus", `Failed to clear chat history: ${e.message}`);
    }
  }

  async function loadChatModeForCurrentVideo() {
    const select = $("chatModeSelect");
    if (!select) return;
    if (!state.currentVideo?.videoId) {
      state.chatMode = "friendly";
      select.value = state.chatMode;
      setText("chatModeStatus", "Affects reply tone and depth.");
      return;
    }
    try {
      const deviceId = await Storage.getDeviceId();
      const data = await Api.fetchChatMode(deviceId, state.currentVideo.videoId);
      state.chatMode = normalizeChatMode(data?.mode);
      select.value = state.chatMode;
      setText("chatModeStatus", "Affects reply tone and depth.");
    } catch (e) {
      setText("chatModeStatus", `Failed to load: ${e.message}`);
    }
  }

  async function saveChatMode(modeRaw) {
    const mode = normalizeChatMode(modeRaw);
    state.chatMode = mode;
    if (!state.currentVideo?.videoId) {
      setText("chatModeStatus", "Open a YouTube video first.");
      return;
    }
    setText("chatModeStatus", "Saving...");
    try {
      const deviceId = await Storage.getDeviceId();
      const data = await Api.saveChatMode(deviceId, state.currentVideo.videoId, mode);
      state.chatMode = normalizeChatMode(data?.mode);
      const select = $("chatModeSelect");
      if (select) select.value = state.chatMode;
      setText("chatModeStatus", "Saved");
      setTimeout(() => {
        if ($("chatModeStatus")?.textContent === "Saved") {
          setText("chatModeStatus", "Affects reply tone and depth.");
        }
      }, 1200);
    } catch (e) {
      setText("chatModeStatus", `Save failed: ${e.message}`);
    }
  }

  function wireChatModeControl() {
    const select = $("chatModeSelect");
    if (!select) return;
    select.value = normalizeChatMode(state.chatMode);
    select.addEventListener("change", async () => {
      await saveChatMode(select.value);
    });
  }

  async function loadProactiveModeSetting() {
    const select = $("proactiveAssistSelect");
    if (!select) return;
    try {
      const deviceId = await Storage.getDeviceId();
      const data = await Api.fetchProactiveSettings(deviceId);
      state.proactiveMode = normalizeProactiveMode(data?.mode);
      select.value = state.proactiveMode;
      setText("proactiveAssistStatus", "Controls how often the extension checks in.");
    } catch (e) {
      state.proactiveMode = "balanced";
      select.value = state.proactiveMode;
      setText("proactiveAssistStatus", `Failed to load: ${e.message}`);
    }
  }

  async function saveProactiveMode(modeRaw) {
    const mode = normalizeProactiveMode(modeRaw);
    state.proactiveMode = mode;
    setText("proactiveAssistStatus", "Saving...");
    try {
      const deviceId = await Storage.getDeviceId();
      const data = await Api.saveProactiveSettings(deviceId, mode);
      state.proactiveMode = normalizeProactiveMode(data?.mode);
      const select = $("proactiveAssistSelect");
      if (select) select.value = state.proactiveMode;
      setText("proactiveAssistStatus", "Saved");
      setTimeout(() => {
        if ($("proactiveAssistStatus")?.textContent === "Saved") {
          setText("proactiveAssistStatus", "Controls how often the extension checks in.");
        }
      }, 1200);
    } catch (e) {
      setText("proactiveAssistStatus", `Save failed: ${e.message}`);
    }
  }

  function wireProactiveModeControl() {
    const select = $("proactiveAssistSelect");
    if (!select) return;
    select.value = normalizeProactiveMode(state.proactiveMode);
    select.addEventListener("change", async () => {
      await saveProactiveMode(select.value);
    });
  }

  return {
    autoResizeInput,
    clearChat,
    resetEphemeralMessages,
    loadChatForCurrentVideo,
    pollProactiveForCurrentVideo,
    sendMessage,
    clearCurrentVideoHistory,
    wireChatModeControl,
    wireProactiveModeControl,
    loadChatModeForCurrentVideo,
    loadProactiveModeSetting,
  };
})();
