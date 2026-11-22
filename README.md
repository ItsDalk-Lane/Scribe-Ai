# Scribe Ai

Run AI tasks in Obsidian with your configured model.

## Agent tasks

Open **Scribe Ai** and submit a task. The agent starts in the current vault. Under **Add a path outside the vault**, choose a file or folder in the system picker to grant read access for the current task. Add it again for a new task. In the default modes, paths mentioned in the instructions or saved in chat history still require approval before access.

Saved text selections in older conversations remain available for local review.

In **Settings → Scribe Ai → General → Writing rules**, save vault-wide rules to `AGENTS.md` at the root of the vault, or folder rules to `AGENTS.md` inside the selected folder. You can also edit these Markdown notes directly. Folder rules take priority over conflicting vault rules, and more specific subfolders take priority over their parents. Attach a vault note or folder to use its rules. A main chat without attachments uses the active note's folder when available. Empty rule notes have no effect. Applicable rules are sent to the selected model with the next task. On upgrade, old rules are copied to missing documents. If a document already contains different text or cannot be created, the old rule is retained under `writingRulesBackup` in the plugin's `data.json`.

Chats and tool results are saved locally in the Scribe Ai plugin folder for this vault. Reopening Obsidian restores your last chat, including any partial reply saved when you stopped or closed the chat view. Send a follow-up to pick up from it, or select **Review before resuming** to inspect the saved task's outgoing content and destination before continuing it.

Select **+** above the chat to open another conversation. Each tab keeps its own draft, queue, model, and running task. Right-click a tab to rename or close it. A task keeps running after you close its tab. On the start screen, hover over a row in **Recent chats** to rename or delete it. Inside a conversation, hover over a mark on the right edge of the chat to see its title, update time, and latest exchange. Select the mark to reopen the chat. The preview also lets you rename or delete it. In a narrow pane, select **Chat history** at the lower right.

When you send a task, the current chat history, instructions, file references, and tool results it uses can be sent to the selected model provider. Select **Stop** to cancel pending work. Tools from a previous task only run again when a new task requests them and any required approval is granted.

When a chat approaches the model's context limit, Scribe first reduces older, longer tool results in the outgoing request and preserves references for reading them again where available. If a long main chat still needs to trim earlier activity, Scribe can send excerpts of conversations and relevant tool results to the selected model for a summary. Older chat summaries keep decisions, note sources, and outstanding tasks. A long task can also receive a handoff summary covering verified notes, completed actions, and remaining work. Both summaries are saved locally with the chat. Resuming a task can reuse its saved handoff. The original chat remains available. Open the context details next to the input to see the most recent compression and its result.

Open a task's usage details to see the combined figures for chat, automatic review, and summaries. The conversation usage panel combines the recorded tasks. A field is unknown if it cannot be determined from every contributing request's report. Cost uses amounts returned by the provider. Reusing a saved summary adds no new summary request.

Use the execution mode selector next to **Add context** in the main chat. New chats and tabs inherit the previous chat's mode. Saved conversations keep their own mode when reopened. If the previous mode is missing or invalid, the default is **Ask for approval**. Stop the current task and clear or finish queued messages before changing modes.

- **Ask for approval** runs ordinary vault reads and edits directly. External file changes, reads of unshared external files, and commands that need broader access ask for your approval for that action.
- **Approve for me** uses the same default scope and sends approval requests to a separate review using the selected model. The review request includes the task instruction and the exact operation, which may include file previews, paths, or commands. This can add to model usage. The operation runs only after an explicit approval from the reviewer.
- **Full access** lets file tools and commands use your computer account's permissions, including access outside the vault and network access, without per-action approval. Confirm this mode when selecting it. New chats can inherit it when it is the previous chat's saved mode.

On macOS, routine Bash commands run within a restricted environment with networking blocked. When the selected shell or system cannot enforce those limits, commands need approval in **Ask for approval** and **Approve for me**. A command that requests broader access is reviewed before it runs, with the command and its working directory included. After approval, it runs with your computer account's permissions.

Bash and PowerShell commands can move to the background after 10 seconds of foreground execution. If the command is still running and a slot is available, the chat receives a task ID and continues. The same process and collected output carry over, but the foreground wait deadline stops applying: background commands have no runtime limit and run until they finish or are stopped. Ask for background execution explicitly to receive an ID as soon as the command is approved and starts. A command that does not move to the background is stopped by its foreground timeout (2 minutes by default, up to 10 minutes). Scribe Ai allows up to 8 background commands at once.

While a job runs, its in-memory output window is bounded to 256 KiB shared by stdout and stderr. After settlement the window keeps 16 KiB shared by both streams, plus output the model has not read yet. Complete output up to 64 MiB per stream is written to private temporary files, and the job output tool reports those paths. The expanded task view reads the in-memory window, so it can show an output-dropped notice instead of the full stream. These temporary files follow DSH's startup retention: one best-effort sweep at plugin start removes regular files older than the configured period (30 days by default) and prunes empty spill directories; set the period to 0 in **Advanced** to disable cleanup. Leaving a job list or unloading the plugin does not delete them. Roots that are not private and owned by the current user are left untouched. Changes apply at the next plugin start. Model-facing single tool results use DSH's 12,500 estimated-token budget: oversized text keeps ordered head and tail previews, the full result is stored in a private temporary file, and the result includes that path for a later read or grep. The Read tool keeps its own paging limits. The same configurable startup sweep handles these result files.

Open the background-task control in the toolbar above the chat input to see running and finished commands, expand their output, stop a running command, or clear finished rows. Chat history lists all conversations. Scribe Ai saves the most recent 32 finished results per chat, including their read state and the retained beginnings and ends of the output. Older results saved before read tracking remain available in the same control. Closing Obsidian or unloading the plugin stops running background commands.

An overwrite requires the model to receive every line of the file's current version in this task. For long notes, request smaller pages or use a local edit. Turning off **Tool calling** for the selected model also blocks local tool execution in every mode.

## Skills

Type `$` in a main or side chat to search for a skill. Choose a source when several skills have the same name. Type `/skills` to browse or switch skills on and off. A manually selected skill's complete instructions go to the selected model on the first request. For automatic selection, the model receives the eligible names, descriptions and locations first. It can then read the selected instructions and supporting files. Side chat stays read-only and subagents keep their role permissions. A skill does not grant permission to send data to another service or execute its scripts.

**Settings → Scribe Ai → Skills** manages copies in this vault's `.scribe-ai/skills` folder. Use **Add skill** to create with the agent, search supported local tools, or import a folder, ZIP archive or Markdown file. Review a generated draft or an import before saving. Editing and uninstalling affect the managed copy. **Use now** prepares a new chat draft. Seven bundled skills can be disabled, uninstalled or restored. A personal skill with the same name is preserved. Skill usage is counted locally when the model receives it.

**General** also lets you select shared skill directories for live access and adjust the model's skill catalog budget. Scribe finds `.agents/skills` under the vault root and along the path to attached vault notes or folders, or the active note when there are no attachments. Shared originals are read in place. To write a new skill to a shared directory, select that destination during creation or GitHub installation. Removing a shared directory takes effect on subsequent skill reads.

Use `$skill-installer` in chat to list the public OpenAI curated skills or install from a public GitHub folder. This contacts GitHub to retrieve the catalog or selected files. Installation shows the source and destination, and does not run downloaded scripts or install dependencies. The details page reports declared dependencies. Connections to external tool services are not supplied by the skill system.

## Subagents

In automatic mode, the main chat decides whether independent parts of a task would benefit from parallel work. It can choose a configured role or write instructions for a role specific to the assignment. Open **Settings → Scribe Ai → Subagents** to change when it delegates, how many subagents can run, and whether they can delegate further. The defaults allow six active subagents per chat and delegation from the main chat.

Expand the main chat’s execution details to see **Started**, **Contacted**, and **Completed** activity. Select a subagent’s name to open its own tab in Obsidian’s right sidebar. Its chat shows the original assignment, questions, replies, revision instructions, and each submitted version in order. The main chat continues its independent work and gives one final response after checking the results. It can return an assignment for up to two revisions. If the same key error occurs in two consecutive submissions, it stops the revision loop and uses the available information or asks for the missing decision.

Open **Subagents** above the input to send instructions, stop work, or close and reopen a subagent. Closing the chat tab lets subagents continue. Closing Obsidian saves recorded progress so you can inspect it after reopening.

Subagents use your configured models and the main chat’s access and approval rules. A custom role can restrict its tools. By default, the selected model receives the assigned instruction and references for this task. Delegation can also include earlier chat context. Selecting a model for a custom role authorizes sending its assignments to that model’s configured service. A model request to a different service otherwise asks for your confirmation and shows the destination and content. Subagent requests add to the model usage shown in the chat.

## Side chat

Select **Ask in side chat** on a queued message to send its text, references and quotes to side chat. The message leaves the queue after the question starts, and your main draft stays in the input box. Enter `/side` to open side chat, or `/side your question` to send a question immediately. In the main chat, select text to show **Add to chat** and **Ask in side chat**; the latter opens side chat with that passage quoted. Each main conversation has its own side chat in Obsidian's right sidebar. It uses the main conversation as it was when you first opened it. The main task can keep running while you ask follow-up questions.

### Slash commands

Type `/` at the start of a chat to find commands. Use the arrow keys to move, Tab to complete, Enter to run, and Esc to dismiss. Start with a space when you want to send a command as plain text. Side chat offers note and skill selection, copy, export, status, and warnings.

- Use `/plan` to plan with read-only note access. Select **Exit** beside the composer to return to your usual permissions.
- Use `/goal your objective` to set an objective with an automatic round limit. Each round uses your configured model and existing permissions. Reopening Obsidian leaves the goal paused until you select **Resume**.
- Use `/diff` to see recorded Markdown edits made through Scribe's note tools. Small before-and-after snapshots stay in the local chat record. `/review` sends the selected note or changes to your configured model only after you confirm.
- Use `/recap` to see a progress summary or `/compact` to summarize older chat content for future turns. Both use your configured model. The full chat stays available locally.
- Use `/archive` to hide a conversation from recent chats. `/resume` can restore it. `/export` saves a separate Markdown note, and `/presets` saves frequently used prompts and commands.

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
