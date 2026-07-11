#!/usr/bin/env node
const fs = require("fs");
const path = require("path");

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
function injectBridge(directory) {
  fs.readdirSync(directory, { withFileTypes: true }).forEach((entry) => {
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      injectBridge(file);
    } else if (entry.name.endsWith(".html")) {
      const bridge = entry.name === "background.html" ? "background.js" : "extension-page.js";
      const relative = path.relative(path.dirname(file), path.join(extension, "safari-legacy", bridge)).split(path.sep).join("/");
      let html = fs.readFileSync(file, "utf8");
      if (!html.includes("safari-legacy/extension-page.js")) {
        html = html.replace("<head>", `<head><script src="${relative}"></script>`);
        fs.writeFileSync(file, html);
      }
    }
  });
}
injectBridge(extension);

// Legacy-runtime UI fixes. The extension-page bridge assigns real img srcs for the
// illustrations that the stock CSS supplies via content:url() (unsupported on <img>
// in WebKit); neutralize those rules so they cannot fight the srcs. The popout
// button is hidden because legacy Safari cannot load extension pages in tabs.
const cssFixMarker = "/* safari-legacy ui fixes */";
const cssFix = [
  cssFixMarker,
  ".no-items .no-items-image,.full-loading-spinner .no-items-image,.mfaType0{content:none!important}",
  "app-pop-out{display:none!important}",
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
const info = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Author</key><string>Bitwarden Inc.</string>
  <key>Builder Version</key><string>13604.4.7.1.3</string>
  <key>CFBundleDisplayName</key><string>Bitwarden</string>
  <key>CFBundleIdentifier</key><string>com.bitwarden.safari</string>
  <key>CFBundleInfoDictionaryVersion</key><string>6.0</string>
  <key>CFBundleShortVersionString</key><string>${version}</string>
  <key>CFBundleVersion</key><string>${version}</string>
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
  <key>DeveloperIdentifier</key><string>LTZ2PFU5D6</string>
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
