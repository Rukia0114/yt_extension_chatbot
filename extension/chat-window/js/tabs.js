const ChatWindowTabs = (() => {
  const { setActiveSection } = ChatWindowCore;
  const TAB_IDS = ["connection", "insights", "chat"];

  function capitalize(value) {
    return value.charAt(0).toUpperCase() + value.slice(1);
  }

  function setActiveTab(tabName) {
    setActiveSection(tabName);
    for (const name of TAB_IDS) {
      const btn = document.getElementById(`tab${capitalize(name)}`);
      const page = document.getElementById(`page${capitalize(name)}`);
      const isActive = name === tabName;

      if (btn) btn.classList.toggle("is-active", isActive);
      if (page) {
        page.hidden = !isActive;
        page.classList.toggle("is-active", isActive);
      }
    }
  }

  function wireTabs(defaultTab = "chat") {
    document.getElementById("tabConnection")?.addEventListener("click", () => {
      setActiveTab("connection");
    });

    document.getElementById("tabInsights")?.addEventListener("click", () => {
      setActiveTab("insights");
    });

    document.getElementById("tabChat")?.addEventListener("click", () => {
      setActiveTab("chat");
    });

    setActiveTab(defaultTab);
  }

  return {
    setActiveTab,
    wireTabs,
  };
})();
