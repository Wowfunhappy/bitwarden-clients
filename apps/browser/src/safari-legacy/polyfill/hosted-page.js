/* WebExtension bridge for extension pages that a web page hosts in an iframe. */
(function (g) {
  "use strict";
  if (g.chrome && g.chrome.__bitwardenSafariLegacyHosted) return;

  // The notification bar is an extension page, but the content script loads it into
  // an iframe on the web page, so it runs in the web process. That process reaches
  // neither safari.extension.globalPage, the channel the extension-page bridge uses,
  // nor safari.self, the channel the content bridge uses — legacy Safari exposes the
  // injected-script API to injected scripts, not to extension documents that happen
  // to load beside them. Everything below is therefore built from what the frame owns
  // by itself: its own URL for extension resource paths, same-origin requests for the
  // message catalog, and the hosting frame for anything that has to reach the global
  // page, which the content bridge there relays (see content.js).

  // Pages reached this way sit one directory below the extension root, so the root is
  // this document's URL with its last two path segments removed.
  var extensionBase = g.location.href.replace(/[?#].*$/, "").replace(/[^\/]*\/[^\/]*$/, "");

  var seq = 1,
    pending = {},
    ports = {};
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

  // The relay reaches the global page through the hosting page's content bridge, so
  // the host's own scripts can see what crosses it and can forge what comes back.
  // Requests are safe from that: they are accepted only from this extension's origin,
  // which page script cannot post from. Replies are not, which is the trust the bar
  // already places in its host — the content script hands it its notification type
  // and theme over the same window channel.
  function post(payload) {
    try {
      g.parent.postMessage({ bwLegacyHostedBridge: payload }, "*");
      return true;
    } catch (_) {
      return false;
    }
  }
  function sendMessage(message, callback) {
    var id = "h" + Date.now() + "-" + seq++;
    return new Promise(function (resolve) {
      pending[id] = function (value) {
        delete pending[id];
        if (callback) callback(value);
        resolve(value);
      };
      if (!post({ kind: "message", requestId: id, message: message })) {
        pending[id]();
        return;
      }
      setTimeout(function () {
        if (pending[id]) pending[id]();
      }, 10000);
    });
  }
  function connect(info) {
    var id = "hp" + Date.now() + "-" + seq++;
    var p = {
      name: (info && info.name) || "",
      onMessage: new Event(),
      onDisconnect: new Event(),
      postMessage: function (m) {
        post({ kind: "port", portId: id, message: m });
      },
      disconnect: function () {
        post({ kind: "port", portId: id, disconnect: true });
        p.onDisconnect.emit(p);
        delete ports[id];
      },
    };
    ports[id] = p;
    if (!post({ kind: "connect", portId: id, name: p.name })) {
      delete ports[id];
      setTimeout(function () {
        p.onDisconnect.emit(p);
      }, 0);
    }
    return p;
  }
  g.addEventListener(
    "message",
    function (e) {
      if (e.source !== g.parent) return;
      var p = e.data && e.data.bwLegacyHostedBridge;
      if (!p) return;
      if (p.kind === "response" && pending[p.requestId]) pending[p.requestId](p.response);
      else if (p.kind === "port" && ports[p.portId]) {
        if (p.disconnect) {
          ports[p.portId].onDisconnect.emit(ports[p.portId]);
          delete ports[p.portId];
        } else ports[p.portId].onMessage.emit(p.message, ports[p.portId]);
      }
    },
    false,
  );

  // Mirrors the other bridges: legacy Safari baseURIs carry a per-session path token;
  // root-relative paths that already include it resolve against the origin, hardcoded
  // root-relative asset paths resolve against baseURI.
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

  // The page reads translations synchronously as it builds its templates, and it is
  // served from the extension itself, so the catalog is one same-origin synchronous
  // request made the first time a translation is asked for.
  var localeData = null,
    localeLower = null;
  function ensureLocale() {
    if (localeData) return;
    // Only these regional variants ship in _locales; requesting a missing directory
    // logs a console error on the host page, so fall back deliberately.
    var regionals = ["en_GB", "en_IN", "pt_BR", "pt_PT", "zh_CN", "zh_TW"];
    var full = (navigator.language || "en").replace("-", "_"),
      lang = full.split("_")[0],
      candidates = [];
    if (regionals.indexOf(full) >= 0) candidates.push(full);
    if (candidates.indexOf(lang) < 0) candidates.push(lang);
    if (candidates.indexOf("en") < 0) candidates.push("en");
    for (var i = 0; i < candidates.length && !localeData; i++) {
      try {
        var x = new XMLHttpRequest();
        x.open("GET", getURL("_locales/" + candidates[i] + "/messages.json"), false);
        x.send();
        localeData = JSON.parse(x.responseText);
      } catch (_) {
        localeData = null;
      }
    }
    localeData = localeData || {};
    localeLower = {};
    Object.keys(localeData).forEach(function (k) {
      localeLower[k.toLowerCase()] = localeData[k];
    });
  }

  var chrome = {
    __bitwardenSafariLegacyHosted: true,
    runtime: {
      id: "com.bitwarden.safari",
      lastError: null,
      onMessage: new Event(),
      sendMessage: sendMessage,
      connect: connect,
      getManifest: function () {
        return { manifest_version: 2, name: "Bitwarden", version: "2024.11.2-a" };
      },
      getURL: getURL,
    },
    extension: { getURL: getURL },
    i18n: {
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
    },
  };
  g.chrome = chrome;
  g.browser = chrome;
})(this);
