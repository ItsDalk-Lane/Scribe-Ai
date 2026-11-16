# Scribe Ai

Model settings for your vault.

## Development

```bash
npm install
npm run dev    # watch build into main.js
npm run build  # type-check + production bundle
npm run lint
```

Copy `main.js` and `manifest.json` (plus `styles.css` if present) into
`<Vault>/.obsidian/plugins/scribe-ai/` and enable the plugin in
**Settings → Community plugins**.

## Releasing

Bump `minAppVersion` in `manifest.json`, then run `npm version patch|minor|major`
to update `manifest.json` and `versions.json`. Create a GitHub release whose tag
is the exact version number (no `v` prefix) and attach `manifest.json`,
`main.js`, and `styles.css` (if present).

## Model communication (desktop)

The communication layer pins `@earendil-works/pi-ai@1.5.2` and exposes its built-in provider catalog. Model HTTP requests use Node's network stack rather than Chromium, so third-party gateways are not limited by browser CORS. This makes the plugin desktop-only.

### Credentials

Credentials are managed by **Obsidian SecretStorage**, never by `data.json`:

1. Create a secret in Obsidian. For automatic lookup, use the ID `scribe-ai-<providerId>` (for example, `scribe-ai-openai`) and store the raw API key as its value.
2. In **Settings → Scribe Ai**, set the provider ID and select the secret with **Provider credential**. The setting stores only the secret ID.
3. Set a model ID from the selected provider's pi-ai catalog.

OAuth token refreshes are serialized and written back to the same secret. Secrets, request bodies, response bodies, and query strings are excluded from communication logs.

### Network

Streaming responses support cancellation, gzip/Brotli/deflate decoding, backpressure, and connection/first-byte/stream-idle timeouts. Proxy resolution order is plugin setting, environment variables, Electron system proxy (best effort), then direct connection. Localhost and `NO_PROXY` targets bypass proxies.

Run the local transport and protocol integration tests with:

```bash
npm run test:communication
```
