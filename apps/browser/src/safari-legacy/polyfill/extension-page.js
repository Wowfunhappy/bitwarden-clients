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
})(this);
