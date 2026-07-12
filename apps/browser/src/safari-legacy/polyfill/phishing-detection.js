/*
 * Phishing detection for the legacy Safari target.
 *
 * A self-contained port of Bitwarden's phishing-detection feature. The upstream
 * implementation (apps/browser/src/dirt/phishing-detection) is entangled with newer
 * infrastructure that does not exist in 2024.11.2 (the `dirt` namespace, the
 * @bitwarden/messaging library, org event-logs, an IndexedDB patch pipeline) and its
 * warning surfaces by navigating the offending tab to an extension page — which cannot
 * load in a browser tab under legacy Safari. This reimplements the same protection with
 * the same authoritative data source, adapted to this environment:
 *
 *   - Fetch Bitwarden's public link blocklist and keep it in memory (~58k full URLs).
 *   - On each committed top-frame navigation, match the URL (exact href, with the same
 *     trailing-slash and http/https normalization the upstream matcher uses).
 *   - On a match, inject a full-page warning overlay into the tab via executeScript.
 *
 * Runs in the global page, after the WebExtension bridge has installed `chrome`.
 */
(function (g) {
  "use strict";
  var chrome = g.chrome;
  if (!chrome || !chrome.webNavigation || g.__bwPhishingDetection) return;
  g.__bwPhishingDetection = true;

  var BLOCKLIST_URL = "https://assets.bitwarden.com/security/v1/link-blocklist.txt";
  var REFRESH_MS = 12 * 60 * 60 * 1000; // refresh the list every 12 hours
  var RETRY_MS = 5 * 60 * 1000; // retry a failed fetch after 5 minutes

  var blocklist = null; // Set<string> of raw blocklist entries; null until first load
  var ignored = Object.create(null); // urls the user chose to bypass this session

  // Bitwarden's hardcoded test addresses (from the upstream matcher). Real phishing
  // URLs are taken down within hours, so these give a stable way to verify the feature.
  // https://bitwarden.github.io/phishing-test-page/inf-load/ is a real, loadable page.
  var TEST_URLS = new Set([
    "http://phishing.testcategory.com/",
    "https://phishing.testcategory.com/",
    "https://phishing.testcategory.com/block",
    "https://bitwarden.github.io/phishing-test-page/inf-load/",
  ]);

  function log(msg) { try { console.info("[bw-phishing] " + msg); } catch (_) {} }

  function loadBlocklist() {
    // Fetch in the global page (goes through the host's TLS stack). Fail open: if the
    // list can't be loaded, navigation is never blocked.
    g.fetch(BLOCKLIST_URL, { cache: "no-cache" })
      .then(function (r) { if (!r.ok) throw new Error("HTTP " + r.status); return r.text(); })
      .then(function (text) {
        var set = new Set();
        var lines = text.split("\n");
        for (var i = 0; i < lines.length; i++) {
          var line = lines[i].trim();
          if (line && line.charCodeAt(0) !== 35 /* # */) set.add(line);
        }
        blocklist = set;
        log("loaded " + set.size + " blocklist entries");
        g.setTimeout(loadBlocklist, REFRESH_MS);
      })
      .catch(function (e) {
        log("blocklist fetch failed: " + e + " — retrying later");
        g.setTimeout(loadBlocklist, RETRY_MS);
      });
  }

  // Mirrors the upstream matcher: the href and its trailing-slash / opposite-protocol
  // variants, checked against the hardcoded test set (always) and the blocklist (once
  // loaded). Test URLs therefore work even before the list finishes fetching.
  function urlVariants(href) {
    var variants = [];
    function add(u) {
      variants.push(u);
      if (u.charAt(u.length - 1) === "/") variants.push(u.slice(0, -1));
    }
    add(href);
    var swapped =
      href.indexOf("https://") === 0 ? "http://" + href.slice(8)
      : href.indexOf("http://") === 0 ? "https://" + href.slice(7)
      : null;
    if (swapped) add(swapped);
    return variants;
  }
  function inSet(variants, set) {
    for (var i = 0; i < variants.length; i++) {
      if (set.has(variants[i])) return true;
    }
    return false;
  }
  function isPhishing(href) {
    var variants = urlVariants(href);
    return inSet(variants, TEST_URLS) || (blocklist != null && inSet(variants, blocklist));
  }

  // The warning overlay is injected into the offending tab. It runs in the content-
  // script world (where `chrome` is available), covers the page, blocks interaction,
  // and re-adds itself if the page removes it.
  function overlayCode(phishingUrl) {
    var payload = { url: phishingUrl };
    return (
      "(" +
      function (data) {
        if (window.__bwPhishingOverlayUrl === data.url) return;
        window.__bwPhishingOverlayUrl = data.url;
        var ID = "__bw_phishing_overlay";
        function esc(s) {
          return String(s).replace(/[&<>\"']/g, function (c) {
            return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
          });
        }
        function build() {
          var host = document.createElement("div");
          host.id = ID;
          host.style.cssText =
            "position:fixed;inset:0;z-index:2147483647;background:#c62b2b;color:#fff;" +
            "font:16px/1.5 -apple-system,Helvetica,Arial,sans-serif;display:flex;" +
            "align-items:center;justify-content:center;text-align:center;padding:24px;margin:0;";
          host.innerHTML =
            '<div style="max-width:560px;margin:auto">' +
            '<div style="font-size:52px;line-height:1">&#9888;</div>' +
            '<h1 style="font-size:26px;margin:12px 0 8px">Phishing site blocked</h1>' +
            "<p style=\"margin:0 0 6px\">Bitwarden identified this page as a known phishing site. " +
            "Do not enter your passwords or personal information.</p>" +
            '<p style="margin:0 0 20px;opacity:.85;word-break:break-all;font-size:13px">' +
            esc(data.url) +
            "</p>" +
            '<button id="' + ID + '_leave" style="background:#fff;color:#c62b2b;border:0;' +
            'border-radius:6px;padding:12px 20px;font-size:16px;font-weight:600;cursor:pointer;margin:0 6px">' +
            "Get me out of here</button>" +
            '<button id="' + ID + '_ignore" style="background:transparent;color:#fff;border:1px solid rgba(255,255,255,.6);' +
            'border-radius:6px;padding:12px 20px;font-size:14px;cursor:pointer;margin:0 6px">' +
            "Ignore warning</button>" +
            '<p style="margin:22px 0 0;opacity:.7;font-size:12px">Protected by Bitwarden</p>' +
            "</div>";
          return host;
        }
        var overlay = build();
        (document.documentElement || document.body).appendChild(overlay);
        document.getElementById(ID + "_leave").addEventListener("click", function () {
          if (history.length > 1) {
            history.back();
          } else {
            location.replace("about:blank");
          }
        });
        document.getElementById(ID + "_ignore").addEventListener("click", function () {
          teardown();
          try {
            chrome.runtime.sendMessage({ command: "bwPhishingIgnore", url: data.url });
          } catch (_) {}
        });
        // Re-add the overlay if the page tries to remove it.
        var mo = new MutationObserver(function () {
          if (window.__bwPhishingDismissed) return;
          if (!document.getElementById(ID)) {
            overlay = build();
            (document.documentElement || document.body).appendChild(overlay);
            wire();
          }
        });
        mo.observe(document.documentElement, { childList: true, subtree: true });
        function wire() {
          document.getElementById(ID + "_leave").addEventListener("click", function () {
            if (history.length > 1) { history.back(); } else { location.replace("about:blank"); }
          });
          document.getElementById(ID + "_ignore").addEventListener("click", function () {
            teardown();
            try { chrome.runtime.sendMessage({ command: "bwPhishingIgnore", url: data.url }); } catch (_) {}
          });
        }
        function teardown() {
          window.__bwPhishingDismissed = true;
          mo.disconnect();
          var el = document.getElementById(ID);
          if (el && el.parentNode) el.parentNode.removeChild(el);
        }
      }.toString() +
      ")(" +
      JSON.stringify(payload) +
      ")"
    );
  }

  // The overlay is injected via executeScript, which requires the destination page's
  // content script to be listening. On a fresh navigation it may not be ready at commit
  // time, so inject with a few bounded retries; the overlay code is idempotent, so extra
  // attempts are harmless no-ops once it has landed.
  function injectOverlay(tabId, url, attempt) {
    if (ignored[url]) return;
    try {
      chrome.tabs.executeScript(tabId, { code: overlayCode(url), frameId: 0 });
    } catch (e) {
      log("overlay injection failed: " + e);
    }
    if (attempt < 4) {
      g.setTimeout(function () { injectOverlay(tabId, url, attempt + 1); }, 300 + attempt * 400);
    }
  }

  function handleNavigation(details) {
    if (!details || details.frameId !== 0 || !details.url) return;
    var url = details.url;
    if (url.indexOf("http://") !== 0 && url.indexOf("https://") !== 0) return;
    if (ignored[url]) return;
    if (!isPhishing(url)) return;
    log("phishing navigation detected: " + url);
    injectOverlay(details.tabId, url, 0);
  }

  chrome.webNavigation.onCommitted.addListener(handleNavigation);
  if (chrome.webNavigation.onErrorOccurred) {
    chrome.webNavigation.onErrorOccurred.addListener(handleNavigation);
  }

  // Honor the user's "Ignore warning" choice for the rest of the session.
  if (chrome.runtime && chrome.runtime.onMessage) {
    chrome.runtime.onMessage.addListener(function (message) {
      if (message && message.command === "bwPhishingIgnore" && message.url) {
        ignored[message.url] = true;
      }
    });
  }

  loadBlocklist();
})(this);
