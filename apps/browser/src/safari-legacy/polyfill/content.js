/* WebExtension messaging and dynamic-injection bridge for legacy Safari content scripts. */
(function (g) {
  "use strict";
  if (g.chrome && g.chrome.__bitwardenSafariLegacyContent) return;
  var seq = 1, pending = {}, ports = {};
  function Event() { this.listeners = []; }
  Event.prototype.addListener = function (fn) { if (this.listeners.indexOf(fn) < 0) this.listeners.push(fn); };
  Event.prototype.removeListener = function (fn) { var i = this.listeners.indexOf(fn); if (i >= 0) this.listeners.splice(i, 1); };
  Event.prototype.hasListener = function (fn) { return this.listeners.indexOf(fn) >= 0; };
  Event.prototype.emit = function () { var a = arguments; this.listeners.slice().forEach(function (fn) { fn.apply(null, a); }); };
  function sendMessage(message, callback) {
    var id = "c" + Date.now() + "-" + seq++;
    return new Promise(function (resolve) {
      pending[id] = function (value) { delete pending[id]; if (callback) callback(value); resolve(value); };
      safari.self.tab.dispatchMessage("bw.legacy.runtime", { kind: "message", requestId: id, message: message,
        frameId: g === g.top ? 0 : -1, url: location.href });
      setTimeout(function () { if (pending[id]) pending[id](); }, 10000);
    });
  }
  function connect(info) {
    var id = "p" + Date.now() + "-" + seq++;
    var p = { name: info && info.name || "", onMessage: new Event(), onDisconnect: new Event(),
      postMessage: function (m) { safari.self.tab.dispatchMessage("bw.legacy.port", { portId: id, message: m }); },
      disconnect: function () { safari.self.tab.dispatchMessage("bw.legacy.port", { portId: id, disconnect: true }); p.onDisconnect.emit(p); delete ports[id]; } };
    ports[id] = p;
    safari.self.tab.dispatchMessage("bw.legacy.runtime", { kind: "connect", portId: id, name: p.name,
      frameId: g === g.top ? 0 : -1, url: location.href });
    return p;
  }
  function load(url) {
    var x = new XMLHttpRequest(); x.open("GET", url, true);
    x.onload = function () { if (x.status === 0 || x.status < 400) try { (0, eval)(x.responseText + "\n//# sourceURL=" + url); } catch (e) { console.error(e); } };
    x.send();
  }
  var onMessage = new Event();
  var chrome = { __bitwardenSafariLegacyContent: true,
    runtime: { id: "com.bitwarden.safari", lastError: null, onMessage: onMessage, sendMessage: sendMessage, connect: connect,
      getManifest: function () { return { manifest_version: 2, name: "Bitwarden", version: "2024.11.2" }; },
      getURL: function (p) { return safari.extension.baseURI + String(p || "").replace(/^\//, ""); } },
    extension: { getURL: function (p) { return safari.extension.baseURI + String(p || "").replace(/^\//, ""); } } };
  g.chrome = chrome; g.browser = chrome;
  safari.self.addEventListener("message", function (e) {
    var p = e.message || {};
    if (e.name === "bw.legacy.response" && pending[p.requestId]) pending[p.requestId](p.response);
    else if (e.name === "bw.legacy.runtime" && p.kind === "message") {
      var answered = false, waiting = false;
      function reply(value) { if (answered) return; answered = true; safari.self.tab.dispatchMessage("bw.legacy.runtime", { kind: "response", requestId: p.requestId, response: value }); }
      onMessage.listeners.slice().forEach(function (fn) { var v = fn(p.message, {}, reply); if (v === true) waiting = true;
        else if (v && typeof v.then === "function") { waiting = true; v.then(reply, function () { reply(); }); } else if (v !== undefined) reply(v); });
      if (!answered && !waiting) reply();
    } else if (e.name === "bw.legacy.port" && ports[p.portId]) {
      if (p.disconnect) { ports[p.portId].onDisconnect.emit(ports[p.portId]); delete ports[p.portId]; } else ports[p.portId].onMessage.emit(p.message, ports[p.portId]);
    } else if (e.name === "bw.legacy.execute") {
      if (p.frameId != null && p.frameId >= 0 && p.frameId !== (g === g.top ? 0 : -1)) return;
      if (p.file) load(p.baseURI + p.file); else if (p.code) (0, eval)(p.code);
      else if (p.cssFile) { var link = document.createElement("link"); link.rel = "stylesheet"; link.href = p.baseURI + p.cssFile; (document.head || document.documentElement).appendChild(link); }
      else if (p.cssCode) { var style = document.createElement("style"); style.textContent = p.cssCode; (document.head || document.documentElement).appendChild(style); }
    }
  }, false);
})(this);
