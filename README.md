# Scribe Ai

Run AI tasks in Obsidian with your configured model.

## Agent tasks

Open **Scribe Ai** and submit a task. The agent starts in the current vault. Under **Add a path outside the vault**, choose a file or folder in the system picker to grant access for the current task. Add it again for a new task. Paths mentioned in the instructions or saved in chat history do not grant access.

You can expand saved text selections in older conversations to review the exact excerpts sent with those messages.

Chats and tool results are saved locally in the Scribe Ai plugin folder for this vault. Reopening Obsidian restores your last chat, including any partial reply saved when you stopped or closed the chat view. Send a follow-up to pick up from it, or select **Review before resuming** to inspect the saved task's outgoing content and destination before continuing it.

Select **+** above the chat to open another conversation. Each tab keeps its own draft, queue, model, and running task. Right-click a tab to rename or close it. A task keeps running after you close its tab, and **Chat history** reopens the conversation.

When you send a task, the current chat history, instructions, file references, and tool results it uses can be sent to the selected model provider. Select **Stop** to cancel pending work. Tools from a previous task only run again when a new task requests them and any required approval is granted.

`Read`, `Glob`, and `Grep` retrieve information. `Write`, `Edit`, and `NotebookEdit` preview changes for approval. An overwrite requires the model to receive every line of the file's current version in this task. For long notes, request smaller pages or use a local edit. Chat does not run shell commands. Turning off **Tool calling** for the selected model also blocks local tool execution.

## Side chat

Select **Ask in side chat** on a queued message to send its text, references and quotes to side chat. The message leaves the queue after the question starts, and your main draft stays in the input box. Enter `/side` to open side chat, or `/side your question` to send a question immediately. **Add to chat** attaches selected passages to the current input. Each main conversation has its own side chat in Obsidian's right sidebar. It uses the main conversation as it was when you first opened it. The main task can keep running while you ask follow-up questions.

Side chat can read and search notes in the current vault using `Read`, `Glob`, and `Grep`. Use **Add context** to attach a vault file or folder, and choose a model for that side chat from the input box. The selected provider can receive the inherited conversation, attached text and paths, and note contents it reads. Closing the side chat tab cancels its current response and clears its messages. Side chats are separate from the saved chat history.

## Development

```bash
npm install
npm run dev    # watch build into main.js
npm run build  # type-check + production bundle
npm run lint
npm run test:agent
```

The agent suite also checks live chat timeline order, tool grouping, and remembered disclosure state.

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

1. Open **Settings → Scribe Ai → Models** and select **Add provider** or edit an existing provider.
2. Link an existing Obsidian secret or create one with your API key. The plugin stores only the secret ID. If you previously relied on a `scribe-ai-<providerId>` name alone, link that secret explicitly.
3. Add the models you need and save. Unlinking a secret or removing a provider leaves the secret in Obsidian for other configurations that may use it.

OAuth token refreshes are serialized and written back to the same secret. Secrets, request bodies, response bodies, and query strings are excluded from communication logs.

### Network

Streaming responses support cancellation, gzip/Brotli/deflate decoding, backpressure, and connection/first-byte/stream-idle timeouts. The plugin's network channel blocks automatic redirects to a different site. If a service has moved, configure its new URL directly. Proxy resolution order is plugin setting, environment variables, Electron system proxy (best effort), then direct connection. Localhost and `NO_PROXY` targets bypass proxies.

Run the local transport and protocol integration tests with:

```bash
npm run test:communication
```
