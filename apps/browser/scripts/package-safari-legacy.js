#!/usr/bin/env node
const fs = require("fs");
const path = require("path");
const { inlineBundleSvgCss } = require("./safari-legacy-assets");

const root = path.resolve(__dirname, "..");
const build = path.join(root, "build");
const dist = path.join(root, "dist");
const staging = path.join(dist, "SafariLegacy");
const extension = path.join(staging, "bitwarden.safariextension");
const manifest = JSON.parse(fs.readFileSync(path.join(build, "manifest.json"), "utf8"));

if (!fs.existsSync(path.join(build, "background.html"))) {
  throw new Error("Missing MV2 background.html. Run the safari-legacy build before packaging.");
}
fs.rmSync(staging, { recursive: true, force: true });
fs.mkdirSync(extension, { recursive: true });
fs.cpSync(build, extension, { recursive: true });

// Safari legacy extension pages do not receive a WebExtension API object.
// Insert the extension-page adapter before each generated bundle.

// Pages the content script loads into an iframe on the web page run in the web
// process, where the global page is out of reach, so they get the relay bridge
// instead of the one that talks to the global page directly.
const hostedPages = ["notification/bar.html"];

function injectBridge(directory) {
  fs.readdirSync(directory, { withFileTypes: true }).forEach((entry) => {
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      injectBridge(file);
    } else if (entry.name.endsWith(".html")) {
      const isBackground = entry.name === "background.html";
      const relative = path.relative(extension, file).split(path.sep).join("/");
      const bridge = isBackground
        ? "background.js"
        : hostedPages.includes(relative)
          ? "hosted-page.js"
          : "extension-page.js";
      let html = fs.readFileSync(file, "utf8");
      if (html.includes("safari-legacy/" + bridge)) {
        return; // already injected
      }
      const rel = (name) =>
        path
          .relative(path.dirname(file), path.join(extension, "safari-legacy", name))
          .split(path.sep)
          .join("/");
      // The global page also loads the phishing-detection service (after the bridge
      // installs `chrome`); other extension pages only need the API bridge.
      const scripts = [rel(bridge)]
        .concat(isBackground ? [rel("phishing-detection.js")] : [])
        .map((src) => `<script src="${src}"></script>`)
        .join("");
      html = html.replace("<head>", `<head>${scripts}`);
      fs.writeFileSync(file, html);
    }
  });
}
injectBridge(extension);
inlineBundleSvgCss(extension);

// Keep popouts in the toolbar host: Bitwarden still needs direct globalPage
// access. CSS artwork now has the correct SVG MIME type, so it can stay visible.
const cssFixMarker = "/* safari-legacy ui fixes */";
const cssFix = [
  cssFixMarker,
  // visibility (not display) so the button's box keeps holding its layout slot and
  // neighboring elements (the search field) keep their original inset.
  "app-pop-out{visibility:hidden!important}",
].join("\n");
const popupCss = path.join(extension, "popup", "main.css");
if (fs.existsSync(popupCss) && !fs.readFileSync(popupCss, "utf8").includes(cssFixMarker)) {
  fs.appendFileSync(popupCss, "\n" + cssFix + "\n");
}

const iconSizes = [32, 48, 64, 96, 128];
iconSizes.forEach((size) => {
  const source = path.join(extension, "images", `icon${size}.png`);
  if (fs.existsSync(source)) fs.copyFileSync(source, path.join(extension, `Icon-${size}.png`));
});

function xml(value) {
  return String(value).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
const version = xml(manifest.version);
// Safari compares the bundle version for updates; keep the display version upstream-aligned.
const buildNumber = Math.floor(Date.now() / 1000);
const info = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Author</key><string>Bitwarden Inc. &amp; Wowfunhappy</string>
  <key>Builder Version</key><string>13604.4.7.1.3</string>
  <key>CFBundleDisplayName</key><string>Bitwarden</string>
  <key>CFBundleIdentifier</key><string>com.bitwarden.safari</string>
  <key>CFBundleInfoDictionaryVersion</key><string>6.0</string>
  <key>CFBundleShortVersionString</key><string>${version}</string>
  <key>CFBundleVersion</key><string>${buildNumber}</string>
  <key>Chrome</key>
  <dict>
    <key>Database Quota</key><integer>104857600</integer>
    <key>Global Page</key><string>background.html</string>
    <key>Popovers</key><array><dict>
      <key>Filename</key><string>popup/index.html</string>
      <key>Height</key><integer>600</integer>
      <key>Identifier</key><string>bitwarden-popover</string>
      <key>Width</key><integer>375</integer>
    </dict></array>
    <key>Toolbar Items</key><array><dict>
      <key>Identifier</key><string>bitwarden-toolbar</string>
      <key>Image</key><string>images/icon18_safari.png</string>
      <key>Include By Default</key><true/>
      <key>Label</key><string>Bitwarden</string>
      <key>Palette Label</key><string>Bitwarden</string>
      <key>Popover</key><string>bitwarden-popover</string>
      <key>Tool Tip</key><string>Bitwarden</string>
    </dict></array>
  </dict>
  <key>Content</key><dict>
    <key>Scripts</key><dict><key>Start</key><array>
      <string>safari-legacy/content.js</string>
      <string>content/content-message-handler.js</string>
      <string>content/trigger-autofill-script-injection.js</string>
    </array></dict>
    <key>Stylesheets</key><array><string>content/autofill.css</string></array>
  </dict>
  <key>Description</key><string>A secure and free password manager for all of your devices.</string>
  <key>DeveloperIdentifier</key><string>U5LEPOL722</string>
  <key>Update Manifest URL</key><string>https://mavericksforever.com/safari-extensions-gallery/updates.plist</string>
  <key>ExtensionInfoDictionaryVersion</key><string>1.0</string>
  <key>Permissions</key><dict><key>Website Access</key><dict>
    <key>Include Secure Pages</key><true/>
    <key>Level</key><string>All</string>
  </dict></dict>
  <key>Website</key><string>https://bitwarden.com</string>
</dict>
</plist>
`;
fs.writeFileSync(path.join(extension, "Info.plist"), info);

// The legacy Safari target ships as an uncompressed, unpacked ".safariextension"
// folder so it can be reloaded directly from disk in the browser's extension
// loader without an unzip step.
console.log("Created uncompressed extension bundle:");
console.log("  " + extension);
