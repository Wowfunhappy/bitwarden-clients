/* WebExtension messaging and dynamic-injection bridge for legacy Safari content scripts. */
(function (g) {
  "use strict";
  if (g.chrome && g.chrome.__bitwardenSafariLegacyContent) return;
  // Keep WebKit's native content-script API before replacing `browser` with the
  // compatibility bridge. Autofill already uses chrome.dom when it is available.
  var nativeDom = g.browser && g.browser.dom;
  // Safari only exposes the injected-script API on the top frame in some legacy
  // WebKit builds. It may also remove the global before pagehide runs. Resolve and
  // retain the host objects while this script is being installed instead of looking
  // up the `safari` global later from message, port, and lifecycle callbacks.
  var safariApi = null;
  try {
    safariApi = g.safari || (g.top && g.top.safari) || null;
  } catch (_) {}
  var safariSelf = safariApi && safariApi.self;
  var safariTab = safariSelf && safariSelf.tab;
  var extensionBase = (safariApi && safariApi.extension && safariApi.extension.baseURI) || "";

  var seq = 1,
    pending = {},
    ports = {};
  // Chrome numbering: the top frame is 0 and every subframe has its own positive ID.
  // Safari delivers everything the global page sends to a tab to every frame in it,
  // so the global page appends the target frame's ID to the message name, and frames
  // drop messages addressed to another frame before reading the payload.
  var frameId = g === g.top ? 0 : 1 + Math.floor(Math.random() * 0x7ffffffe);
  var frameSuffix = ":" + frameId;
  function Event() {
    this.listeners = [];
  }
  Event.prototype.addListener = function (fn) {
    if (this.listeners.indexOf(fn) < 0) this.listeners.push(fn);
  };
  Event.prototype.removeListener = function (fn) {
    var i = this.listeners.indexOf(fn);
    if (i >= 0) this.listeners.splice(i, 1);
  };
  Event.prototype.hasListener = function (fn) {
    return this.listeners.indexOf(fn) >= 0;
  };
  Event.prototype.emit = function () {
    var a = arguments;
    this.listeners.slice().forEach(function (fn) {
      fn.apply(null, a);
    });
  };
  function dispatchMessage(name, message) {
    if (!safariTab || typeof safariTab.dispatchMessage !== "function") return false;
    try {
      safariTab.dispatchMessage(name, message);
      return true;
    } catch (_) {
      return false;
    }
  }
  function sendMessage(message, callback) {
    var id = "c" + Date.now() + "-" + seq++;
    return new Promise(function (resolve) {
      pending[id] = function (value) {
        delete pending[id];
        if (callback) callback(value);
        resolve(value);
      };
      if (
        !dispatchMessage("bw.legacy.runtime", {
          kind: "message",
          requestId: id,
          message: message,
          frameId: frameId,
          url: location.href,
        })
      ) {
        pending[id]();
        return;
      }
      setTimeout(function () {
        if (pending[id]) pending[id]();
      }, 10000);
    });
  }
  function connect(info) {
    var id = "p" + Date.now() + "-" + seq++;
    var p = {
      name: (info && info.name) || "",
      onMessage: new Event(),
      onDisconnect: new Event(),
      postMessage: function (m) {
        dispatchMessage("bw.legacy.port", { portId: id, message: m });
      },
      disconnect: function () {
        dispatchMessage("bw.legacy.port", { portId: id, disconnect: true });
        p.onDisconnect.emit(p);
        delete ports[id];
      },
    };
    ports[id] = p;
    if (
      !dispatchMessage("bw.legacy.runtime", {
        kind: "connect",
        portId: id,
        name: p.name,
        frameId: frameId,
        url: location.href,
      })
    ) {
      delete ports[id];
      setTimeout(function () {
        p.onDisconnect.emit(p);
      }, 0);
    }
    return p;
  }
  function load(url) {
    var x = new XMLHttpRequest();
    x.open("GET", url, true);
    x.onload = function () {
      if (x.status === 0 || x.status < 400)
        try {
          (0, eval)(x.responseText + "\n//# sourceURL=" + url);
        } catch (e) {
          console.error(e);
        }
    };
    x.send();
  }
  var onMessage = new Event();
  var chrome = {
    __bitwardenSafariLegacyContent: true,
    runtime: {
      id: "com.bitwarden.safari",
      lastError: null,
      onMessage: onMessage,
      sendMessage: sendMessage,
      connect: connect,
      getManifest: function () {
        return { manifest_version: 2, name: "Bitwarden", version: "2024.11.2-a" };
      },
      getURL: getURL,
    },
    extension: { getURL: getURL },
  };
  if (nativeDom && typeof nativeDom.openOrClosedShadowRoot === "function") {
    chrome.dom = {
      openOrClosedShadowRoot: function (node) {
        return nativeDom.openOrClosedShadowRoot(node);
      },
    };
  }
  // Mirrors the background bridge: legacy Safari baseURIs carry a per-session path
  // token; root-relative paths that already include it resolve against the origin,
  // hardcoded root-relative asset paths resolve against baseURI.
  function getURL(p) {
    var base = extensionBase;
    if (!base) return String(p == null ? "" : p);
    var origin = base.replace(/^([a-z][a-z0-9+.\-]*:\/\/[^\/]*)\/.*$/i, "$1");
    var basePath = base.slice(origin.length);
    p = String(p == null ? "" : p);
    if (p === "") return base;
    if (/^[a-z][a-z0-9+.\-]*:/i.test(p)) return p;
    if (p.charAt(0) === "/") {
      if ((p + "/").indexOf(basePath) === 0) return origin + p;
      return base + p.replace(/^\/+/, "");
    }
    return base + p;
  }
  // The injected autofill and overlay scripts read translations synchronously via
  // chrome.i18n.getMessage. Fetch the message catalog lazily — one synchronous
  // request per page, and only on pages where an injected script asks for it.
  var localeData = null,
    localeLower = null;
  function readJson(path) {
    try {
      var x = new XMLHttpRequest();
      x.open("GET", getURL(path), false);
      x.send();
      return JSON.parse(x.responseText);
    } catch (_) {
      return null;
    }
  }
  function ensureLocale() {
    if (localeData) return;
    if (!extensionBase) {
      localeData = {};
      localeLower = {};
      return;
    }
    // Only these regional variants ship in _locales; requesting a missing directory
    // logs a console error on the host page, so fall back deliberately.
    var regionals = ["en_GB", "en_IN", "pt_BR", "pt_PT", "zh_CN", "zh_TW"];
    var full = (navigator.language || "en").replace("-", "_"),
      lang = full.split("_")[0],
      candidates = [];
    if (regionals.indexOf(full) >= 0) candidates.push(full);
    if (candidates.indexOf(lang) < 0) candidates.push(lang);
    if (candidates.indexOf("en") < 0) candidates.push("en");
    for (var i = 0; i < candidates.length && !localeData; i++)
      localeData = readJson("_locales/" + candidates[i] + "/messages.json");
    localeData = localeData || {};
    localeLower = {};
    Object.keys(localeData).forEach(function (k) {
      localeLower[k.toLowerCase()] = localeData[k];
    });
  }
  chrome.i18n = {
    getUILanguage: function () {
      return navigator.language || "en";
    },
    getAcceptLanguages: function (cb) {
      var v = [navigator.language || "en"];
      if (cb)
        setTimeout(function () {
          cb(v);
        }, 0);
      return Promise.resolve(v);
    },
    // Chrome semantics: name lookup is case-insensitive; messages may contain named
    // $PLACEHOLDER$ references whose "content" maps $1..$9 to substitutions.
    getMessage: function (n, s) {
      ensureLocale();
      var e = localeData[n] || localeLower[String(n || "").toLowerCase()];
      if (!e) return "";
      var subs = s == null ? [] : Array.isArray(s) ? s : [s];
      function fill(str) {
        return String(str == null ? "" : str).replace(/\$(\d)/g, function (_, d) {
          var v = subs[Number(d) - 1];
          return v == null ? "" : String(v);
        });
      }
      var v = String(e.message || "").replace(/\$([A-Za-z0-9_@]+)\$/g, function (whole, name) {
        var ph = e.placeholders && e.placeholders[name],
          lc = name.toLowerCase();
        if (!ph && e.placeholders) {
          for (var k in e.placeholders) {
            if (k.toLowerCase() === lc) {
              ph = e.placeholders[k];
              break;
            }
          }
        }
        return ph ? fill(ph.content) : whole;
      });
      return fill(v).replace(/\$\$/g, "$");
    },
  };
  g.chrome = chrome;
  g.browser = chrome;

  // Relay for extension pages this page hosts in an iframe — the notification bar.
  // Those documents load in the web process, which reaches neither the global page nor
  // safari.self, so their bridge (hosted-page.js) forwards runtime messaging here and
  // this bridge's channel carries it. Routing it this way also gives the global page
  // the sender it expects: the notification handlers act on sender.tab, so a save or a
  // height adjustment has to arrive as a message from this tab.
  var hostedOrigin = extensionBase
    ? extensionBase.replace(/^([a-z][a-z0-9+.\-]*:\/\/[^\/]*)\/.*$/i, "$1").toLowerCase()
    : "";
  var hostedPorts = {};
  if (hostedOrigin) {
    g.addEventListener(
      "message",
      function (e) {
        var p = e.data && e.data.bwLegacyHostedBridge;
        // Only this extension's own documents may drive the relay; page script shares
        // this window but cannot post from the extension's origin.
        if (!p || String(e.origin).toLowerCase() !== hostedOrigin || !e.source) return;
        var source = e.source;
        function reply(payload) {
          try {
            source.postMessage({ bwLegacyHostedBridge: payload }, e.origin);
          } catch (_) {}
        }
        if (p.kind === "message") {
          sendMessage(p.message, function (response) {
            reply({ kind: "response", requestId: p.requestId, response: response });
          });
        } else if (p.kind === "connect") {
          var port = connect({ name: p.name });
          hostedPorts[p.portId] = port;
          port.onMessage.addListener(function (m) {
            reply({ kind: "port", portId: p.portId, message: m });
          });
          port.onDisconnect.addListener(function () {
            delete hostedPorts[p.portId];
            reply({ kind: "port", portId: p.portId, disconnect: true });
          });
        } else if (p.kind === "port" && hostedPorts[p.portId]) {
          if (p.disconnect) {
            hostedPorts[p.portId].disconnect();
            delete hostedPorts[p.portId];
          } else hostedPorts[p.portId].postMessage(p.message);
        }
      },
      false,
    );
  }

  // Tab-state reporter. The hosting browser does not reliably surface tab switches
  // or navigations to the global page (application events and hidden-page timers
  // both proved unreliable), but content-script messages are delivered immediately —
  // uBlock's legacy port tracks tabs the same way. Only the top frame reports.
  if (g === g.top) {
    var reportTab = function (kind) {
      dispatchMessage("bw.legacy.tab", { kind: kind, url: g.location.href });
    };
    reportTab("load");
    g.addEventListener("focus", function () {
      reportTab("focus");
    });
    g.addEventListener("pageshow", function () {
      reportTab("load");
    });
    g.addEventListener("hashchange", function () {
      reportTab("nav");
    });
    g.addEventListener("popstate", function () {
      reportTab("nav");
    });
    g.document.addEventListener("visibilitychange", function () {
      if (!g.document.hidden) reportTab("focus");
    });
  }
  function onGlobalPageMessage(e) {
    // WebKit fires neither pagehide nor unload for a frame removed before its load
    // event finishes, so a removed frame releases its listener here instead.
    if (g.closed) {
      stopListening();
      return;
    }
    // Reading e.message deserializes the payload, so the name is checked first.
    var name = String(e.name),
      sep = name.indexOf(":");
    if (sep >= 0) {
      if (name.slice(sep) !== frameSuffix) return;
      name = name.slice(0, sep);
    }
    if (
      name !== "bw.legacy.response" &&
      name !== "bw.legacy.runtime" &&
      name !== "bw.legacy.port" &&
      name !== "bw.legacy.execute"
    )
      return;
    var p = e.message || {};
    if (name === "bw.legacy.response" && pending[p.requestId]) pending[p.requestId](p.response);
    else if (name === "bw.legacy.runtime" && p.kind === "message") {
      var answered = false,
        waiting = false;
      function reply(value) {
        if (answered) return;
        answered = true;
        dispatchMessage("bw.legacy.runtime", {
          kind: "response",
          requestId: p.requestId,
          response: value,
        });
      }
      // Chrome semantics: only sendResponse delivers a response; `true` keeps the
      // channel open for it and a returned Promise resolves as it. A plain return
      // value (e.g. `false`/`null` for "not handling this") is ignored so it cannot
      // clobber another listener's real sendResponse.
      onMessage.listeners.slice().forEach(function (fn) {
        var v = fn(p.message, {}, reply);
        if (v === true) waiting = true;
        else if (v && typeof v.then === "function") {
          waiting = true;
          v.then(reply, function () {
            reply();
          });
        }
      });
      if (!answered && !waiting) reply();
    } else if (name === "bw.legacy.port" && ports[p.portId]) {
      if (p.disconnect) {
        ports[p.portId].onDisconnect.emit(ports[p.portId]);
        delete ports[p.portId];
      } else ports[p.portId].onMessage.emit(p.message, ports[p.portId]);
    } else if (name === "bw.legacy.execute") {
      if (p.file) load(p.baseURI + p.file);
      else if (p.code) (0, eval)(p.code);
      else if (p.cssFile) {
        var link = document.createElement("link");
        link.rel = "stylesheet";
        link.href = p.baseURI + p.cssFile;
        (document.head || document.documentElement).appendChild(link);
      } else if (p.cssCode) {
        var style = document.createElement("style");
        style.textContent = p.cssCode;
        (document.head || document.documentElement).appendChild(style);
      }
    }
  }

  // Safari retains the calling frame's JavaScript context for as long as a
  // listener is registered on safari.self, and safari.self belongs to the tab
  // rather than to this document. A listener that is never removed therefore
  // pins this document, its window and its DOM until the tab's top-level page
  // is replaced, so a page that renavigates a subframe accumulates one pinned
  // document per navigation. The handler is named and its registration tracked
  // so the context can be handed back.
  var listening = false;
  function startListening() {
    if (listening || !safariSelf || typeof safariSelf.addEventListener !== "function") return;
    try {
      safariSelf.addEventListener("message", onGlobalPageMessage, false);
      listening = true;
    } catch (_) {}
  }
  function stopListening() {
    if (!listening) return;
    listening = false;
    try {
      safariSelf.removeEventListener("message", onGlobalPageMessage, false);
    } catch (_) {}
  }
  startListening();
  // Hand the context back when this document goes away.
  g.addEventListener("pagehide", stopListening);
  // A back/forward restore reuses this document without injecting the content
  // script again, so the listener has to re-register itself from here. The
  // persisted guard keeps a normal load from double-registering.
  g.addEventListener("pageshow", function (e) {
    if (e.persisted) startListening();
  });
})(this);
