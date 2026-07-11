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
  // single-page app that re-renders routes. The illustrations that stock CSS supplies
  // via content:url() on <img> and the popout button (legacy Safari cannot load
  // extension pages in tabs; v1.41.0 shipped popOut() as a no-op) are hidden by rules
  // the packaging step appends to popup/main.css. Here:
  // - Hide header sections that only held the popout button, so the search field
  //   keeps its original inset instead of running against the window edge.
  // - Hide the context menu setting, because context menu support is omitted from
  //   this port (legacy Safari menus cannot express the nested menu tree).
  var doc = g.document;
  function applyUiFixes() {
    function hide(el) { if (el && el.style.display !== "none") el.style.display = "none"; }
    Array.prototype.forEach.call(doc.querySelectorAll("header .left, header .right"), function (el) {
      var kids = el.children, onlyPopout = kids.length > 0;
      for (var i = 0; i < kids.length; i++) {
        if (kids[i].tagName.toLowerCase() !== "app-pop-out") { onlyPopout = false; break; }
      }
      if (onlyPopout) hide(el);
    });
    var cm = doc.getElementById("context-menu");
    hide(cm && cm.closest ? cm.closest(".box-content-row") : null);
    hide(doc.getElementById("context-menuHelp"));
  }
  function watchUi() {
    applyUiFixes();
    new MutationObserver(applyUiFixes).observe(doc.documentElement, { childList: true, subtree: true });
  }
  if (doc.readyState === "loading") doc.addEventListener("DOMContentLoaded", watchUi);
  else watchUi();
})(this);
