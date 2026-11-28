# Scribe Ai

Run AI tasks in Obsidian with your configured model.

## Network access, data and permissions

Scribe Ai is a free desktop plugin licensed under AGPL-3.0. Cloud model, web search, and MCP services you choose may require your own account or API key and may charge fees or consume a quota. Their terms and rates apply to your requests, including extra model calls for features such as summaries, automatic approval reviews, and video analysis. See [LICENSE](LICENSE) and [third-party notices](THIRD_PARTY_NOTICES.md).

### Network connections and data sent

- **Models.** The model endpoint you select can receive your task, relevant chat history, note paths and contents, attachments, vault rules, skills, enabled memory, and tool results used in the task. Summaries, goal verification, and delegated tasks can make additional model requests using the relevant context. Automatic tool approval can send your task and the proposed operation for review. For edits to existing notes, the preview sent for review contains the changed lines and their positions. A separately configured video model receives the current question and the selected video or its URL.
- **Model catalogs.** At startup and when you refresh model data, Scribe contacts Models.dev for public model information and can query Pi's public catalog, model providers, and configured endpoints. Provider catalog requests can use linked credentials. Catalog requests carry no chat or note content.
- **Web search and media.** Obsidian's note search runs locally. With web search enabled, the chosen service receives the query. Its results can go to your chat model. Opening remote media or attaching a supported remote image can contact its host. The configured model can receive media you attach or obtain through an authorized tool.
- **MCP and skills.** Enabled MCP servers can connect at startup. Tool arguments, which may include note content or file paths, go to the configured remote server or local program. Results can be saved in the chat and sent to the model. Scribe contacts GitHub when you request the public skill catalog or fetch a skill from a public repository for review and import.

Chat history, usage and diagnostic records, and optional long-term memory are saved locally in the vault's `.scribe-ai` directory. Linked credentials and a randomly generated local profile identifier are stored in Obsidian Secret Storage. Scribe does not use the computer name or username to identify the profile.

### Vault and command access

- **Vault and external files.** Ordinary reads and edits in the current vault can run directly. Use **Add a path outside the vault** to let the current task read a file or folder you select. Reads of unshared external files follow the selected approval mode. File tools ask before writing outside the vault by default. The Full access setting below lets you change that approval requirement in that mode. **Ask for approval** shows the proposed action. **Approve for me** sends eligible actions to the model for review. You can also select shared skill folders outside the vault and choose them as a destination when creating or importing a skill.
- **Commands.** On macOS, Bash can run offline with read-only vault access. A command that requests vault writes or needs to run outside the sandbox, including PowerShell, needs your approval by default. Starting a local MCP program requires approval for that device and configuration. The approved program runs with your computer account's permissions.
- **Full access.** The mode selector shows a warning before you enable this mode. Scribe can read external files and call configured online tools directly. **Settings → Scribe Ai → Advanced → Require approval for elevated actions in full access** is enabled by default. Turn it off to let this mode write external files and run commands beyond the read-only sandbox without individual approval. Long-term memory and writing-rule tools keep their own approvals.
- **Clipboard.** Scribe accesses the clipboard when you paste an attachment or select a copy action. Sign-in displays the device code for you to copy manually.

## Agent tasks

Open **Scribe Ai** and submit a task. The agent starts in the current vault. Under **Add a path outside the vault**, choose a file or folder in the system picker to grant read access for the current task. Add it again for a new task. In the default modes, paths mentioned in the instructions or saved in chat history still require approval before access.

Saved text selections in older conversations remain available for local review.

In **Settings → Scribe Ai → Personalization**, select **Edit** next to **AGENTS.md** under **Custom instructions**. Select **Save** to write your instructions to the vault’s root `AGENTS.md`. When leaving with unsaved edits, choose whether to save, discard, or keep editing. Give Scribe your writing conventions, workflow, save locations, or folders to leave alone. Instructions apply on the next task within its existing permissions. Clear the editor and save to stop applying them.

**Trust folder instructions** is off by default. After checking the source of a vault’s instructions, enable it to let Scribe send the `AGENTS.md` files in relevant folders to your current model as the task reaches them. Scribe’s note editing tools pause the first write in a folder until the model receives its rules. Legacy folder settings remain available under `writingRulesBackup` in `.scribe-ai/settings.json`.

**Long-term memory** is off by default. Enable it to share a short topic index with the current model and let it read stored preferences and decisions when needed. The agent requests your approval before saving, updating, or deleting a memory, including in Full access. Open **Saved memories → Manage** to read, edit, or delete entries. Memories are local to this user, device, and vault and stored under `.scribe-ai/memory`. They are ordinary local files, so keep credentials out of memory and account for the files in your backups. Turning off the feature stops sending memory entries. Content already quoted in chat follows the chat’s own history and deletion controls.

After upgrading from 1.0.2, Scribe uses a random local identifier. It resets the chat approval mode, trusted folder instructions, memory and cross-chat search permissions on first launch. Your saved conversations and memory files are kept. To recover memories, open **Saved memories → Manage → Import**, then decide whether to re-enable memory. Local MCP programs also require approval again.

With long-term memory enabled, the agent can search the current chat for short historical excerpts. **Search other conversations in this vault** is a separate setting. Enable it if you want matching excerpts from other saved chats in this vault sent to the model you are currently using.

Scribe saves chats, settings, command presets, and skills in the vault's hidden `.scribe-ai` folder. Full tool outputs are kept in its `cache` subfolder and expire according to your cleanup setting. The plugin's `data.json` records the storage version. On upgrade, Scribe copies and checks the records. Before removing the legacy files on the next successful load, it verifies the records can still be read at the new location and accounts for edits and deletions made through the plugin. Obsidian Sync excludes `.scribe-ai`; include the folder in your own backups if you want to restore it on another device.

Reopening Obsidian restores your last chat, including any partial reply saved when you stopped or closed the chat view. Send a follow-up to pick up from it, or select **Review before resuming** to inspect the saved task's outgoing content and destination before continuing it.

For multi-step work, the agent can create a checklist shared with its subagents. Select the progress count above the chat input to see the steps. The active step has a moving indicator, and completed steps have a green check and a strikethrough. Stopping a run marks its active step as stopped and leaves the other steps in place. An agent can claim the stopped step when work resumes. The checklist is saved with the conversation. In Plan mode, the agent can draft steps and their dependencies. Select **Execute plan** to allow work on those steps.

Select **+** above the chat to open another conversation. Each tab keeps its own draft, queue, model, and running task. If a saved chat or side chat loses its selected model, it uses the current default for new messages. A queued message keeps its original destination. If that destination changes or an older entry has no saved destination, select **Continue queue** and confirm the recipient. Moving a queued message to a running task or a side chat requires the same saved destination. If no default is available, select a model before sending. Right-click a tab to rename or close it. A task keeps running after you close its tab. On the start screen, hover over a row in **Recent chats** to rename or delete it. Inside a conversation, hover over a mark on the right edge of the chat to see its title, update time, and latest exchange. Select the mark to reopen the chat. The preview also lets you rename or delete it. In a narrow pane, select **Chat history** at the lower right.

Select **Send into current task** on a queued message to steer the running agent. Tools that have already started can finish. Scribe skips the remaining calls from that batch, records which ones were skipped, and lets the model choose the next action using your instruction. The message leaves the queue after successful delivery. Other queued messages keep their place.

When you send a task, the current chat history, instructions, file references, and tool results it uses can be sent to the selected model provider. Select **Stop** to cancel pending work. Tools from a previous task only run again when a new task requests them and any required approval is granted.

Select **Add context**, or type `@` at the start of the input or after a space and keep typing in the draft. Recent chats are listed directly in the menu. Select one by title, search vault files by name or path, or browse recent files and top-level folders. Searching with an existing folder path limits suggestions to that folder. Selecting an inline result replaces the search text with a reference in the draft. The main chat also lets you reference a path outside the vault. A long chat reference includes the most recent messages and marks where earlier text was omitted.

When a chat approaches the model's context limit, Scribe first reduces older, longer tool results in the outgoing request and preserves references for reading them again where available. If a long main chat still needs to trim earlier activity, Scribe can send excerpts of conversations and relevant tool results to the selected model for a summary. Older chat summaries keep decisions, note sources, and outstanding tasks. A long task can also receive a handoff summary covering verified notes, completed actions, and remaining work. Both summaries are saved locally with the chat. Resuming a task can reuse its saved handoff. The original chat remains available. Open the context details next to the input to see the most recent compression and its result.

Open a task's usage details to see the combined figures for chat, tool approval reviews, goal verification, and summaries. **Conversation activity** above the input box shows measured output speed in tokens per second (TPS). Open **Conversation usage** for usage details. An interrupted request and its retry each count once. Both usage views show only the available metrics and their values. When Scribe sends a request, it estimates the prompt token count from the context sent to the model. Images and videos use a fixed estimate per attachment. Each counter the provider reports replaces the estimate or earlier value for that field on the same request. Until the final output count arrives, Scribe adds an estimate for output received after the latest reported count, including an initial count of zero. If the provider has given no output count, the estimate covers all output received for that request. Cache read and write counts come from the provider. The cache hit rate includes requests whose provider figures establish both prompt tokens and cache reads. Reusing a saved summary adds no new summary request.

Use the execution mode selector next to **Add context** in the main chat. New chats and tabs inherit the previous chat's mode. Saved conversations keep their own mode when reopened. If the previous mode is missing or invalid, the default is **Ask for approval**. Stop the current task and clear or finish queued messages before changing modes.

- **Ask for approval** runs ordinary vault reads and edits directly. External file changes, reads of unshared external files, and commands that need broader access ask for your approval for that action.
- **Approve for me** uses the same default scope and sends approval requests to a separate review using the selected model. The review request includes the task instruction and the operation. For edits it sends changed lines and their positions. External writes, changes to writing rules and long-term memory, and commands requiring write or broader access use human approval. This can add to model usage. The operation runs only after an explicit approval from the reviewer.
- **Full access** lets file tools read external files and call configured online tools directly. The warning explains whether the Advanced setting requires individual approval for external writes and commands beyond the read-only sandbox. The setting applies only to Full access. Writing rules and long-term memory keep their own approvals. Confirm this mode when selecting it. New chats can inherit it when it is the previous chat's saved mode.

On macOS, routine Bash commands have read-only access to the vault and run offline. A command that needs write access to ordinary vault files can request a writable offline sandbox. If the command requires access outside the sandbox or runs on a system without it, the command runs with your computer account's permissions. Both cases require your approval unless you have explicitly turned off those approvals for Full access.

Bash and PowerShell commands can move to the background after 10 seconds of foreground execution. If the command is still running and a slot is available, the chat receives a task ID and continues. The same process and collected output carry over, but the foreground wait deadline stops applying: background commands have no runtime limit and run until they finish or are stopped. Ask for background execution explicitly to receive an ID as soon as the command is approved and starts. A command that does not move to the background is stopped by its foreground timeout (2 minutes by default, up to 10 minutes). Scribe Ai allows up to 8 background commands at once.

While a job runs, its in-memory output window is bounded to 256 KiB shared by stdout and stderr. After settlement the window keeps 16 KiB shared by both streams, plus output the model has not read yet. Complete output up to 64 MiB per stream is written to private files in this vault’s `.scribe-ai/cache` folder, and the job output tool reports those paths. The expanded task view reads the in-memory window, so it can show an output-dropped notice instead of the full stream. These files follow the configured retention period: one best-effort sweep at plugin start removes regular files older than the configured period (30 days by default) and prunes empty spill directories; set the period to 0 in **Advanced** to disable cleanup. Leaving a job list or unloading the plugin does not delete them. Roots that are not private and owned by the current user are left untouched. Changes apply at the next plugin start. Model-facing single tool results use DSH's 12,500 estimated-token budget: oversized text keeps ordered head and tail previews, the full result is stored in the same private cache, and the result includes that path for a later read or grep. The Read tool keeps its own paging limits. The same configurable startup sweep handles these result files.

Open the background-task control in the toolbar above the chat input to see running and finished commands, expand their output, stop a running command, or clear finished rows. Chat history lists all conversations. Scribe Ai saves the most recent 32 finished results per chat, including their read state and the retained beginnings and ends of the output. Older results saved before read tracking remain available in the same control. Closing Obsidian or unloading the plugin stops running background commands.

When the model requests several independent Markdown notes together, Scribe can read up to three at a time. Each call must qualify as an authorized local read. The model receives the results in the order it requested them. A batch that includes an edit, an external source, or an approval runs in order.

An overwrite requires the model to receive every line of the file's current version in this task. For long notes, request smaller pages or use a local edit. Turning off **Tool calling** for the selected model also blocks local tool execution in every mode.


### Model context

Agent requests use fixed XML system instructions followed by approved project context, a session snapshot, and the conversation. The snapshot supplies the local date, time zone, and available Obsidian settings for the task. Scribe labels your typed request, attached references, quoted conversations, and approved plans separately. Later messages carry changes to the date, mode, rules, or collaboration state. Notes and tool results supply evidence for your request.

Replies stay in chat unless you request a save or edit. When you ask for notes from a particular period, Scribe uses the dates you specify, or the vault's daily note settings and the dates recorded in the notes. By default the week runs Monday through Sunday. The agent displays a short description of each built-in tool action in the chat and on any approval card for that action. Scribe enforces the current approval and read-only rules.

When a long chat approaches the model's input limit, Scribe Ai shortens older tool results and can ask the same configured model for a handoff summary. It restores the current mode, applicable rules and skills, and task or plan progress from local records. Diagnostic logs show estimated input by context layer and the cache counts a provider actually reported.

## Skills

Type `$` in a main or side chat to search for a skill. Choose a source when several skills have the same name. Type `/skills` to browse or switch skills on and off. A manually selected skill's complete instructions go to the selected model with that request. For automatic selection, the model receives eligible names and descriptions and can read matching skills and supporting files by name. Duplicate names include the source for selection. If any source fails to scan, the model can check which entries are available. Side chat stays read-only and subagents keep their role permissions. A skill does not grant permission to send data to another service or execute its scripts.

**Settings → Scribe Ai → Skills** manages copies in this vault's `.scribe-ai/skills` folder. Use **Add skill** to create with the agent, search supported local tools, or import a folder, ZIP archive or Markdown file. Local search checks supported skill folders and skill paths configured in the environment Obsidian was launched with. If you set a skill path only in a terminal startup file, import that folder directly. Review a generated draft or an import before saving. Editing and uninstalling affect the managed copy. **Use now** prepares a new chat draft. Seven bundled skills can be disabled, uninstalled or restored. A personal skill with the same name is preserved. Skill usage is counted locally when the model receives it.

**General** also lets you select shared skill directories for live access and adjust the model's skill catalog budget. Scribe finds `.agents/skills` under the vault root and along the path to attached vault notes or folders, or the active note when there are no attachments. Shared originals are read in place. To write a new skill to a shared directory, select that destination during creation or GitHub installation. Removing a shared directory takes effect on subsequent skill reads.

In an editable skill's details, open **Skill settings → Automatic recommendation scope**. Enter one vault-relative path per line. For example, `Meetings/Weekly.md` matches one note, `Meetings/` matches that folder and its contents, and `Projects/**/*.md` matches Markdown notes in that folder and its subfolders. Scribe checks attached vault notes or folders first, then falls back to the active note. Clear the setting to recommend the skill across the vault. Manual selection with `$` still follows the skill's usual availability. Shared and project skills can declare the same rules in the `paths` list in `SKILL.md`.

Use `$skill-installer` in chat to list the public OpenAI curated skills or install from a public GitHub folder. This contacts GitHub to retrieve the catalog or selected files. Installation shows the source and destination, and does not run downloaded scripts or install dependencies. The details page reports declared dependencies. Connections to external tool services are not supplied by the skill system.

## Search notes by tag, property and structure

In a normal chat with tool calling, ask in natural language for notes tagged AI, notes with a specific property, or notes containing a particular property value. The agent can combine these conditions with a folder, exclusions, comparisons, and Obsidian's section, block and task filters. The search uses Obsidian's desktop core Search engine, respects excluded files and task access, and returns vault-relative Markdown paths. The tool appears when the core Search engine exposes its native search handler. The query runs locally and matching paths are returned to the selected chat model for the reply.

## Web search

Open **Settings → Scribe Ai → Services**, choose a search provider, and turn on **Enable web search**. The agent decides when to search in chats that allow tools. **Ask for approval** previews the search query and its destination, **Approve for me** uses the same AI review as other tools, and **Full access** sends the query directly. Side chats, plan mode, and read-only subagents keep their restricted tool sets.

Zhipu Coding Plan uses the plan's search quota. DeepSeek uses its standalone Search API, which bills successful searches with results. Both can reuse the corresponding official model provider's linked key or use a key selected in Obsidian Secret Storage. Unlinking applies to search only and keeps the key in Obsidian Secret Storage. Exa offers public search subject to rate limits. Tavily requires its own API key and can use the free quota for basic searches. **Test search** sends one public query and may use provider quota.

Each search sends the query to the selected provider. The chat model receives the resulting titles, links, and excerpts, which may also be saved in chat history.

## MCP

Open **Settings → Scribe Ai → MCP** to add a local command or a remote MCP server. Choose Streamable HTTP for current servers and select the legacy SSE option if your server requires it. Use the Obsidian secret picker to link an existing key or create one. For remote servers, you can also use **Sign in** if the service supports browser sign-in. When you import MCP JSON or Codex TOML, Scribe saves recognized credentials in Obsidian Secret Storage using the server name and a numeric suffix for each collision. This covers headers, environment variables, tokens, OAuth client secrets, URL query parameters, and common command arguments such as `--api-key`. JSON export leaves out stored credential values. Imported servers start disabled. To run a local server, check its program, arguments, and working directory and approve the configuration on this device. An existing local server requires confirmation on first use after this update. Changes to the approved configuration require renewed confirmation. Use HTTPS for remote servers and HTTP only for a server listening on the same computer.

Enabled servers can offer tools and resources to chats with tool access. MCP calls follow the permission mode selected in the chat composer. **Ask for approval** prompts you, **Approve for me** uses the same AI review as built-in tools, and **Full access** runs calls directly. Tool arguments go to the selected server. Tool results can be saved in the conversation and sent to the configured chat model. Text and structured data are supported. Supported image blocks and image resources are sent to vision models. Audio attachments are described in text. Use the server's **Tools** tab to enable or disable individual tools, or switch the server off to close the connection. With on-demand discovery, the model looks up parameter definitions through a fixed pair of tools. If the server offers text prompt templates, open **MCP** from the slash menu and explicitly select a template to bring its contents into an editable draft.

## Subagents

In automatic mode, the main chat decides whether independent parts of a task would benefit from parallel work. It can choose a configured role or write instructions for a role specific to the assignment. Open **Settings → Scribe Ai → Subagents** to change when it delegates, how many subagents can run, and whether they can delegate further. The defaults allow six active subagents per chat and delegation from the main chat.

Expand the main chat’s execution details to see **Started**, **Contacted**, and **Completed** activity. Select a subagent’s name to open its own tab in Obsidian’s right sidebar. Its chat shows the original assignment, questions, replies, revision instructions, and each submitted version in order. The main chat continues its independent work and gives one final response after checking the results. If the same key error occurs in two consecutive submissions, it stops the revision loop and uses the available information or asks for the missing decision.

Open **Subagents** above the input to send instructions, stop work, or close and reopen a subagent. Closing the chat tab lets subagents continue. Closing Obsidian saves recorded progress so you can inspect it after reopening.

The model uses six collaboration tools for starting work, contacting subagents, managing their status, waiting, reading saved results, and reviewing submissions. Only a subagent can use the contact tool to ask its delegator a question. When a question is pending, the model can answer it, list subagents, and read the material needed for its answer before returning to other work.

Subagents use your configured models and the main chat’s access and approval rules. The built-in explorer is read-only, including under Full access. A custom role can restrict its tools. By default, the selected model receives the assigned instruction and references for this task. Delegation can also include earlier chat context. Selecting a model for a custom role authorizes sending its assignments to that model’s configured service. A model request to a different service otherwise asks for your confirmation and shows the destination and content. Subagent requests add to the model usage shown in the chat.

## Side chat

Select **Ask in side chat** on a queued message to send its text, references and quotes to side chat. The message leaves the queue after the question starts, and your main draft stays in the input box. Enter `/side` to open side chat, or `/side your question` to send a question immediately. In the main chat, select text to show **Add to chat** and **Ask in side chat**; the latter opens side chat with that passage quoted. Each main conversation has its own side chat in Obsidian's right sidebar. It uses the main conversation as it was when you first opened it. The main task can keep running while you ask follow-up questions.

### Slash commands

Select **Slash commands** next to **Add context** in the main chat, or type `/` at the start of the input. Use the arrow keys to move, Tab to complete a typed command, Enter to run, and Esc to dismiss. Start with a space when you want to send a command as plain text. The side chat menu offers skills, MCP services, export, and warnings.

Type the first few characters of a skill's name after `/`, then select it to add it to the draft. In the main chat, the same search also finds preset creation, saved presets, current goal actions, review targets and operations waiting for retry approval. Review and retry still ask for confirmation.

- Use `/mcp` to view configured services and their connection states. In the main chat, select a connected service, then write and send your task to use that service's tools. Calls follow the usual approvals.
- Use `/agents` (or `/subagents`) to choose a built-in or custom subagent. Send your task to start the selected role in the current chat.
- In the main chat, type `/` followed by the start of an MCP service or subagent name to select it directly from the suggestions.
- Select **Plan** from the command menu to add a Plan label beside permissions, then send the task for read-only planning. The agent can also enter planning during a task. Review or edit the private Markdown draft in the plan card. Select **Execute plan** to keep the exploration in context or **Execute in a fresh context** to start from the approved plan and its attached material. Use **Revise** to send feedback while staying in plan mode. Approval applies to the specific version shown in the card. Selecting Plan pauses any running goal. After closing Plan, resume that goal from its status bar.
- Select **Goal** from the command menu, then send the objective, or enter `/goal your objective`. The status bar shows time spent on model requests and tool work, with controls to edit, clear, pause, and resume. Chat tasks continue while tools or responses make progress. Goals continue when the agent produces new evidence or verifies an acceptance criterion. Rewording the remaining work alone leaves the goal paused. Select the status to view acceptance criteria and progress. Progress and time are saved with the chat. Reopening Obsidian leaves the goal paused until you resume it.
- Use `/diff` to see recorded Markdown edits made through Scribe's note tools. Small before-and-after snapshots stay in the local chat record. `/review` sends the selected note or changes to your configured model only after you confirm.
- Use `/recap` to see a progress summary or `/compact` to summarize older chat content for future turns. Both use your configured model. The full chat stays available locally.
- Select **Chat history** in the title bar to reopen a conversation. Select **Archive chat** in history or recent chats. Open **Archived** in the history popover to view archived chats or select **Unarchive chat** to return a conversation to the regular lists. `/export` saves a separate Markdown note, and `/presets` saves frequently used prompts and commands.

For an explicit note title or link requirement, include the vault path and `.md` extension, for example `The title of Projects/Index.md must be "Weekly notes".` In an automatic goal round the agent reports numbered evidence and remaining work separately from its reply. Scribe checks the latest read or saved edit against the current note before declaring the goal complete. A criterion that needs judgment can trigger one separate request to the same model and address used for the task. For a specific fact, Scribe can send the matching source line. A whole-note judgment needs sufficient original text. The review uses no tools and counts toward review usage. If the source has changed or the review cannot confirm completion, open the goal status to see what still needs verification.

Side chat can read and search notes in the current vault using `Read`, `Glob`, and `Grep`. Use **Add context** to attach a vault file or folder, and choose a model for that side chat from the input box. The selected provider can receive the inherited conversation, attached text and paths, and note contents it reads. Closing the side chat tab cancels its current response and clears its messages. Confirming deletion of its main conversation also closes that side chat and discards its draft. Side chats are separate from the saved chat history.

## Development

Contributors and coding agents must follow the [feature integration rules](AGENTS.md#新功能如何接入现有规则) and the [project storage rules](AGENTS.md#插件数据存储).

```bash
npm install
npm run dev    # watch build into main.js
npm run build  # type-check + production bundle
npm run lint
npm test       # run all tests, including communication and cross-feature checks
```

The same tests run on pushes and pull requests. New test files under `src/` are discovered automatically.

Copy `main.js` and `manifest.json` (plus `styles.css` if present) into
`<Vault>/.obsidian/plugins/scribe-ai/` and enable the plugin in
**Settings → Community plugins**.

## Releasing

Bump `minAppVersion` in `manifest.json` when the plugin needs a newer Obsidian
version, then run `npm version patch|minor|major --no-git-tag-version`. This
updates `package.json` and, through `version-bump.mjs`, `manifest.json` and
`versions.json`. Keep `--no-git-tag-version` to prepare the four files without
creating a tag automatically. Commit and push the files, then push a tag with
the exact version number from `manifest.json`, such as `1.0.3`.

Open the **Release artifacts** workflow run for the tag and download the
`scribe-ai-<version>` artifact once the build and attestations pass. Create the
GitHub release for that tag and attach `manifest.json`, `main.js`, and
`styles.css` from the downloaded artifact. The build attestations verify the
exact bytes of those files. [GitHub artifact attestations](https://docs.github.com/en/actions/how-tos/secure-your-work/use-artifact-attestations/use-artifact-attestations)

## Model communication (desktop)

The communication layer pins `@earendil-works/pi-ai@1.6.1` and exposes its built-in provider catalog. Model HTTP requests use Node's network stack rather than Chromium, so third-party gateways are not limited by browser CORS. This makes the plugin desktop-only.

Scribe Ai updates its model data in the background on startup. To update it yourself, open **Settings → Scribe Ai → Models** and select **Update model data** next to **Add provider**. The update starts with each service's official catalog, using the linked account for services that require it. It collects every reported page and keeps chat models. When the official list is unavailable, Scribe Ai can use Pi's online snapshot or the catalog bundled with the plugin. Models.dev supplements capability details. Pi receives the Pi version, and Models.dev receives a request for its public catalog. Neither public catalog receives credentials, model selections, or vault content. See the [provider catalog audit](docs/model-catalogs.md) for connection-specific details.

**Add model** and **Fetch models** read the saved catalog in the current vault. The list shows its source and refresh time. If an update fails, the last saved list for that connection stays available. Capability fields have their own sources and may still be updated when the model list comes from a saved copy. A new custom address can be saved with a manually entered model ID and picked up by the next update. Model lists show catalog capabilities for image, audio, video and PDF input, reasoning, tool calling, and structured output.

When you open an individual model's settings, Scribe Ai fills structured output and video input independently from the local data for the model, API, and address. Saved manual settings take precedence. The structured output control distinguishes supported, unsupported, unconfirmed, and conflicting evidence. An unqualified claim of JSON support is recorded separately from JSON Schema. Missing limits and effort levels use the bundled model data or the plugin defaults.

Select a model with **Image** enabled to send images in chat. Use **Add context** to select a file, paste a screenshot straight into the input, or send an Obsidian image link such as `![[diagram.png]]`. Public HTTP or HTTPS image links work directly when the URL has a supported image extension. For links without an extension, use a Markdown image embed such as `![Diagram](https://example.com/render?id=123)`. The plugin downloads the image without model credentials and sends the image bytes to the selected model. The Agent can read image files and direct image links returned by tools using **Read**, subject to the chat's permissions. Approvals for tool-initiated image downloads show the destination.

Scribe Ai accepts PNG, JPEG, GIF, and WebP, up to 5 MiB per image and up to 12 images or 12 MiB of images per model request. Individual providers may apply lower limits. Pasted screenshots appear as removable thumbnails. Select a thumbnail to enlarge it. Pasted screenshots and binary tool images are stored in the current vault's private `.scribe-ai/cache/` so queued tasks and interrupted runs can reopen them. The default 30-day cleanup protects referenced pasted images. Clearing the cache keeps pasted images needed by drafts and saved conversations. Deleting a chat removes its temporary output and deletes pasted images when the last live reference is gone. Conversation records store references, and unrelated later turns do not replay the image bytes.

In replies and saved chats, select a rendered image to enlarge it. Obsidian media links to files in the current vault display images or playback controls. Select a remote media link to load it from its host. Remote Markdown images, audio and video are shown as links. Supported video and audio play in the message after selection.

To use native video in an ordinary chat, select a supported video model and use the existing attachment picker. Model settings show whether the selected API has a video input format and whether it needs an HTTPS link. Inline attachments have a combined 12 MiB limit. For a supported GLM Chat connection, include a direct HTTPS video URL as a Markdown embed, for example `![Video](https://example.com/clip.mp4)`. The selected provider receives explicit video attachments or URLs for the current task. Binary contents are loaded for the request and kept out of chat history. See the [verified video connections](docs/model-catalogs.md#固定-json-schema-和视频输入).

Open **Settings → Scribe Ai → Services** to choose **Local video analysis model** and **Linked video analysis model** separately. The local selector lists enabled model connections that accept video bytes. The link selector also lists connections that require HTTPS video links. A message with both sources uses the corresponding selection for each video.

In an ordinary chat, attach a file or embed a public HTTPS address whose path ends in a supported video extension. The link-only routes receive that address and retrieve the video themselves. Other routes receive video bytes prepared with locally installed FFmpeg and ffprobe. Scribe Ai checks the media and converts it to compatible MP4 when needed. Each locally prepared source is limited to 128 MiB and each prepared video to 12 MiB.

The selected video provider receives the video or link and your current question. Each dedicated analysis requires a provider receipt showing that video input was processed. Scribe Ai reads Gemini video usage and explicit video token counts from Chat Completions and Responses. A connection can support video input without providing that count. The chat model receives the timestamped analysis as context. If preparation, delivery confirmation, or analysis fails, the chat request stops with the reason. Scribe saves each confirmed video result. After interruption or a failed batch, retrying in the same chat with the same question, source and connection can reuse the items already processed. Video examples in code and links supplied only by a generated plan stay as text. Temporary files are kept in the vault cache and removed after preparation. **Use chat model** selects the direct path for that source only. Existing video analysis settings initially carry over to both selectors.

**Structured output** lets the Agent supply a JSON Schema for its next answer when a task needs fixed fields and types. The setting is a capability declaration. Ordinary answers use the usual format.

Model settings, connection tests, and chat resolve the API protocol and base URL together. Model overrides take precedence over provider overrides. Leave the model address blank and select its automatic protocol option to follow the resolved connection. For an unlisted model, Scribe Ai can use a compatible connection when the provider's protocol and address are unambiguous. When they cannot be resolved, select a protocol or enter its base URL before sending. Custom endpoints can still be configured explicitly.

OpenCode Zen and Go use the supported protocol from the saved catalog or, when no model-specific route is known, the plan's OpenAI Chat Completions route. A protocol change selects a matching official endpoint when the address is automatic. Connections that explicitly mix one OpenCode plan or protocol with another plan or protocol's official address are rejected before sending. Azure can resolve its address from the account configuration when the address is left blank. A task stops before its next model request if a catalog refresh changes its resolved connection. See the [OpenCode inference API](https://opencode.ai/docs/console/api/inference/).

You can enable several providers at once in **Models** and choose the model to use in chat. Turning a provider off hides its models from new selections and keeps its configuration and running tasks. If it held the chat default, Scribe Ai selects another enabled model when one is available. Turn the provider back on to resume an interrupted task that used one of its models.

### Credentials

Credentials are managed by **Obsidian SecretStorage**, never by `data.json`:

1. Open **Settings → Scribe Ai → Models** and select **Add provider** or edit an existing provider.
2. Link an existing Obsidian secret or create one with your API key. The plugin stores only the secret ID. If you previously relied on a `scribe-ai-<providerId>` name alone, link that secret explicitly.
3. Add the models you need and save. Unlinking a secret or removing a provider leaves the secret in Obsidian for other configurations that may use it.

Built-in models use explicitly linked credentials. Removing the link also prevents authentication with keys inherited from the Obsidian process. Remote model endpoints require HTTPS. Loopback endpoints can use HTTP. OAuth token refreshes across chat and connection tests are serialized by the linked secret and written back to that secret. Secrets, request bodies, response bodies, and query strings are excluded from communication logs.

### Network

Streaming responses support cancellation, gzip/Brotli/deflate decoding, backpressure, and connection/first-byte/stream-idle timeouts. Remote model and MCP connections use HTTPS, with HTTP available for services on the same computer. The plugin's network channel blocks automatic redirects to a different site. If a service has moved, configure its new URL directly. Proxy resolution order is plugin setting, environment variables, Electron system proxy (best effort), then direct connection. Local addresses and `NO_PROXY` targets bypass proxies. To use an authenticated proxy, enter the credentialed URL and select **Save proxy**. The credentials are stored in Obsidian SecretStorage. Unlinking them stops Scribe from using them, and the saved secret remains available in Obsidian.

HTTPS image downloads can use the configured local proxy when the system resolver returns synthetic addresses for public hostnames. The public-image checks still reject private destinations and literal synthetic addresses.

Run the local transport and protocol integration tests with:

```bash
npm run test:communication
```
