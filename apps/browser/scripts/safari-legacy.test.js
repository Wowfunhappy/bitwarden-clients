const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const vm = require("node:vm");
const { spawnSync } = require("node:child_process");
const { test } = require("node:test");
const { inlineSvgCss } = require("./safari-legacy-assets");

function bridge() {
  const base = "safari-extension://com.bitwarden.safari-TEAM123/Session/";
  const assignments = [];
  const window = { tabs: [] };
  function makeTab() {
    const tab = {
      browserWindow: window,
      page: { dispatchMessage() {} },
      activate() {
        window.activeTab = this;
      },
      get url() {
        return this._url || "https://example.com/login";
      },
      set url(value) {
        assignments.push(value);
        this._url = value.replace(
          /^(safari-extension:\/\/)([^/]+)/i,
          (_, scheme, host) => scheme + host.toLowerCase(),
        );
      },
    };
    window.tabs.push(tab);
    return tab;
  }
  window.openTab = makeTab;
  window.activeTab = makeTab();
  const popover = {
    contentWindow: {
      location: {
        replace(url) {
          popover.loaded = url;
        },
      },
    },
  };
  const context = {
    safari: {
      application: {
        browserWindows: [window],
        activeBrowserWindow: window,
        addEventListener() {},
      },
      extension: {
        baseURI: base,
        settings: {},
        secureSettings: {},
        popovers: [popover],
        toolbarItems: [
          {
            showPopover() {
              popover.visible = true;
            },
          },
        ],
      },
    },
    navigator: { language: "en" },
    console,
    setTimeout(fn, delay) {
      if (!delay) return setTimeout(fn, delay);
    },
    clearTimeout,
    setInterval() {},
    clearInterval() {},
  };
  vm.runInNewContext(
    fs.readFileSync(
      path.join(__dirname, "../src/safari-legacy/polyfill/background.js"),
      "utf8",
    ),
    context,
  );
  return { chrome: context.chrome, window, popover, assignments, base };
}

test("tabs.update hosts extension UI in the popover and leaves the website intact", async () => {
  const h = bridge();
  const [old] = await h.chrome.tabs.query({ active: true });
  const url = h.base + "popup/index.html?uilocation=popout#/unlock";
  let count = 0;
  let callbackTab;
  const result = await h.chrome.tabs.update(old.id, { url }, (value) => {
    count++;
    callbackTab = value;
  });
  assert.equal(count, 1);
  assert.equal(callbackTab, result);
  assert.equal(result.url, url);
  assert.equal(h.popover.loaded, url);
  assert.equal(h.popover.visible, true);
  assert.equal(h.window.activeTab.url, old.url);
  assert.equal(h.window.tabs.length, 1);
  assert.deepEqual(h.assignments, []);
});

test("active-tab overload and relative URLs use the same extension host", async () => {
  const h = bridge();
  await h.chrome.tabs.update({
    url: "/popup/index.html#/settings",
    active: true,
  });
  assert.equal(h.popover.loaded, h.base + "popup/index.html#/settings");
  assert.deepEqual(h.assignments, []);
});

test("website updates and existing extension create/window behavior still work", async () => {
  const h = bridge();
  const [old] = await h.chrome.tabs.query({ active: true });
  const result = await h.chrome.tabs.update(old.id, {
    url: "https://example.org/",
  });
  assert.equal(result.id, old.id);
  assert.equal(result.url, "https://example.org/");
  await h.chrome.tabs.create({ url: "/popup/index.html#/vault" });
  assert.equal(h.popover.loaded, h.base + "popup/index.html#/vault");
  await h.chrome.windows.create({
    url: "/popup/index.html?uilocation=popout#/unlock",
  });
  assert.equal(
    h.popover.loaded,
    h.base + "popup/index.html?uilocation=popout#/unlock",
  );
  assert.deepEqual(h.assignments, ["https://example.org/"]);
});

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "bw-safari-assets-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, "css"));
  fs.mkdirSync(path.join(root, "images"));
  const svg =
    '<svg xmlns="http://www.w3.org/2000/svg"><text>é &amp; #</text></svg>';
  fs.writeFileSync(path.join(root, "images/test icon.svg"), svg);
  return { root, svg, css: path.join(root, "css/main.css") };
}

test("CSS SVGs retain their bytes, fragments and themes with an explicit MIME type", (t) => {
  const f = fixture(t);
  const css =
    '.light{content:url(../images/test%20icon.svg?cache=1)}.dark{mask:url("/images/test icon.svg#view")}';
  const result = inlineSvgCss(css, f.css, f.root);
  const data =
    "data:image/svg+xml;base64," + Buffer.from(f.svg).toString("base64");
  assert.equal(
    result,
    `.light{content:url("${data}")}.dark{mask:url("${data}#view")}`,
  );
  assert.equal(inlineSvgCss(result, f.css, f.root), result);
});

test("CSS rewriting leaves comments, strings, web URLs, missing files and escapes alone", (t) => {
  const f = fixture(t);
  const css = `/* url(../images/test%20icon.svg) */ .x{content:"url(../images/test%20icon.svg)";mask:url(#view);background:url(https://example.com/test.svg);content:url(//example.org/test.svg);mask:url(missing.svg);mask:url(icon.png);mask:url(%ZZ.svg)}`;
  assert.equal(inlineSvgCss(css, f.css, f.root), css);
  fs.symlinkSync(__filename, path.join(f.root, "external.svg"));
  assert.equal(
    inlineSvgCss("a{mask:url(/external.svg)}", f.css, f.root),
    "a{mask:url(/external.svg)}",
  );
});

test("Safari packaging repairs CSS images and restores artwork without changing the source build", (t) => {
  const f = fixture(t);
  const scripts = path.join(f.root, "scripts");
  const build = path.join(f.root, "build");
  fs.mkdirSync(scripts);
  fs.mkdirSync(path.join(build, "popup/images"), { recursive: true });
  for (const name of ["package-safari-legacy.js", "safari-legacy-assets.js"]) {
    fs.copyFileSync(path.join(__dirname, name), path.join(scripts, name));
  }
  fs.writeFileSync(
    path.join(build, "manifest.json"),
    JSON.stringify({ version: "1.2.3" }),
  );
  fs.writeFileSync(path.join(build, "background.html"), "<head></head>");
  fs.writeFileSync(path.join(build, "popup/images/logo.svg"), f.svg);
  const css = ".no-items-image{content:url(images/logo.svg)}";
  fs.writeFileSync(path.join(build, "popup/main.css"), css);
  const result = spawnSync(
    process.execPath,
    [path.join(scripts, "package-safari-legacy.js")],
    { encoding: "utf8" },
  );
  assert.equal(result.status, 0, result.stderr);
  const packaged = fs.readFileSync(
    path.join(
      f.root,
      "dist/SafariLegacy/bitwarden.safariextension/popup/main.css",
    ),
    "utf8",
  );
  assert.match(packaged, /data:image\/svg\+xml;base64,/);
  assert.doesNotMatch(packaged, /no-items-image[^}]*display:none/);
  assert.match(packaged, /app-pop-out\{visibility:hidden!important\}/);
  assert.equal(
    fs.readFileSync(path.join(build, "popup/main.css"), "utf8"),
    css,
  );
});
