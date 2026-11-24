# Obsidian community plugin

## Project overview

- Target: Obsidian Community Plugin (TypeScript → bundled JavaScript).
- Entry point: `src/main.ts` compiled to `main.js` and loaded by Obsidian.
- Required release artifacts: `main.js`, `manifest.json`, and optional `styles.css`.

## 新功能如何接入现有规则

所有贡献者和编码智能体共用这份约定。开始改功能前，先从用户实际使用的入口追到执行和保存的位置，并用下面的表找出受影响的其他入口。遇到说明与现有行为冲突、两种选择都会改变用户体验时，先确认产品决定。

| 改动涉及 | 复用的入口 | 需要对照的场景 |
| --- | --- | --- |
| 模型可以调用的工具，包括网页搜索、MCP、技能工具、后台命令 | [工具注册与执行](src/tools/index.ts)、[任务权限](src/orchestration/runContext.ts)、[审批结果](src/runtime/toolCoordinator.ts) | 对照三档权限、模型关闭工具、角色与计划模式的只读限制；网页搜索审批展示查询内容和接收方，发送前复核所选服务。用户或自动审核拒绝后，核对真实副作用、界面和自动续跑。 |
| 对话、队列、侧聊、目标、计划、子助手 | [任务入口](src/orchestration/sessionController.ts)、[续做判断](src/orchestration/runResume.ts)、[子助手](src/orchestration/subagents/controller.ts)、[关联窗口](src/interaction/conversationViews.ts) | 比较新建、转交、编辑、重新打开和停止，核对模型、资料授权、技能范围和历史摘要。删除主聊天时验证提醒、关联窗口和草稿，并验证另一段聊天不受影响。 |
| 模型请求、自动审核或摘要 | [模型服务](src/communication/providers.ts)、[辅助请求用量](src/orchestration/meteredService.ts) | 核对实际目的地、模型设置、取消、用量归属。额外请求也要计数，复用已存结果时不新增用量；测试用本地替身。结构化输出和原生搜索逐字段使用当前连接的本地资料和显式覆盖。JSON Schema 只作用于指定请求，原生搜索只随有资格的普通聊天请求发送。原生视频只读取本轮明确选择且仍有权访问的附件，按已接通的协议发送。图片能力按当前连接及显式覆盖解析。只发送当前任务明确附加的图片和可用的工具图片，工具发起的网络图片读取遵循现有审批。剪贴板和工具图片保存到当前库的缓存，历史记录仅保存引用。 |
| 模型连接协议和地址 | [连接解析](src/communication/modelConnection.ts)、[模型服务](src/communication/providers.ts)、[模型资料](src/orchestration/storage/modelCatalogStore.ts) | 模型设置、测试连接和实际请求使用同一解析结果。模型覆盖优先于服务商覆盖，换协议时只继承匹配的地址。固定 JSON Schema 和视频输入分别按模型和接口读取本地能力资料。区分模型目录、兼容连接、手动配置与未确认，信息不足时禁止发送。OpenCode 只自动使用当前套餐的官方地址。运行中目录改变实际连接时，在下一次发送前拦截。 |
| 独立视频解析 | [任务入口](src/orchestration/sessionController.ts)、[视频解析](src/orchestration/context/videoAnalysis.ts)、[辅助请求用量](src/orchestration/meteredService.ts) | 本地文件和公开直链分别选择已启用的连接，发送前复核接收地址。只接受链接的连接直接接收 HTTPS 视频地址，允许文件的连接按已验证的规格转码。逐个视频收到服务端输入回执后才交付带时间戳的结果。缺少回执、转码或解析失败时停止主模型请求并说明原因。续做复用已存结果和来源范围，避免重复发送和计费。 |
| 服务商启停和默认模型 | [模型可用范围](src/orchestration/settings/modelAvailability.ts)、[聊天模型列表](src/interaction/useChatModel.ts)、[任务入口](src/orchestration/sessionController.ts) | 多个服务商可同时启用，聊天默认模型独立选择。停用不删除配置，影响新请求和续做，已经运行的任务继续使用原模型。默认模型不可选时从其余可用模型中选择。 |
| 新设置、历史记录、技能依赖、模型资料或临时输出 | [存储约定](#插件数据存储)、[技能目录](src/orchestration/context/skills.ts)、[MCP 服务状态](src/tools/external/mcp.ts) | 核对谁写、谁读、其他入口何时看到变更，以及停用、清理和重开后的行为。旧记录缺少新字段时须能安全恢复。模型资料在启动和手动更新时刷新，获取模型只读本地资料。 |

每次交付按受影响的规则执行以下检查。

1. 列出这次改动受哪些共同规则约束，以及哪些入口能触发它。同一决定交给已有的执行或存储入口，按钮和提示文字只负责展示。
2. 为有行为变化的交叉点留下一个能暴露旧问题的自动测试。从真实入口观察结果，既覆盖应当成功的场景，也覆盖应当拒绝、暂停或保留旧数据的场景。新增测试按现有方式命名为 `*.test.ts` 或 `*.test.tsx`，会被自动发现。
3. 交付前运行 `npm test`、`npm run lint` 和 `npm run build`。涉及存储时另按下节核对恢复。说明验证到了哪里，列出因平台或外部服务未能实测的部分。
4. 改变跨功能规则时，同步更新本表对应条目、面向用户的说明和交叉测试。其他智能体的说明文件只指回此处。

## 插件数据存储

这条规则适用于所有贡献者和编程智能体。新增或修改功能时，按以下约定保存插件自行管理的运行时数据。

- 插件安装目录下的 `data.json` 只保存 `storageVersion`。`loadData()` 和 `saveData()` 由现有迁移入口使用，负责读旧设置和读写存储版本。
- 其他需要落盘的数据统一保存到**当前笔记库的 `.scribe-ai/`**。复用现有存储服务和[统一路径入口](src/orchestration/storage/paths.ts)。设置和命令预设放 `settings.json`，本机界面和会话权限状态放 `state.json`，对话相关记录放 `conversations/`，技能放 `skills/`，工具输出缓存放 `cache/`。
- 模型资料保存在 `cache/model-catalog.json`。刷新优先使用当前连接的官方目录，官方目录不可用时查 Pi 或内置目录。名单和能力字段独立更新。使用同一地址和协议的公开资料逐字段补齐，记录来源和核对时间。明确的否定与资料缺失分开处理，保留同一连接已保存的更可靠字段。
- 禁止把新增的插件数据另存到库根目录、插件安装目录、系统临时目录或浏览器与 Obsidian 的本机存储中。旧位置仅用于兼容读取和清理。真正的密钥、登录令牌由 Obsidian 密钥库保管。Obsidian 自己保存的布局，以及用户指定写入的笔记、导出和共享文件，按各自的保存约定处理。
- 存储改动须通过 `npm run lint`，并在测试库核对写入位置和重新打开后的恢复。涉及迁移时，先核对已有数据能在新位置恢复，确认后才清理旧副本。

## Environment & tooling

- Node.js: 22.19 or newer (current LTS recommended).
- **Package manager: npm** (required for this project - `package.json` defines npm scripts and dependencies).
- **Bundler: esbuild** (required for this project - `esbuild.config.mjs` and build scripts depend on it). Alternative bundlers like Rollup or webpack are acceptable for other projects if they bundle all external dependencies into `main.js`.
- Types: `obsidian` type definitions.

**Note**: This project has specific technical dependencies on npm and esbuild. Switching to a different toolchain means replacing the build configuration accordingly.

### Install

```bash
npm install
```

### Dev (watch)

```bash
npm run dev
```

### Production build

```bash
npm run build
```

## Linting

- ESLint is preconfigured with `eslint-plugin-obsidianmd` for Obsidian-specific rules.
- Run `npm run lint` to lint the project.
- A GitHub Action automatically lints every commit on all branches.

## File & folder conventions

- **Organize code into multiple files**: Split functionality across separate modules rather than putting everything in `main.ts`.
- Source lives in `src/`. Keep `main.ts` small and focused on plugin lifecycle (loading, unloading, registering commands).
- **Example file structure**:
  ```
  src/
    main.ts           # Plugin entry point, lifecycle management
    settings.ts       # Settings interface and defaults
    commands/         # Command implementations
      command1.ts
      command2.ts
    ui/              # UI components, modals, views
      modal.ts
      view.ts
    utils/           # Utility functions, helpers
      helpers.ts
      constants.ts
    types.ts         # TypeScript interfaces and types
  ```
- **Do not commit build artifacts**: Never commit `node_modules/`, `main.js`, or other generated files to version control.
- Keep the plugin small. Avoid large dependencies. Prefer browser-compatible packages.
- Generated output should be placed at the plugin root or `dist/` depending on your build setup. Release artifacts must end up at the top level of the plugin folder in the vault (`main.js`, `manifest.json`, `styles.css`).

## Manifest rules (`manifest.json`)

- Must include (non-exhaustive):
  - `id` (plugin ID; for local dev it should match the folder name)
  - `name`
  - `version` (Semantic Versioning `x.y.z`)
  - `minAppVersion`
  - `description`
  - `isDesktopOnly` (boolean)
  - Optional: `author`, `authorUrl`, `fundingUrl` (string or map)
- Never change `id` after release. Treat it as stable API.
- Keep `minAppVersion` accurate when using newer APIs.
- Canonical requirements are coded here: <https://github.com/obsidianmd/obsidian-releases/blob/master/.github/workflows/validate-plugin-entry.yml>

## Testing

- Manual install for testing: copy `main.js`, `manifest.json`, `styles.css` (if any) to:
  ```
  <Vault>/.obsidian/plugins/<plugin-id>/
  ```
- Reload Obsidian and enable the plugin in **Settings → Community plugins**.

## Commands & settings

- Any user-facing commands should be added via `this.addCommand(...)`.
- If the plugin has configuration, provide a settings tab and sensible defaults.
- 保存设置时遵守上方的[插件数据存储规则](#插件数据存储)。
- Use stable command IDs; avoid renaming once released.

## Versioning & releases

- Bump `version` in `manifest.json` (SemVer) and update `versions.json` to map plugin version → minimum app version.
- Create a GitHub release whose tag exactly matches `manifest.json`'s `version`. Do not use a leading `v`.
- Attach `manifest.json`, `main.js`, and `styles.css` (if present) to the release as individual assets.
- After the initial release, follow the process to add/update your plugin in the community catalog as required.

## Security, privacy, and compliance

Follow Obsidian's **Developer Policies** and **Plugin Guidelines**. In particular:

- Default to local/offline operation. Only make network requests when essential to the feature.
- No hidden telemetry. If you collect optional analytics or call third-party services, require explicit opt-in and document clearly in `README.md` and in settings.
- Never execute remote code, fetch and eval scripts, or auto-update plugin code outside of normal releases.
- Minimize scope: read/write only what's necessary inside the vault. Do not access files outside the vault.
- Clearly disclose any external services used, data sent, and risks.
- Respect user privacy. Do not collect vault contents, filenames, or personal information unless absolutely necessary and explicitly consented.
- Avoid deceptive patterns, ads, or spammy notifications.
- Register and clean up all DOM, app, and interval listeners using the provided `register*` helpers so the plugin unloads safely.

## UX & copy guidelines (for UI text, commands, settings)

- Prefer sentence case for headings, buttons, and titles.
- Use clear, action-oriented imperatives in step-by-step copy.
- Use **bold** to indicate literal UI labels. Prefer "select" for interactions.
- Use arrow notation for navigation: **Settings → Community plugins**.
- Keep in-app strings short, consistent, and free of jargon.

## Performance

- Keep startup light. Defer heavy work until needed.
- Avoid long-running tasks during `onload`; use lazy initialization.
- Batch disk access and avoid excessive vault scans.
- Debounce/throttle expensive operations in response to file system events.

## Coding conventions

- TypeScript with `"strict": true` preferred.
- **Keep `main.ts` minimal**: Focus only on plugin lifecycle (onload, onunload, addCommand calls). Delegate all feature logic to separate modules.
- **Split large files**: If any file exceeds ~200-300 lines, consider breaking it into smaller, focused modules.
- **Use clear module boundaries**: Each file should have a single, well-defined responsibility.
- Bundle everything into `main.js` (no unbundled runtime deps).
- Avoid Node/Electron APIs if you want mobile compatibility; set `isDesktopOnly` accordingly.
- Prefer `async/await` over promise chains; handle errors gracefully.

## Mobile

- Where feasible, test on iOS and Android.
- Don't assume desktop-only behavior unless `isDesktopOnly` is `true`.
- Avoid large in-memory structures; be mindful of memory and storage constraints.

## Agent do/don't

**Do**

- Add commands with stable IDs (don't rename once released).
- Provide defaults and validation in settings.
- Write idempotent code paths so reload/unload doesn't leak listeners or intervals.
- Use `this.register*` helpers for everything that needs cleanup.

**Don't**

- Introduce network calls without an obvious user-facing reason and documentation.
- Ship features that require cloud services without clear disclosure and explicit opt-in.
- Store or transmit vault contents unless essential and consented.

## Common tasks

### Organize code across multiple files

[插件入口](src/main.ts)负责生命周期，配置默认值和校验集中在[设置模块](src/orchestration/settings/defaults.ts)。

**commands/index.ts**:

```ts
import { Plugin } from 'obsidian';
import { doSomething } from './my-command';

export function registerCommands(plugin: Plugin) {
 plugin.addCommand({
  id: 'do-something',
  name: 'Do something',
  callback: () => doSomething(plugin),
 });
}
```

### Add a command

```ts
this.addCommand({
 id: 'your-command-id',
 name: 'Do the thing',
 callback: () => this.doTheThing(),
});
```

### Persist settings

一般设置复用插件的 `saveSettings()`，命令预设和 MCP 使用现有的专用保存入口。这些入口共同使用[存储服务](src/orchestration/storage/pluginStorage.ts)，将配置保存到 `.scribe-ai/settings.json`。

### Register listeners safely

```ts
this.registerEvent(
 this.app.workspace.on('file-open', (f) => {
  /* ... */
 }),
);
this.registerDomEvent(activeWindow, 'resize', () => {
 /* ... */
});
this.registerInterval(
 window.setInterval(() => {
  /* ... */
 }, 1000),
);
```

## Troubleshooting

- Plugin doesn't load after build: ensure `main.js` and `manifest.json` are at the top level of the plugin folder under `<Vault>/.obsidian/plugins/<plugin-id>/`.
- Build issues: if `main.js` is missing, run `npm run build` or `npm run dev` to compile your TypeScript source code.
- Commands not appearing: verify `addCommand` runs after `onload` and IDs are unique.
- 设置未保存时，检查是否等待了现有保存入口完成，以及界面是否在成功后刷新。
- Mobile-only issues: confirm you're not using desktop-only APIs; check `isDesktopOnly` and adjust.

## References

- Obsidian sample plugin: <https://github.com/obsidianmd/obsidian-sample-plugin>
- API documentation: <https://docs.obsidian.md>
- Developer policies: <https://docs.obsidian.md/Developer+policies>
- Plugin guidelines: <https://docs.obsidian.md/Plugins/Releasing/Plugin+guidelines>
- Style guide: <https://help.obsidian.md/style-guide>

# Ponytail, lazy senior dev mode

You are a lazy senior developer. The best code is the code never written. You solve the whole problem with the least new code. End your reply with one or two lines: what you skipped or did not check, and any risk the user must know.

## Before you write

Read the task and the code it touches. List every place your change must reach: callers, tests, fixtures, config, exports. Check what your change could break for users: data it would destroy or expose, callers that stop working. That is scope. Extra features are not.

## The smallest complete change

Take the first option that fully works:

1. Does it need to exist? Skip features, options and flexibility nobody asked for, and name them in one line. A vague request ("build me X") gets the smallest version that does the core job.
2. Already in this codebase (a helper, component, service, pattern)? Use it the way the surrounding code does.
3. Standard library or a platform feature? Use it, unless the project has its own. A house component beats a native widget.
4. An installed dependency? Use it. Never add a dependency for a few lines.
5. Can it be one line a reader gets at a glance? One line.
6. Otherwise: the minimum code that works.

- Be lazy about the solution, never about the change itself: finish every part the task needs, including the callers, tests and fixtures your change breaks.
- No abstraction, wrapper, type conversion, option, config, boilerplate or "for later" code nobody asked for. Keep values in the form the platform already gives you. Deletion beats addition. Keep the structure the codebase already has: its layers, interfaces and conventions.
- The shortest working diff wins, once you know everything it must touch. A one-liner that needs decoding is not short.
- Comment only the why the code cannot show, in one line.
- Bug fix: before you edit, grep every caller of the function you touch, then fix the root cause once in the shared code.
- Code you move or merge keeps its error handling and validation.
- Between options of equal size, take the one that is correct on edge cases.
- Lazy code without its check is unfinished: new non-trivial logic (a branch, a loop, a parser, money or security, or a whole new script or app) leaves one small test or an assert-based self-check. Trivial changes need none.
- A shortcut with a known limit gets a code comment in this form: `shortcut: <the limit>, <when to upgrade>`.

Never cut: validation at trust boundaries, error handling that prevents data loss, security, accessibility, the calibration real hardware needs, anything the user asked for.

(Yes, this file also applies to agents working on the ponytail repo itself. Especially to them.)

## 构建与测试库同步

- `npm run build` 会在类型检查与打包成功后，把 `main.js`、`manifest.json`、`styles.css`（存在时）复制到测试库 `~/Desktop/Scribe/.obsidian/plugins/scribe-ai/`；`data.json` 不会被改动。
- 编码 Agent 完成任务后必须重新构建一次（Pi 里由 `.pi/extensions/rebuild-after-task.ts` 在每轮结束时自动执行）。
