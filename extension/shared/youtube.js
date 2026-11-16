globalThis.Yt = (() => {
    function parseYouTubeVideoId(url) {
        try {
          const u = new URL(url);
          if (u.hostname.includes("youtube.com") && u.pathname === "/watch") return u.searchParams.get("v");
          if (u.hostname.includes("youtube.com") && u.pathname.startsWith("/shorts/")) return u.pathname.split("/")[2];
          if (u.hostname === "youtu.be") return u.pathname.replace("/", "");
          return null;
        } catch {
          return null;
        }
      }
  
    function fmtTime(sec) {
      sec = Math.max(0, Math.floor(Number(sec || 0)));
      const m = Math.floor(sec / 60);
      const s = sec % 60;
      return `${m}:${String(s).padStart(2, "0")}`;
    }
  
    return { parseYouTubeVideoId, fmtTime };
  })();