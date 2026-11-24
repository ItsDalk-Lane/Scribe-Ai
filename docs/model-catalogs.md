# 模型目录核对

核对日期为 2026 年 11 月 24 日。下表涵盖 Scribe Ai 的 49 个预置连接，包括 Pi 内置的 43 个服务商和 Scribe Ai 预置的 6 个套餐。匿名实测只读取了目录。需要登录的目录依据官方文档、服务商源码或未登录响应核对，实际账户可见的清单仍需用对应账户验证。

插件启动或点击 **更新模型数据** 时，会先查询各服务商的官方目录，按返回的下一页链接、游标或页码继续获取。成功时以官方名称清单为准，用内置 Pi 资料和 Models.dev 补充缺失的能力信息。如果官方目录取不到，会读取共享 Pi 目录，再用对应服务商或套餐的内置资料兜底。同一连接已有更可靠的本地清单时，刷新失败会保留旧清单。点击 **获取模型** 只读本地资料。刷新只读取目录，使用对应连接的访问凭据。模型能否调用仍由服务商、账号权限和现有接入方式决定。[Pi 模型目录](https://docs.pi.dev/latest/models) · [Models.dev](https://models.dev/)

目录补充按实际服务地址、兼容协议和原始模型 ID 匹配。Kimi Code 国内、Qwen 个人版国内与国际、智谱 Coding Plan 国内、Together AI 和 Fireworks 的 Chat 连接使用各自对应的公开资料。Fireworks 的 Messages 连接使用独立的能力证据。结构化输出需要 JSON Schema 的接口依据，目录中未细分的 JSON 能力单独保存。同一连接的官方资料冲突时，配置项显示冲突并等待明确设置。打开模型配置可查看能力来源和核对时间。 [Kimi Code 模型表](https://www.kimi.com/code/docs/en/kimi-code/models.html) · [Together 能力表](https://docs.together.ai/docs/serverless/models) · [Fireworks JSON Schema](https://docs.fireworks.ai/structured-responses/structured-response-formatting)

## 固定 JSON Schema 和视频输入

配置界面从当前库的模型资料逐项读取结构化输出和视频输入能力。换模型、协议或地址时，对应能力随之更新，已经手动设置的字段仍优先。只有 Agent 为本次请求提交 Schema 时，接口才会约束最终答复的字段和类型。

| 产品和接口 | 本次补充的能力 |
| --- | --- |
| 智谱中国 Coding Plan Chat Completions | `glm-5.3-flash` 支持固定 Schema 和 HTTPS 视频，已使用测试库的套餐账号实测。 |
| OpenCode Zen Generate Content | `gemini-4-argon` 支持固定 Schema 和本地 MP4，已使用 Zen 账号实测。 |
| Groq 和 Cerebras Chat Completions | Groq 按官方严格模式清单启用 Schema，只在 Schema 请求时使用非流式调用。Cerebras 的官方目录按模型报告固定 Schema。 [Groq 固定 Schema](https://console.groq.com/docs/structured-outputs) · [Cerebras 公共目录](https://api.cerebras.ai/public/v1/models) |
| Bedrock、Azure、Google Vertex | Bedrock Converse 按 Claude 型号和地域推理 ID 支持 Schema，Nova Lite、Pro 接收本地视频。Azure 按资源地址和模型识别 Schema。Vertex 按 Gemini 型号启用 Schema。 [AWS 型号和接口](https://docs.aws.amazon.com/bedrock/latest/userguide/models-at-a-glance.html) · [Azure 固定 Schema](https://learn.microsoft.com/en-us/azure/foundry/openai/how-to/structured-outputs) · [Vertex 固定 Schema](https://docs.cloud.google.com/gemini-enterprise-agent-platform/models/capabilities/control-generated-output) |
| 月之暗面开放平台、Meta、Mistral | 月之暗面国内及国际的 `kimi-k3` 和 `kimi-k3.1-pro` 接通 Schema 与 Chat 视频，两款的 Responses 也接通 Schema。Meta `muse-spark-1.3` 的 Chat 接通 Schema，Responses 接通视频。Mistral 的已确认型号通过 Chat Completions 接通 Schema。 [月之暗面固定 Schema](https://platform.kimi.com/docs/guide/response_format) · [月之暗面 Responses](https://platform.kimi.com/docs/api/responses) · [Meta 固定 Schema](https://dev.meta.ai/docs/structured-output) · [Mistral 固定 Schema](https://docs.mistral.ai/inference/conversations/structured-output/custom) |
| NVIDIA、MiMo、百炼、火山方舟 | NVIDIA 的 `moonshotai/kimi-k2.6`、`moonshotai/kimi-k3.1-pro`，MiMo 按量 `v2.6` 的三款确认型号，百炼 Token Plan 的 `qwen3.8-flash`，以及方舟按量 `doubao-seed-2-1-pro-260915` 接通资料匹配的原生视频接口。北京百炼 Token Plan 另包含 `qwen4-max-preview` 预览期内的 Schema 和视频输入。 [NVIDIA](https://docs.api.nvidia.com/nim/reference/moonshotai-kimi-k3_1-pro) · [小米 MiMo](https://mimo.mi.com/docs/zh-CN/quick-start/usage-guide/multimodal-understanding/video-understanding) · [百炼视频示例](https://help.aliyun.com/en/model-studio/token-plan-playbook-video-digest) · [百炼预览版](https://help.aliyun.com/zh/model-studio/qwen4-max-preview) · [火山方舟](https://docs.volcengine.com/docs/ark/video-understanding) |
| Vercel AI Gateway、Hugging Face | Vercel Anthropic Messages 的 `anthropic/claude-sonnet-5` 支持 Schema。Hugging Face 的 `deepseek-ai/DeepSeek-V4.1-Flash` 使用 Responses Schema，`Qwen/Qwen3-32B` 通过 Cerebras 专用 Chat 地址使用 Schema。 [Vercel 固定 Schema](https://vercel.com/docs/ai-gateway/sdks-and-apis/anthropic-messages-api/structured-outputs) · [Hugging Face Responses](https://huggingface.co/docs/inference-providers/main/guides/responses-api) · [Hugging Face Cerebras](https://huggingface.co/docs/inference-providers/guides/structured-output) |

测试库已配置智谱和 OpenCode Zen 凭据。OpenCode Zen 的 `gpt-5.4` 请求因工作区禁用模型返回 HTTP 403，Bedrock 在该库没有已关联凭据。表中其余连接根据官方模型和接口资料核对，主要请求格式通过本地替身验证。

## 已匿名取得的官方目录

下列数量是核对当天的快照。公开目录与账户可用范围可能不同，添加模型时会筛除能确认属于嵌入、语音合成、转录或其他非聊天用途的条目。

| 预置服务商 | 本次核对结果 |
| --- | --- |
| OpenCode Zen（`opencode`）、OpenCode Go（`opencode-go`） | 各自查询 `/inference/v1/models` 和 `/inference/go/v1/models`。匿名取得 Zen 的 82 个和 Go 的 31 个聊天模型。使用对应凭据时返回账户可用范围。[官方模型列表](https://opencode.ai/docs/console/api/models/#inference-model-lists) |
| OpenRouter（`openrouter`） | 公开 `/api/v1/models` 返回 474 项，已验证下一页链接。有可用凭据时优先查 `/api/v1/models/user`，以账号权限和限制为准。[公开目录](https://openrouter.ai/docs/api/api-reference/models/get-models) · [账号目录官方 SDK](https://github.com/OpenRouterTeam/python-sdk/blob/main/docs/sdks/models/README.mdx#list_for_user) |
| Vercel AI Gateway（`vercel-ai-gateway`） | 公开 `/v1/models` 返回 518 项，按语言类型查询返回 321 项。[Vercel 官方参考](https://github.com/vercel-labs/open-agents/blob/main/.agents/skills/ai-sdk/references/ai-gateway.md) |
| Hugging Face（`huggingface`） | 官方 Router `/v1/models` 返回 159 项，官方说明该目录面向聊天模型。[官方目录说明](https://huggingface.co/docs/inference-providers/hub-api) |
| NVIDIA（`nvidia`） | `/v1/models` 匿名返回 32 项。目录混有专用模型，多数条目未标注用途，显示范围取决于已确认的类型资料。[官方模型参考](https://docs.api.nvidia.com/nim/reference/llm-apis) |
| Cerebras（`cerebras`） | `/public/v1/models` 匿名返回 2 项。已连接密钥时查询 `/v1/models`，账户范围仍需登录核对。[官方公开目录](https://inference-docs.cerebras.ai/api-reference/models/public-models) |
| 百炼 Coding Plan（`bailian-coding-plan`） | 套餐地址 `/v1/models` 匿名返回 6 项，服务器返回 `hasMore: false`。官方常见问题仍说明该套餐不保证提供目录 API，查询失败时使用套餐内置资料。[官方套餐说明](https://help.aliyun.com/zh/model-studio/coding-plan) · [官方常见问题](https://help.aliyun.com/en/model-studio/coding-plan-faq) |
| Radius（`radius`） | `/v1/config` 匿名返回 39 个已启用的模型，另列 7 个分类器。目录按当前网关的配置返回。[Pi 官方说明](https://docs.pi.dev/latest/providers#radius) |

## 已接通的常规目录

以下目录使用各自服务商或套餐的密钥。命名相近的地区、套餐和产品会按各自的连接查询。

| 预置服务商 | 目录和核对结果 |
| --- | --- |
| 蚂蚁百灵（`ant-ling`） | `/v1/models` 要求 Bearer 密钥。[官方接入说明](https://developer.ant-ling.com/zh-CN/docs/getting-started/quickstart) |
| Anthropic（`anthropic`） | `/v1/models` 使用 `x-api-key` 和 API 版本头，以 `after_id` 翻页。[官方目录](https://platform.claude.com/docs/en/api/models/list) |
| Baseten（`baseten`） | 推理地址 `/v1/models` 要求认证。Baseten 另有工作区目录，可列出启用状态。[官方命令行实现](https://github.com/basetenlabs/baseten-cli/blob/main/internal/cmd/command.model_api.go) |
| DeepSeek（`deepseek`） | `/models` 要求认证。目录可提供上下文、输出上限和推理档位。[官方目录](https://api-docs.deepseek.com/api/list-models/) |
| Fireworks（`fireworks`） | 兼容目录 `/inference/v1/models` 要求 Bearer 密钥，无效路径对照返回 404。另有可按 `pageToken` 翻页的账号目录。[官方账号目录](https://docs.fireworks.ai/api-reference/list-models) |
| Google Gemini（`google`） | `/v1beta/models` 使用 `x-goog-api-key`，按 `nextPageToken` 翻页。读取支持 `generateContent` 的聊天模型。[官方目录](https://ai.google.dev/api/models) |
| Groq（`groq`） | `/openai/v1/models` 要求认证。目录也包含语音专用型号。[官方模型目录](https://console.groq.com/docs/models) |
| Kimi For Coding（`kimi-coding`） | `/coding/v1/models` 使用 Kimi Code 的会员密钥。[官方接入说明](https://www.kimi.com/code/docs/en/) |
| Meta（`meta`） | `/v1/models` 使用 Bearer 密钥，返回当前团队可用模型。官方模型总览区分聊天、图像生成、转录和分割。[官方目录](https://dev.meta.ai/docs/api-reference/models/list-models) · [模型总览](https://dev.meta.ai/docs/models) |
| MiniMax 国际（`minimax`）、MiniMax 中国（`minimax-cn`） | 各自的 `/anthropic/v1/models` 使用 `x-api-key` 和版本头。[官方 Anthropic 兼容说明](https://platform.minimax.io/docs/api-reference/text-anthropic-api) |
| Mistral（`mistral`） | `/v1/models` 使用 Bearer 密钥。目录中的 `completion_chat` 标记可区分聊天模型。[官方目录](https://docs.mistral.ai/api/endpoint/models) |
| Moonshot AI 国际（`moonshotai`）、Moonshot AI 中国（`moonshotai-cn`） | 各自的 `/v1/models` 使用开放平台密钥，一次返回可用模型。[国际目录](https://platform.kimi.ai/docs/api/list-models) · [中国目录](https://platform.kimi.com/docs/api/list-models) |
| OpenAI（`openai`） | `/v1/models` 使用账户密钥。目录也返回嵌入、生成图像和音频等型号，会筛除已知专用型号。[官方目录](https://developers.openai.com/api/reference/resources/models/methods/list) |
| Together（`together`） | `/v1/models` 要求认证，返回的顶层数组可直接读取。[官方 SDK](https://github.com/togethercomputer/together-python/blob/main/src/together/resources/models.py) |
| xAI（`xai`） | `/v1/language-models` 使用 Bearer 密钥，专门提供语言和图像理解模型，也可返回能力和别名。[官方目录](https://docs.x.ai/developers/rest-api-reference/inference/models) |
| 小米 MiMo 按量（`xiaomi`）、Token Plan 阿姆斯特丹（`xiaomi-token-plan-ams`）、中国（`xiaomi-token-plan-cn`）、新加坡（`xiaomi-token-plan-sgp`） | 分别查询各自域名的 `/v1/models`，需要对应密钥。目录也包含独立的语音识别和合成模型。[官方目录](https://mimo.mi.com/docs/en-US/api/model/list-models-get) · [套餐接入说明](https://mimo.mi.com/docs/en-US/tokenplan/Token%20Plan/quick-access) |
| 百炼 Token Plan（`bailian-token-plan`）、Qwen Token Plan 国际（`qwen-token-plan`）、中国（`qwen-token-plan-cn`）、国际个人版（`qwen-token-plan-individual`）、中国个人版（`qwen-token-plan-individual-cn`） | 各地区的 `/compatible-mode/v1/models` 用套餐密钥查询。共享同一域名的个人版和团队版仍由密钥决定可用范围。[官方接口示例](https://help.aliyun.com/en/edge-security-acceleration/esa/user-guide/accelerate-token-plan-or-model-studio-api) |
| 百炼按量（`bailian-payg`） | 默认查按量兼容目录 `/compatible-mode/v1/models`。官方另有工作空间原生目录，支持按文本生成筛选和翻页。[按量地址](https://help.aliyun.com/en/model-studio/base-url) · [原生目录](https://help.aliyun.com/zh/model-studio/list-models) |
| 火山方舟豆包按量（`volcengine-doubao`） | `/api/v3/models` 使用 Bearer 密钥，返回当前账户可见的模型版本和能力资料。[官方目录](https://docs.volcengine.com/docs/ark/models-api?lang=zh) |
| 火山方舟 Agent Plan（`volcengine-agent-plan`）、Coding Plan（`volcengine-coding-plan`） | 分别尝试 `/api/plan/v3/models` 和 `/api/coding/v3/models`。未登录时网关统一要求认证，两个套餐的实际目录仍需对应账号核对。[官方套餐接入说明](https://docs.volcengine.com/docs/ark/coding-plan-personal-ai-codex?lang=zh) |
| 智谱国际 Z.AI（`zai`）、中国 Coding Plan（`zai-coding-cn`） | 各自尝试 `/api/coding/paas/v4/models`，沿用对应地区的套餐密钥。路径参考 CC Switch，账号实际清单仍需核对。[Z.AI 套餐说明](https://docs.z.ai/devpack/overview) · [CC Switch 实现](https://github.com/farion1231/cc-switch/blob/main/src-tauri/src/services/model_fetch.rs) |

## 需要额外账户信息或暂无聊天模型

| 预置服务商 | 官方目录可用的条件 |
| --- | --- |
| Amazon Bedrock（`amazon-bedrock`） | 用同地区的 Bedrock Bearer 密钥查询 `foundation-models?byOutputModality=TEXT`，密钥需有目录读取权限。此目录列出基础模型，账户的跨区推理配置需在 AWS 单独核对。其他类型的凭证走 Pi 或内置目录回退。[官方目录](https://docs.aws.amazon.com/bedrock/latest/APIReference/API_ListFoundationModels.html) |
| Azure OpenAI（`azure`） | 配置 Azure 资源地址和资源密钥后，查询 `/openai/v1/models`。遇到 404 或 405 时尝试旧版目录。目录列出资源可用的模型，自定义部署名称仍以 Azure 资源中的部署为准。[新版目录](https://learn.microsoft.com/en-us/rest/api/microsoft-foundry/azureopenai/models) · [旧版目录](https://learn.microsoft.com/en-us/rest/api/azureopenai/models/list?view=rest-azureopenai-2024-10-21) |
| Cloudflare AI Gateway（`cloudflare-ai-gateway`）、Cloudflare Workers AI（`cloudflare-workers-ai`） | 需要 Cloudflare 账户编号及具备目录读取权限的 API 令牌。Gateway 和 Workers 分别查询 `/ai/catalog/models` 和 `/ai/models/search`，按页取齐。仅具备 AI Gateway 权限的令牌可能无法读取目录。[统一目录官方实现](https://github.com/cloudflare/cloudflare-docs/blob/production/bin/fetch-catalog-models.ts) · [Workers AI 官方目录](https://developers.cloudflare.com/api/resources/ai/subresources/models/methods/list/) |
| GitHub Copilot（`github-copilot`） | 通过已关联的 Copilot 凭据查询对应账号的 `/models`。可选范围受订阅计划和组织策略限制。[GitHub 官方模型说明](https://docs.github.com/en/copilot/reference/ai-models/supported-models) · [Pi 连接说明](https://docs.pi.dev/latest/providers) |
| OpenAI Codex（`openai-codex`） | 通过已关联的 ChatGPT 登录令牌和账号查询 `/backend-api/codex/models`。请求格式参考 CC Switch。[OpenAI Codex 客户端](https://github.com/openai/codex) · [CC Switch 实现](https://github.com/farion1231/cc-switch/blob/main/src-tauri/src/services/codex_oauth_models.rs) |
| Google Vertex AI（`google-vertex`） | `v1beta1/publishers/google/models` 按 `nextPageToken` 翻页。仅在当前连接可提供 Google Cloud OAuth 凭据时查询。Vertex Express API key 实测无法访问此目录，会使用 Pi 或内置资料。[官方目录](https://docs.cloud.google.com/gemini-enterprise-agent-platform/reference/rest/v1beta1/publishers.models/list) |
| TypeSafe（`typesafe`） | 项目现有接入只提供分类模型，聊天模型清单为空。[Pi 模型说明](https://docs.pi.dev/latest/models) |
