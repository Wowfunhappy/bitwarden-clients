/* WebExtension API bridge for Safari's legacy .safariextension runtime. */
(function (g) {
  "use strict";
  if (g.chrome && g.chrome.__bitwardenSafariLegacy) return;
  var app = safari.application, ext = safari.extension, base = ext.baseURI;
  var sequence = 1, refs = [], ids = [], responses = {}, ports = {}, menus = {}, alarms = {};
  var session = {}, manifest = read("_locales/en/messages.json") && read("manifest.json");
  manifest = manifest || { manifest_version: 2, name: "Bitwarden", version: "2024.11.2" };

  function read(path) {
    try {
      var x = new XMLHttpRequest(); x.open("GET", base + path, false); x.send();
      return JSON.parse(x.responseText);
    } catch (_) { return null; }
  }
  function done(cb, value) {
    if (typeof cb === "function") setTimeout(function () { cb(value); }, 0);
    return Promise.resolve(value);
  }
  function Event() { this.listeners = []; }
  Event.prototype.addListener = function (fn) { if (this.listeners.indexOf(fn) < 0) this.listeners.push(fn); };
  Event.prototype.removeListener = function (fn) { var i = this.listeners.indexOf(fn); if (i >= 0) this.listeners.splice(i, 1); };
  Event.prototype.hasListener = function (fn) { return this.listeners.indexOf(fn) >= 0; };
  Event.prototype.hasListeners = function () { return this.listeners.length > 0; };
  Event.prototype.emit = function () {
    var a = arguments;
    this.listeners.slice().forEach(function (fn) { try { fn.apply(null, a); } catch (e) { console.error(e); } });
  };
  function tabId(tab) {
    var i = refs.indexOf(tab); if (i < 0) { i = refs.push(tab) - 1; ids[i] = sequence++; }
    return ids[i];
  }
  function nativeTabs() {
    var out = []; app.browserWindows.forEach(function (w) { w.tabs.forEach(function (t) { tabId(t); out.push(t); }); });
    return out;
  }
  function findTab(id) { nativeTabs(); var i = ids.indexOf(Number(id)); return i < 0 ? null : refs[i]; }
  function winId(w) { return app.browserWindows.indexOf(w) + 1; }
  function tab(t) {
    if (!t) return null; var w = t.browserWindow;
    return { id: tabId(t), index: w ? w.tabs.indexOf(t) : 0, windowId: w ? winId(w) : -1,
      active: !!w && w.activeTab === t, selected: !!w && w.activeTab === t, highlighted: !!w && w.activeTab === t,
      pinned: false, incognito: !!t.private, title: t.title || "", url: t.url || "", status: "complete" };
  }
  function win(w, populate) {
    if (!w) return null;
    return { id: winId(w), focused: w === app.activeBrowserWindow, incognito: !!(w.activeTab && w.activeTab.private),
      type: "normal", state: "normal", alwaysOnTop: false, tabs: populate ? w.tabs.map(tab) : undefined };
  }
  function active() { return app.activeBrowserWindow && app.activeBrowserWindow.activeTab; }
  // Legacy Safari baseURIs place a random per-session token in the path:
  // "safari-extension://<bundle-id>/<token>/". Paths the app derives from
  // location.pathname already contain the token, while hardcoded root-relative
  // paths ("/images/icon19.png") do not — resolve the former against the origin
  // and the latter against baseURI, or the token gets doubled/omitted and Safari
  // fails with "there is no such file".
  var origin = base.replace(/^([a-z][a-z0-9+.\-]*:\/\/[^\/]*)\/.*$/i, "$1");
  var basePath = base.slice(origin.length);
  function extUrl(p) {
    p = String(p == null ? "" : p);
    if (p === "" || /^[a-z][a-z0-9+.\-]*:/i.test(p)) return p;
    if (p.charAt(0) === "/") {
      if ((p + "/").indexOf(basePath) === 0) return origin + p;
      return base + p.replace(/^\/+/, "");
    }
    return base + p;
  }
  function resolveUrl(u) {
    // Chrome resolves relative/root-relative extension URLs (e.g. the popout's
    // "/popup/index.html?uilocation=popout#/tabs/vault") against the extension
    // base; Safari tabs need an absolute URL.
    return u == null || u === "" ? u : extUrl(u);
  }
  function urlMatches(url, pattern) {
    return (Array.isArray(pattern) ? pattern : [pattern]).some(function (p) {
      var rx = new RegExp("^" + String(p).replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*") + "$");
      return rx.test(url);
    });
  }
  // Chrome badges are per-tab (and auto-clear on navigation); Safari has one badge
  // per toolbar item. Track per-tab values and surface the active tab's badge.
  var tabBadges = {}, globalBadge = "";
  // Synthetic window ids for popouts hosted in the toolbar popover, keyed by id to
  // { url }. The popover is a persistent, single instance, so only one is live.
  var popoutSequence = 9001, popoverPopouts = {};
  var POPUP_DEFAULT_URL = base + "popup/index.html", POPUP_W = 375, POPUP_H = 600;
  function popoverEl() { return (ext.popovers || [])[0]; }
  function popoverGo(u) {
    var po = popoverEl(); if (!po) return;
    po.contentURL = u;
    // The popover keeps its document between opens, so a contentURL change alone may
    // not navigate the already-loaded page; drive its live location too.
    try { if (po.contentWindow && po.contentWindow.location) po.contentWindow.location.replace(u); } catch (_) {}
  }
  function restorePopover() {
    var po = popoverEl(); if (!po) return;
    try { po.width = POPUP_W; po.height = POPUP_H; } catch (_) {}
    popoverGo(POPUP_DEFAULT_URL);
  }
  function refreshBadge() {
    var t = active(), id = t ? tabId(t) : null;
    var text = id != null && tabBadges[id] != null ? tabBadges[id] : globalBadge;
    var n = text ? parseInt(text, 10) || 1 : 0;
    (ext.toolbarItems || []).forEach(function (i) { i.badge = n; });
  }
  function send(t, name, data) { if (t && t.page) { t.page.dispatchMessage(name, data); return true; } return false; }
  function dispatch(message, sender, reply) {
    var answered = false, waiting = false;
    function respond(value) { if (!answered) { answered = true; reply(value); } }
    chrome.runtime.onMessage.listeners.slice().forEach(function (fn) {
      try {
        var value = fn(message, sender || {}, respond);
        // Chrome semantics: the response is delivered ONLY through sendResponse.
        // Returning `true` keeps the channel open for an async sendResponse; a
        // returned Promise resolves as the response (webextension-polyfill style).
        // Any other return value (notably `false`/`null`, which listeners such as
        // RuntimeBackground return to mean "not handling this") is IGNORED — using
        // it as the response would clobber another listener's real sendResponse.
        if (value === true) waiting = true;
        else if (value && typeof value.then === "function") { waiting = true; value.then(respond, function () { respond(); }); }
      } catch (e) { chrome.runtime.lastError = { message: String(e) }; console.error(e); }
    });
    if (!answered && !waiting) respond();
  }
  function makePort(name, sender, post, close) {
    var p = { name: name || "", sender: sender, onMessage: new Event(), onDisconnect: new Event(),
      postMessage: post, disconnect: function () { close(); p.onDisconnect.emit(p); } };
    return p;
  }
  function localPort(name) {
    // Emulates chrome.runtime.connect() within one page. Listener callbacks must receive
    // the port the listener was attached to (Chrome's Port event semantics), NOT the peer:
    // BackgroundMemoryStorageService replies via its listener's port argument, so handing
    // it the peer would route responses back to their sender and hang every state write.
    var front, back;
    front = makePort(name, undefined, function (m) { setTimeout(function () { back.onMessage.emit(m, back); }, 0); },
      function () { back.onDisconnect.emit(back); });
    back = makePort(name, {}, function (m) { setTimeout(function () { front.onMessage.emit(m, front); }, 0); },
      function () { front.onDisconnect.emit(front); });
    setTimeout(function () { chrome.runtime.onConnect.emit(back); }, 0); return front;
  }
  function storageArea(settings, area) {
    function keys(q) {
      if (q == null) { var a = []; for (var i = 0; i < settings.length; i++) a.push(settings.key(i)); return a; }
      return Array.isArray(q) ? q : typeof q === "string" ? [q] : Object.keys(q);
    }
    function value(k) { var v = settings.getItem(k); if (v == null) return undefined; try { return JSON.parse(v); } catch (_) { return v; } }
    // Changes must fire on BOTH the StorageArea's own onChanged (chrome.storage.local.onChanged,
    // which AbstractChromeStorageService subscribes to for its updates$) and the aggregate
    // chrome.storage.onChanged. A "save" change carries newValue; a "remove" change must not.
    function emitChanges(changes) { self.onChanged.emit(changes); chrome.storage.onChanged.emit(changes, area); }
    var self = {
      QUOTA_BYTES: 104857600, onChanged: new Event(),
      get: function (q, cb) { var r = {}; keys(q).forEach(function (k) {
        var v = value(k); if (v !== undefined) r[k] = v; else if (q && typeof q === "object" && !Array.isArray(q)) r[k] = q[k];
      }); return done(cb, r); },
      set: function (o, cb) { var changes = {}; Object.keys(o || {}).forEach(function (k) {
        changes[k] = { oldValue: value(k), newValue: o[k] }; settings.setItem(k, JSON.stringify(o[k]));
      }); emitChanges(changes); return done(cb); },
      remove: function (q, cb) { var changes = {}; (Array.isArray(q) ? q : [q]).forEach(function (k) {
        changes[k] = { oldValue: value(k) }; settings.removeItem(k);
      }); emitChanges(changes); return done(cb); },
      clear: function (cb) { var changes = {}; keys(null).forEach(function (k) { changes[k] = { oldValue: value(k) }; settings.removeItem(k); }); emitChanges(changes); return done(cb); },
      getBytesInUse: function (_, cb) { var n = 0; keys(null).forEach(function (k) { n += String(settings.getItem(k) || "").length * 2; }); return done(cb, n); }
    };
    return self;
  }
  function memoryArea() {
    var self = { onChanged: new Event(),
      get: function (q, cb) { var r = {}, ks = q == null ? Object.keys(session) : Array.isArray(q) ? q : typeof q === "string" ? [q] : Object.keys(q);
        ks.forEach(function (k) { if (k in session) r[k] = session[k]; }); return done(cb, r); },
      set: function (o, cb) { var changes = {}; Object.keys(o || {}).forEach(function (k) { changes[k] = { oldValue: session[k], newValue: o[k] }; session[k] = o[k]; });
        self.onChanged.emit(changes); chrome.storage.onChanged.emit(changes, "session"); return done(cb); },
      remove: function (q, cb) { var changes = {}; (Array.isArray(q) ? q : [q]).forEach(function (k) { changes[k] = { oldValue: session[k] }; delete session[k]; });
        self.onChanged.emit(changes); chrome.storage.onChanged.emit(changes, "session"); return done(cb); },
      clear: function (cb) { session = {}; return done(cb); }, setAccessLevel: function () { return Promise.resolve(); } };
    return self;
  }
  // Pick the message catalog without requesting directories that don't exist (a
  // failed load logs a console error on every page): only these regional variants
  // ship in _locales; anything else falls back to the bare language, then English.
  var REGIONAL_LOCALES = ["en_GB", "en_IN", "pt_BR", "pt_PT", "zh_CN", "zh_TW"];
  function localeCandidates() {
    var full = (navigator.language || "en").replace("-", "_"), lang = full.split("_")[0], out = [];
    if (REGIONAL_LOCALES.indexOf(full) >= 0) out.push(full);
    if (out.indexOf(lang) < 0) out.push(lang);
    if (out.indexOf("en") < 0) out.push("en");
    return out;
  }
  var locale = null;
  localeCandidates().some(function (l) { locale = read("_locales/" + l + "/messages.json"); return !!locale; });
  locale = locale || {};
  // Chrome's i18n message lookup is case-insensitive (templates say "autofill",
  // messages.json says "autoFill"), so keep a lowercased index alongside.
  var lcLocale = {};
  Object.keys(locale).forEach(function (k) { lcLocale[k.toLowerCase()] = locale[k]; });
  var onMessage = new Event(), onConnect = new Event(), onActivated = new Event(), onUpdated = new Event();
  var onCommitted = new Event(), onCompleted = new Event();
  var chrome = {
    __bitwardenSafariLegacy: true,
    runtime: { id: "com.bitwarden.safari", lastError: null, onMessage: onMessage, onConnect: onConnect,
      onInstalled: new Event(), onStartup: new Event(), onSuspend: new Event(),
      getManifest: function () { return manifest; }, getURL: function (p) { return p == null || p === "" ? base : extUrl(p); },
      getPlatformInfo: function (cb) { return done(cb, { os: "mac", arch: "x86-64", nacl_arch: "x86-64" }); },
      sendMessage: function (m, cb) { return new Promise(function (resolve) { dispatch(m, {}, function (r) { if (cb) cb(r); resolve(r); }); }); },
      connect: function (info) { return localPort(info && info.name); },
      connectNative: function () { return makePort("", {}, function () {}, function () {}); },
      sendNativeMessage: function (_, __, cb) { return done(cb, null); },
      reload: function () { location.reload(); },
      openOptionsPage: function (cb) { return chrome.tabs.create({ url: base + "popup/index.html#/settings" }, cb); } },
    extension: { getURL: function (p) { return p == null || p === "" ? base : extUrl(p); },
      getBackgroundPage: function () { return g; },
      getViews: function (p) { var v = []; (ext.popovers || []).forEach(function (x) { if (x.contentWindow) v.push(x.contentWindow); }); return p && p.type === "popup" ? v : [g].concat(v); } },
    storage: { onChanged: new Event(), local: null, sync: null, session: memoryArea(),
      managed: { get: function (_, cb) { return done(cb, {}); } } },
    tabs: { onActivated: onActivated, onUpdated: onUpdated, onRemoved: new Event(), onReplaced: new Event(),
      query: function (q, cb) { q = q || {}; var a = nativeTabs().filter(function (t) {
        return !(q.active && t.browserWindow.activeTab !== t) && !(q.currentWindow && t.browserWindow !== app.activeBrowserWindow) &&
          !(q.windowId > 0 && winId(t.browserWindow) !== q.windowId) && !(q.url && !urlMatches(t.url || "", q.url));
      }).map(tab);
      // Only when a url filter is given (the popout-finding queries always pass one):
      // surface popover-hosted popouts as synthetic tabs so the app can locate and
      // close them (closeSingleActionPopout, isSingleActionPopoutOpen). windowId maps
      // to the popout id so removeWindow(windowId) routes to windows.remove.
      if (q.url) { Object.keys(popoverPopouts).forEach(function (pid) {
        var pu = popoverPopouts[pid].url;
        if (!urlMatches(pu, q.url) || (q.windowId > 0 && q.windowId !== Number(pid))) return;
        a.push({ id: 900000 + Number(pid), index: 0, windowId: Number(pid), active: true, selected: true, highlighted: true,
          pinned: false, incognito: false, title: "Bitwarden", url: pu, status: "complete" });
      }); }
      return done(cb, a); },
      get: function (id, cb) { return done(cb, tab(findTab(id))); },
      create: function (p, cb) {
        var u = resolveUrl(p && p.url) || "about:blank";
        if (u.indexOf(origin) === 0) {
          // Extension pages cannot run in tabs (no globalPage access there); host
          // them in the toolbar popover via the windows.create path.
          return chrome.windows.create({ url: u }).then(function (w) {
            var t = { id: popoutSequence++, index: 0, windowId: w ? w.id : -1, active: true, selected: true,
              highlighted: true, pinned: false, incognito: false, title: "Bitwarden", url: u, status: "complete" };
            if (cb) cb(t); return t;
          });
        }
        var w2 = app.activeBrowserWindow || app.openBrowserWindow(), t2 = w2.openTab(); t2.url = u; if (p.active !== false) t2.activate(); return done(cb, tab(t2));
      },
      update: function (id, p, cb) { if (typeof id === "object") { cb = p; p = id; id = tabId(active()); } var t = findTab(id); if (t) { if (p.url) t.url = resolveUrl(p.url); if (p.active || p.highlighted) t.activate(); } return done(cb, tab(t)); },
      remove: function (q, cb) { (Array.isArray(q) ? q : [q]).forEach(function (id) { var t = findTab(id); if (t) t.close(); }); return done(cb); },
      reload: function (id, _, cb) { var t = findTab(typeof id === "number" ? id : tabId(active())); if (t) t.url = t.url; return done(cb); },
      sendMessage: function (id, m, opts, cb) { if (typeof opts === "function") { cb = opts; opts = {}; } var rid = "r" + sequence++;
        return new Promise(function (resolve) { responses[rid] = function (r) { delete responses[rid]; if (cb) cb(r); resolve(r); };
          if (!send(findTab(id), "bw.legacy.runtime", { kind: "message", requestId: rid, message: m, frameId: opts && opts.frameId })) responses[rid]();
          setTimeout(function () { if (responses[rid]) responses[rid](); }, 5000); }); },
      executeScript: function (id, d, cb) { send(findTab(id), "bw.legacy.execute", { file: d.file, code: d.code, frameId: d.frameId, baseURI: base }); return done(cb, []); },
      insertCSS: function (id, d, cb) { send(findTab(id), "bw.legacy.execute", { cssFile: d.file, cssCode: d.code, frameId: d.frameId, baseURI: base }); return done(cb); },
      captureVisibleTab: function (_, __, cb) { return done(cb, null); } },
    windows: { WINDOW_ID_CURRENT: -2, WINDOW_ID_NONE: -1, onCreated: new Event(), onRemoved: new Event(), onFocusChanged: new Event(),
      getCurrent: function (o, cb) { if (typeof o === "function") { cb = o; o = {}; } return done(cb, win(app.activeBrowserWindow, o && o.populate)); },
      get: function (id, o, cb) { if (typeof o === "function") { cb = o; o = {}; } return done(cb, win(app.browserWindows[id - 1], o && o.populate)); },
      getAll: function (o, cb) { return done(cb, app.browserWindows.map(function (w) { return win(w, o && o.populate); })); },
      create: function (d, cb) {
        var u = d && d.url ? resolveUrl(Array.isArray(d.url) ? d.url[0] : d.url) : null;
        // Extension pages cannot run in browser tabs: tab content lives in the web
        // process, which has no access to safari.extension.globalPage, and the app
        // requires direct background-window access (getBgService). Host "popout"
        // windows (unlock prompts, SSO results, passkey confirmations) in the
        // toolbar popover instead — the one context where the full app runs.
        if (u && u.indexOf(origin) === 0) {
          var po = popoverEl(), item = (ext.toolbarItems || [])[0];
          if (po) {
            var id = popoutSequence++;
            // Register BEFORE showing so the 'popover' event handler recognizes this
            // as a live popout and does not reset it back to the normal popup. Only
            // uilocation=popout URLs are single-action sessions windows.remove closes.
            if (u.indexOf("uilocation=popout") >= 0) popoverPopouts[id] = { url: u };
            if (d.width) { try { po.width = d.width; } catch (_) {} }
            if (d.height) { try { po.height = d.height; } catch (_) {} }
            popoverGo(u);
            if (item && item.showPopover) item.showPopover();
            return done(cb, { id: id, focused: true, type: "popup", state: "normal", alwaysOnTop: false, incognito: false });
          }
        }
        var w = app.openBrowserWindow(); if (u) w.activeTab.url = u; return done(cb, win(w, true));
      },
      update: function (id, d, cb) { if (popoverPopouts[id]) return done(cb, null); var w = app.browserWindows[id - 1]; if (w && d.focused) w.activeTab.activate(); return done(cb, win(w, true)); },
      remove: function (id, cb) {
        if (popoverPopouts[id]) {
          delete popoverPopouts[id];
          var po = popoverEl();
          if (po) { try { po.hide(); } catch (_) {} }
          restorePopover();
          chrome.windows.onRemoved.emit(id);
          return done(cb);
        }
        var w = app.browserWindows[id - 1]; if (w) w.close(); return done(cb);
      } },
    i18n: { getUILanguage: function () { return navigator.language || "en"; },
      // Chrome semantics: name lookup is case-insensitive; messages may contain
      // named $PLACEHOLDER$ references whose "content" maps $1..$9 to substitutions.
      getMessage: function (n, s) {
        var e = locale[n] || lcLocale[String(n || "").toLowerCase()];
        if (!e) return "";
        var subs = s == null ? [] : Array.isArray(s) ? s : [s];
        function fill(str) { return String(str == null ? "" : str).replace(/\$(\d)/g, function (_, d) {
          var v = subs[Number(d) - 1]; return v == null ? "" : String(v); }); }
        var v = String(e.message || "").replace(/\$([A-Za-z0-9_@]+)\$/g, function (whole, name) {
          var ph = e.placeholders && e.placeholders[name], lc = name.toLowerCase();
          if (!ph && e.placeholders) { for (var k in e.placeholders) { if (k.toLowerCase() === lc) { ph = e.placeholders[k]; break; } } }
          return ph ? fill(ph.content) : whole;
        });
        return fill(v).replace(/\$\$/g, "$");
      },
      getAcceptLanguages: function (cb) { return done(cb, [navigator.language || "en"]); } },
    browserAction: { onClicked: new Event(),
      setIcon: function (d, cb) {
        // The official legacy extension (v1.41.0) never swapped the toolbar image: the 18px
        // monochrome template from Info.plist is the only graphic that renders correctly in
        // a legacy Safari toolbar, so locked/gray requests keep the same shield. Pin it in
        // case anything else reassigned the image.
        (ext.toolbarItems || []).forEach(function (i) { try { i.image = base + "images/icon18_safari.png"; } catch (_) {} });
        return done(cb);
      },
      setBadgeText: function (d, cb) {
        var text = (d && d.text) || "";
        if (d && d.tabId != null) { if (text) tabBadges[d.tabId] = text; else delete tabBadges[d.tabId]; }
        else globalBadge = text;
        refreshBadge(); return done(cb);
      },
      setBadgeBackgroundColor: function (_, cb) { return done(cb); }, setTitle: function (d, cb) { (ext.toolbarItems || []).forEach(function (i) { i.toolTip = d.title; }); return done(cb); },
      enable: function (_, cb) { (ext.toolbarItems || []).forEach(function (i) { i.disabled = false; }); return done(cb); },
      disable: function (_, cb) { (ext.toolbarItems || []).forEach(function (i) { i.disabled = true; }); return done(cb); },
      openPopup: function (cb) { var i = (ext.toolbarItems || [])[0]; if (i && i.showPopover) i.showPopover(); return done(cb); } },
    contextMenus: { onClicked: new Event(), create: function (p, cb) { var id = p.id != null ? p.id : String(sequence++); menus[id] = p; if (cb) cb(); return id; },
      update: function (id, p, cb) { if (menus[id]) Object.assign(menus[id], p); return done(cb); }, remove: function (id, cb) { delete menus[id]; return done(cb); },
      removeAll: function (cb) { menus = {}; return done(cb); } },
    commands: { onCommand: new Event(), getAll: function (cb) { return done(cb, []); } },
    alarms: { onAlarm: new Event(),
      create: function (n, d) { chrome.alarms.clear(n); var wait = d.when ? Math.max(0, d.when - Date.now()) : (d.delayInMinutes || 0) * 60000;
        var fire = function () { chrome.alarms.onAlarm.emit({ name: n, scheduledTime: Date.now() }); if (d.periodInMinutes) alarms[n].timer = setTimeout(fire, d.periodInMinutes * 60000); else delete alarms[n]; };
        alarms[n] = { name: n, scheduledTime: Date.now() + wait, periodInMinutes: d.periodInMinutes, timer: setTimeout(fire, wait) }; return Promise.resolve(); },
      get: function (n, cb) { return done(cb, alarms[n]); }, getAll: function (cb) { return done(cb, Object.keys(alarms).map(function (n) { return alarms[n]; })); },
      clear: function (n, cb) { var yes = !!alarms[n]; if (yes) clearTimeout(alarms[n].timer); delete alarms[n]; return done(cb, yes); },
      clearAll: function (cb) { Object.keys(alarms).forEach(function (n) { chrome.alarms.clear(n); }); return done(cb, true); } },
    idle: { onStateChanged: new Event(), setDetectionInterval: function () {}, queryState: function (_, cb) { return done(cb, "active"); } },
    webNavigation: { onCommitted: onCommitted, onCompleted: onCompleted, onBeforeNavigate: new Event(), onDOMContentLoaded: new Event(), onErrorOccurred: new Event(),
      getFrame: function (d, cb) { var t = findTab(d.tabId); return done(cb, t ? { tabId: d.tabId, frameId: d.frameId || 0, parentFrameId: -1, url: t.url } : null); },
      getAllFrames: function (d, cb) { var t = findTab(d.tabId); return done(cb, t ? [{ tabId: d.tabId, frameId: 0, parentFrameId: -1, url: t.url }] : []); } },
    webRequest: { onBeforeRequest: new Event(), onBeforeRedirect: new Event(), onCompleted: new Event(), onErrorOccurred: new Event(), onAuthRequired: new Event() },
    permissions: { onAdded: new Event(), onRemoved: new Event(), contains: function (_, cb) { return done(cb, true); }, request: function (_, cb) { return done(cb, true); },
      remove: function (_, cb) { return done(cb, false); }, getAll: function (cb) { return done(cb, { permissions: [], origins: ["<all_urls>"] }); } },
    privacy: { services: {} }, offscreen: { createDocument: function () { return Promise.resolve(); }, closeDocument: function () { return Promise.resolve(); }, hasDocument: function () { return Promise.resolve(false); } }
  };
  chrome.action = chrome.browserAction;
  chrome.scripting = { executeScript: function (d, cb) {
      // Callers (e.g. the registerContentScriptsMv2 polyfill injecting the FIDO2
      // page-script appender plus its content script) pass several files that must
      // all run, in order.
      var target = (d && d.target) || {};
      var frameId = target.frameIds && target.frameIds.length ? target.frameIds[0] : undefined;
      var files = ((d && d.files) || []).map(function (f) { return typeof f === "string" ? f : f && f.file; }).filter(Boolean);
      var chain = Promise.resolve();
      files.forEach(function (f) {
        chain = chain.then(function () { return chrome.tabs.executeScript(target.tabId, { file: f, frameId: frameId }); });
      });
      return chain.then(function () { var r = [{ frameId: frameId || 0, result: null }]; if (cb) cb(r); return r; });
    },
    insertCSS: function (d, cb) { return chrome.tabs.insertCSS(d.target.tabId, { file: d.files && d.files[0], code: d.css }, cb); },
    registerContentScripts: function () { return Promise.resolve(); }, unregisterContentScripts: function () { return Promise.resolve(); }, getRegisteredContentScripts: function () { return Promise.resolve([]); } };
  ["autofillAddressEnabled", "autofillCreditCardEnabled", "passwordSavingEnabled"].forEach(function (n) { chrome.privacy.services[n] = {
    get: function (_, cb) { return done(cb, { value: true, levelOfControl: "not_controllable" }); }, set: function (_, cb) { return done(cb); } }; });
  chrome.storage.local = storageArea(ext.secureSettings || ext.settings, "local"); chrome.storage.sync = chrome.storage.local;

  app.addEventListener("message", function (e) {
    var p = e.message || {};
    if (e.name === "bw.legacy.runtime") {
      if (p.kind === "message") dispatch(p.message, { tab: tab(e.target), frameId: p.frameId || 0, url: p.url }, function (r) { send(e.target, "bw.legacy.response", { requestId: p.requestId, response: r }); });
      else if (p.kind === "response" && responses[p.requestId]) responses[p.requestId](p.response);
      else if (p.kind === "connect") { var port = makePort(p.name, { tab: tab(e.target), frameId: p.frameId || 0, url: p.url },
        function (m) { send(e.target, "bw.legacy.port", { portId: p.portId, message: m }); },
        function () { send(e.target, "bw.legacy.port", { portId: p.portId, disconnect: true }); delete ports[p.portId]; }); ports[p.portId] = port; onConnect.emit(port); }
    } else if (e.name === "bw.legacy.port" && ports[p.portId]) { if (p.disconnect) { ports[p.portId].onDisconnect.emit(ports[p.portId]); delete ports[p.portId]; } else ports[p.portId].onMessage.emit(p.message, ports[p.portId]); }
    else if (e.name === "bw.legacy.tab" && e.target && e.target.browserWindow) {
      // Tab-state reports from the content bridge (see content.js). This is the one
      // signal channel proven reliable in the hosting browser — uBlock's legacy port
      // tracks tabs the same way.
      if (p.kind === "focus") { emitActivation(e.target); emitNavigation(e.target, e.target.url || p.url || "", false); }
      else emitNavigation(e.target, p.url || e.target.url || "", true);
    }
  }, false);
  // Tab-state tracking. All sources — Safari's application events, content-script
  // reports, and the poller — funnel through these two emitters, whose per-tab
  // snapshots make duplicate deliveries harmless.
  var lastActiveTabId = null, lastWindowId = null, tabUrls = {};
  function emitActivation(t) {
    if (!t || !t.browserWindow) return;
    var id = tabId(t), wid = winId(t.browserWindow);
    if (wid !== lastWindowId) { lastWindowId = wid; chrome.windows.onFocusChanged.emit(wid); }
    if (id === lastActiveTabId) return;
    lastActiveTabId = id;
    onActivated.emit({ tabId: id, windowId: wid });
    refreshBadge();
  }
  function emitNavigation(t, url, force) {
    // force=true marks a real navigation signal (Safari navigate event, content
    // script load/nav report): emit even for a same-URL reload unless an identical
    // report arrived moments ago (double delivery of one navigation). Unforced
    // sources (poller, focus reports) emit only when the URL actually changed.
    if (!t) return;
    var id = tabId(t);
    url = url || t.url || "";
    if (!url) return;
    var prev = tabUrls[id], now = Date.now();
    if (prev && prev.url === url && (!force || now - prev.time < 1500)) return;
    tabUrls[id] = { url: url, time: now };
    var tb = tab(t), d = { tabId: id, frameId: 0, parentFrameId: -1, url: url, timeStamp: now };
    delete tabBadges[id]; refreshBadge();
    onUpdated.emit(id, { status: "loading", url: url }, tb); onCommitted.emit(d);
    setTimeout(function () { onUpdated.emit(id, { status: "complete" }, tab(t)); onCompleted.emit(d); }, 0);
  }
  function checkActiveTab() {
    var t = active(); if (!t) return;
    emitActivation(t);
    emitNavigation(t, t.url || "", false);
  }
  // Application-level events must be registered with useCapture — activate and
  // deactivate are dispatched as non-bubbling, so bubble-phase listeners on the
  // application never see them (verified by probing; navigate/beforeNavigate/popover
  // deliver in both phases). uBlock's legacy port registers the same way.
  function onAppEvent(name, fn) {
    app.addEventListener(name, fn, true);
  }
  onAppEvent("activate", function (e) {
    if (e.target && e.target.browserWindow) emitActivation(e.target);
    refreshBadge();
  });
  onAppEvent("navigate", function (e) { if (e.target && e.target.browserWindow) emitNavigation(e.target, e.target.url || "", true); });
  // A dismissed popover (focus loss or the user clicking away) fires no application
  // event, but a single-action popout waiting inside it — e.g. a fido2 assertion
  // prompting to unlock a locked vault — must not hang the requesting page. Watch
  // the popover's visibility and, when it disappears while a popout is live, emulate
  // the window closing so the flow aborts cleanly (the site gets a rejection, not a
  // spinner forever). Normal completion clears popoverPopouts first (windows.remove),
  // so this only fires on genuine dismissal.
  var popoverWasVisible = false;
  function checkPopoverDismissed() {
    var po = popoverEl(), visible = !!(po && po.visible);
    if (popoverWasVisible && !visible) {
      var ids = Object.keys(popoverPopouts);
      if (ids.length) {
        ids.forEach(function (id) { delete popoverPopouts[id]; chrome.windows.onRemoved.emit(Number(id)); });
        restorePopover();
      }
    }
    popoverWasVisible = visible;
  }
  // Backstop poller (global-page timers verified to run at full rate in this host).
  // It covers what neither application events nor content-script reports see:
  // pages without content scripts (Top Sites, blank tabs) and SPA pushState
  // navigations. All sources dedupe through the emitters above.
  setInterval(function () { checkActiveTab(); checkPopoverDismissed(); }, 1000);
  // Legacy popovers persist between opens, but the popup app assumes Chrome's popup
  // lifecycle — a fresh page on every open that inspects the active tab at boot —
  // so a re-shown popover keeps showing whatever tab it booted against. Reload it
  // when it opens somewhere else (uBlock's port reloads on every 'popover' event
  // for the same reason; the boot key lets same-tab reopens stay instant). The
  // extension-page bridge records __bwBootTabKey when the popup boots.
  onAppEvent("popover", function (e) {
    var po = (e.target && e.target.contentWindow ? e.target : null) || popoverEl();
    if (!po || !po.contentWindow) return;
    if (String(po.contentURL || "").indexOf("uilocation=popout") >= 0) {
      // A live single-action popout owns the popover; a stale one (its session was
      // never closed via windows.remove) is swapped back for the normal popup.
      if (Object.keys(popoverPopouts).length) return;
      restorePopover();
      return;
    }
    var t = active(), key = t ? tabId(t) + "|" + (t.url || "") : null;
    var bootKey = null;
    try { bootKey = po.contentWindow.__bwBootTabKey; } catch (_) {}
    if (key && bootKey && key !== bootKey) {
      try { po.contentWindow.location.reload(); } catch (_) {}
    }
  });
  // Context menu support is intentionally omitted: legacy Safari menus are flat (no
  // submenus), which cannot express the extension's nested menu tree. The
  // chrome.contextMenus API stays as an inert stub and no "contextmenu" listener is
  // registered, so Safari's menu never gains Bitwarden entries. The corresponding
  // settings toggle is hidden by the extension-page bridge.
  app.addEventListener("command", function (e) { chrome.commands.onCommand.emit(e.command); }, false);
  g.chrome = chrome; g.browser = chrome; g.__bwLegacyChrome = chrome;
  setTimeout(function () { var k = "__bw_legacy_installed_version", old = ext.settings.getItem(k), reason = old ? old === manifest.version ? null : "update" : "install";
    ext.settings.setItem(k, manifest.version); if (reason) chrome.runtime.onInstalled.emit({ reason: reason, previousVersion: old || undefined }); chrome.runtime.onStartup.emit(); }, 500);
})(this);
