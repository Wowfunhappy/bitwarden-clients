(function (g) {
  if (g.chrome && g.chrome.__bitwardenSafariLegacy) return;
  function backgroundChrome() {
    var b = safari.extension.globalPage && safari.extension.globalPage.contentWindow;
    return (b && b.__bwLegacyChrome) || null;
  }
  var bg = backgroundChrome();
  if (!bg) {
    // The popover document is loaded at extension launch, in parallel with the global
    // page, so it can run before the background bridge has installed __bwLegacyChrome.
    // The app bundle that follows this script needs `chrome` synchronously, and the
    // popover keeps its document between opens, so a page that boots without it would
    // stay broken (a spinner forever) until manually reloaded. Poll for the global
    // page and reload once it is ready.
    var wait = g.setInterval(function () {
      if (!backgroundChrome()) return;
      g.clearInterval(wait);
      g.location.reload();
    }, 100);
    return;
  }
  g.chrome = bg;
  g.browser = g.chrome;

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
      var actionable =
        target && target.closest && target.closest("button, a[href], [role='button']");
      if (actionable && actionable !== active) {
        try {
          active.blur();
        } catch (_) {}
      }
    },
    true,
  );

  // The packaging step fixes CSS image MIME types and hides the popout button:
  // Bitwarden pages need direct globalPage access and use the toolbar host.
  // Hide the context-menu setting here because this port omits nested menus.
  // Record which tab/URL this page booted against. The persistent popover only
  // shows correct per-tab content for the tab it booted on (the app assumes
  // Chrome's fresh-page-per-open popup lifecycle), so the background reloads it on
  // re-show over a different tab — and the visibilitychange listener below is a
  // fallback trigger for the same check.
  function currentTabKey(cb) {
    try {
      g.chrome.tabs.query({ active: true, currentWindow: true }, function (tabs) {
        var t = tabs && tabs[0];
        cb(t ? t.id + "|" + (t.url || "") : null);
      });
    } catch (_) {
      cb(null);
    }
  }
  currentTabKey(function (key) {
    g.__bwBootTabKey = key;
  });
  g.document.addEventListener("visibilitychange", function () {
    if (g.document.hidden || !g.__bwBootTabKey) return;
    currentTabKey(function (key) {
      if (key && key !== g.__bwBootTabKey) g.location.reload();
    });
  });

  var doc = g.document;
  function applyUiFixes() {
    function hide(el) {
      if (el && el.style.display !== "none") el.style.display = "none";
    }
    var cm = doc.getElementById("context-menu");
    hide(cm && cm.closest ? cm.closest(".box-content-row") : null);
    hide(doc.getElementById("context-menuHelp"));
  }
  function watchUi() {
    applyUiFixes();
    new MutationObserver(applyUiFixes).observe(doc.documentElement, {
      childList: true,
      subtree: true,
    });
  }
  if (doc.readyState === "loading") doc.addEventListener("DOMContentLoaded", watchUi);
  else watchUi();
})(this);
