globalThis.UI = (() => {
    function $(id) {
      return document.getElementById(id);
    }
    function setText(id, text) {
      const el = $(id);
      if (el) el.textContent = text || "";
    }
    function setLink(id, text, href) {
      const a = $(id);
      if (!a) return;
      a.textContent = text || "";
      a.href = href || "";
    }
    return { $, setText, setLink };
  })();