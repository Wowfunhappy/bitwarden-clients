# Safari legacy build

This target packages Bitwarden Browser 2024.11.2 as a pre-WebExtension
`.safariextension` bundle.

Run `npm run dist:safari-legacy` from `apps/browser`. The unpacked extension
is written to `dist/SafariLegacy/bitwarden.safariextension` and a portable
archive to `dist/dist-safari-legacy.zip`.

The target uses the 2024.11.2 Manifest V2 application and a compatibility layer
for Safari's legacy extension APIs. Vault access, sync, item management,
password generation, page collection, autofill, save prompts, tab/window
operations, badges, alarms, storage, and context menus are bridged. APIs that
Safari legacy never exposed cannot be made equivalent: native messaging,
WebAuthn/passkey interception, request-body observation, HTTP-auth interception,
and browser privacy-setting control degrade to safe no-ops.

The generated extension is unsigned. Safari Extension Builder (or a compatible
legacy host's extension loader) must apply a certificate appropriate to the
target browser before distribution.
