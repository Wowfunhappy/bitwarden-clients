# Safari legacy build

Packages Bitwarden Browser 2024.11.2 as a pre-WebExtension `.safariextension`
bundle for a legacy Safari extension host (Safari 7's extension runtime, here
running over a modern backported WebKit on OS X 10.9 Mavericks).

## Building

### Prerequisites

- **Node.js.** The repo pins Node ~20 (`.nvmrc`), but official Node 20 does not
  run on Mavericks. Build with whatever Mavericks-capable Node you have (this
  port was built and validated on Node 24). The webpack/Angular 17 toolchain
  tolerates it.
- No native toolchain is required for the browser target: `sass` is pure-JS
  dart-sass, and argon2 ships as WASM. The native `argon2`, Electron, and Rust
  `desktop_native` dependencies belong to the desktop app and are not needed.

### Steps

From the repository root:

```sh
# Install JS dependencies only — skip native postinstalls (electron binary,
# node-gyp argon2, Rust desktop_native) that the browser build does not use.
npm ci --ignore-scripts

# Build + package the uncompressed extension.
cd apps/browser
npm run dist:safari-legacy
```

The unpacked extension is written to
`apps/browser/dist/SafariLegacy/bitwarden.safariextension` — an uncompressed
folder (no zip) so it can be reloaded directly from disk in the extension host.
A production build takes a few minutes; ccache-free first builds are slower.

If webpack fails with `error:0308010C:digital envelope routines::unsupported`
on a newer Node, prepend `NODE_OPTIONS=--openssl-legacy-provider` to the build
command.

### Verifying a build

`apps/browser/src/safari-legacy/` ships a Node test harness (see the project's
scratch notes) that exercises the polyfill's message ports, storage events,
i18n, badge, URL resolution, popover-hosted popouts, tab tracking, and message
dispatch. Run it against the built `safari-legacy/background.js` after any
change to the polyfill. The polyfill is Terser-minified in a production build;
the harness passes against the minified output.

## Architecture

The target uses the 2024.11.2 Manifest V2 application unchanged and a
compatibility layer (`polyfill/`) that reconstructs the WebExtension APIs on
top of Safari's legacy extension objects:

- `background.js` — the `chrome.*` API surface for the global page: runtime
  messaging and ports, storage (backed by `safari.extension.secureSettings`),
  tabs/windows, i18n, badges, alarms, and scripting/injection.
- `content.js` — messaging + dynamic-injection bridge and `chrome.i18n` for
  injected content scripts.
- `extension-page.js` — bridges extension pages (the popup) to the global
  page's `chrome` object and applies a few legacy-host UI adjustments.

`package-safari-legacy.js` copies the webpack build, injects the bridge scripts
into each HTML page, writes `Info.plist`, copies toolbar icons, and appends a
small CSS fixup.

### What works

Vault access, sync, item management, password generation, page collection,
autofill (including on-page-load), save prompts, tab/window operations, badges,
alarms, and storage are bridged.

**Passkeys / WebAuthn work.** Because this WebKit has no native WebAuthn,
Bitwarden's own FIDO2 implementation serves as the authenticator: the page
script defines the `PublicKeyCredential` / `Authenticator*Response` globals, the
confirmation UI is hosted in the toolbar popover (legacy Safari cannot open
extension pages in tabs), and WebCrypto operates because the host marks the
extension scheme as a secure context. Upstream Permissions-Policy and
`isTrusted` hardening for WebAuthn are backported.

### What is intentionally omitted or degraded

- **Context menu** — legacy Safari menus are flat and cannot express the nested
  menu tree, so the feature and its settings toggle are removed.
- **Inline autofill menu** — hidden; the port relies on on-page-load / popup
  autofill.
- **Popout windows** — hosted in the toolbar popover, not standalone windows.
- Native messaging, request-body/HTTP-auth observation, and browser
  privacy-setting control degrade to safe no-ops (the host never exposed them).

The generated extension is unsigned; the extension host applies its own
certificate before loading.
