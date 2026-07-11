(function (g) {
  if (g.chrome && g.chrome.__bitwardenSafariLegacy) return;
  var b = safari.extension.globalPage && safari.extension.globalPage.contentWindow;
  if (!b || !b.__bwLegacyChrome) throw new Error("Bitwarden Safari legacy background page is unavailable");
  g.chrome = b.__bwLegacyChrome; g.browser = g.chrome;

  // macOS Safari does not move keyboard focus to a <button> when it is clicked, so
  // clicking a button never blurs the text field that currently holds focus. Angular
  // forms configured with { updateOn: "submit" } only capture typed-in values through
  // each input's (blur) handler, so a plain button click can act on a stale, empty
  // form value. Blur the focused text field the moment a pointer press lands on a
  // button/link, which commits the value before the click event fires.
  g.document.addEventListener(
    "mousedown",
    function (e) {
      var active = g.document.activeElement;
      if (!active || !/^(INPUT|TEXTAREA|SELECT)$/.test(active.tagName)) return;
      var target = e.target;
      var actionable = target && target.closest && target.closest("button, a[href], [role='button']");
      if (actionable && actionable !== active) {
        try { active.blur(); } catch (_) {}
      }
    },
    true,
  );

  // UI adjustments for the legacy runtime, applied continuously since the popup is a
  // single-page app that re-renders routes:
  // - Empty-state and 2FA illustrations come from CSS "content: url(...)" on <img>,
  //   which WebKit does not support; assign a real src per the active theme instead.
  // - The popout button cannot work: legacy Safari refuses to load extension pages in
  //   tabs (v1.41.0 shipped popOut() as a no-op with the comment "Safari can't open
  //   popup in full page tab :(").
  // - The context menu setting is hidden because context menu support is omitted from
  //   this port (legacy Safari menus cannot express the nested menu tree).
  var doc = g.document, base = safari.extension.baseURI;
  function applyUiFixes() {
    var cls = doc.documentElement.className || "";
    var suffix = /theme_solarizedDark/.test(cls) ? "-solarized" : /theme_(dark|nord)/.test(cls) ? "-dark" : "-light";
    var want = base + "popup/images/search-desktop" + suffix + ".svg";
    Array.prototype.forEach.call(doc.querySelectorAll("img.no-items-image"), function (img) {
      if (img.getAttribute("src") !== want) img.setAttribute("src", want);
    });
    Array.prototype.forEach.call(doc.querySelectorAll("img.mfaType0"), function (img) {
      var mfa = base + "popup/images/0.png";
      if (img.getAttribute("src") !== mfa) img.setAttribute("src", mfa);
    });
    function hide(el) { if (el && el.style.display !== "none") el.style.display = "none"; }
    Array.prototype.forEach.call(doc.querySelectorAll("app-pop-out"), hide);
    var cm = doc.getElementById("context-menu");
    hide(cm && cm.closest ? cm.closest(".box-content-row") : null);
    hide(doc.getElementById("context-menuHelp"));
  }
  function watchUi() {
    applyUiFixes();
    new MutationObserver(applyUiFixes).observe(doc.documentElement, {
      childList: true, subtree: true, attributes: true, attributeFilter: ["class"],
    });
  }
  if (doc.readyState === "loading") doc.addEventListener("DOMContentLoaded", watchUi);
  else watchUi();
})(this);
