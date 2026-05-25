# Changelog

All notable changes to Codex-Bridge will be documented in this file.

## [1.3.0] — 2026-05-25

### Added
- **Model fallback page** — New dedicated sidebar page "Model Fallback" between Providers and Settings. Select a configured model to automatically handle requests for unconfigured models (e.g. `gpt5.4-mini`), preventing Codex retry loops.

### Changed
- **LAN access toggle** — Replaced listen address radio buttons with a single toggle switch and help-tip tooltip for a cleaner UI.

### Fixed
- **Provider edit/delete buttons unresponsive** — Restored missing `.btn-edit` and `.btn-delete` event bindings in `bindProviderActions()`.

## [1.2.0] — 2026-05-24

### Added
- **key/modelId routing** — Provider-level `key` field (auto-generated from name with ZH→EN mapping) enables `key/modelId` format routing (e.g. `GLM/glm-5.1`), eliminating model name conflicts across providers.
- **Multi-model per provider** — Each provider supports a `models[]` array with per-model `maxOutputK` and `maxContextK` settings, replacing the single `model` field.
- **Quickstart dual-mode** — Quick Start page now shows two usage modes: Mode A (cc-switch + API Key) and Mode B (direct config.toml + ChatGPT account), with auto-generated config templates.
- **Clickable model selector** — Available models on Quick Start page are selectable tags; selecting a model auto-updates all config templates and test commands.
- **Trace Mode** — Settings toggle that records every request's raw upstream SSE stream and proxy output to disk (`trace/YYYY-MM-DD/HHmmss_model_{req,raw,out}.*`), enabling pixel-level protocol comparison and debugging without external tools.
- **Inline thinking-tag parser** — Streaming state machine in both adapters detects `<thinking>`, `<<H>>`, `<thought>`, `<reasoning>` tags inside text content (used by GLM and similar Chinese LLMs) and routes tagged content to proper reasoning events instead of leaking it to the display.
- **Markdown-aware tag parser** — Thinking-tag parser tracks backtick code spans/blocks to avoid false positives on literal `<thinking>` text inside markdown.
- **Legacy `function_call` fallback** — Both adapters now support the older single `function_call` delta format used by some Chinese LLMs, in addition to the standard `tool_calls` array.
- **DeepSeek `user_id` passthrough** — Provider-level `userId` field passes through as `user_id` (OpenAI Chat) or `metadata.user_id` (Anthropic) for account-level KVCache and safety isolation.
- **LAN access toggle** — Settings page toggle switch to enable LAN access (binds `0.0.0.0` instead of `127.0.0.1`); Quick Start page shows hint about using machine IP for LAN devices.

### Changed
- **Removed `active` provider concept** — Routing is now purely request-based (`key/modelId`); no more "set as current" button or active badge.
- **Provider data migration** — `loadProviders()` auto-migrates old `{ model: "xxx" }` format to `{ models: [{ id: "xxx" }] }` and generates `key` for providers without one.
- **Thinking parser conditional skip** — OpenAI Chat adapter skips the thinking-tag parser when upstream sends `reasoning_content` field, preventing false-positive truncation on providers like GLM-5.1.
- **Anthropic adapter** — `max_tokens` defaults to 65536 (from 8192) to prevent long response truncation; removed `ThinkingTagStreamParser` from `text_delta` processing.
- **Tool call start events** — Now deduplicated via a `started` flag to prevent redundant SSE emissions.
- **`/v1/models` endpoint** — Returns models in `key/modelId` format.
- **Tray menu** — Providers shown as `Name (key)` without radio button selection.

### Fixed
- **Response truncation on OpenAI Chat** — Thinking-tag parser no longer misidentifies literal `<thinking>` text in markdown content as thinking tags (Layer A: skip when `reasoning_content` present; Layer B: backtick-aware parsing).
- **Error path test model IDs** — Fixed `test/error-paths.js` using `key/modelId` in provider model config instead of plain model ID.

## [0.1.1] — 2026-05-23

### Added
- **厂商预设系统** — `src/proxy/presets/` 注册表架构：DeepSeek 等厂商内置专属优化（reasoning 回传、双协议端点自动切换）。新厂商只需添加数据条目 + 可选钩子，不碰通用适配器。
- **请求日志** — orchestrator 层记录每次请求（模型、协议、流模式、成功/失败），实时推送到 UI 日志面板。
- **更新检查** — 关于页面可手动检查 GitHub Releases 获取最新版本。
- **供应商显示名称** — Codex 中 provider 显示为「供应商名 (Codex-Bridge)」，明确代理来源。

### Changed
- **代理启动流程** — 移除自动启动和自动重启；侧边栏新增一键启动/停止按钮；供应商变更后自动停止代理并闪烁按钮提醒。
- **预设按钮** — 添加供应商对话框改为动态预设列表，支持协议模板（OpenAI 兼容、Anthropic 兼容）和厂商预设（DeepSeek）。
- **设置精简** — 移除「思考可见性」和「自动启动代理」选项。
- **侧边栏文案** — 缩短 footer 文本，避免换行。

### Fixed
- **版本号显示** — 打包后关于页面显示 v0.1.0 的问题，改用 `app.getVersion()`。
- **代理状态卡在"启动中"** — `createProxyServer` 改为 Promise，在 `listen` 回调 resolve。
- **供应商连接测试 404** — 测试改为协议感知：Anthropic 用 POST `/v1/messages`，OpenAI 用 GET `/models`。
- **Codex 显示 "custom"** — config.toml 注入改用顶层 key 替换，处理 TOML first-wins 语义。

## [0.1.0] — 2026-05-22

### Added
- Initial release of Codex-Bridge.
- OpenAI Chat Completions protocol adapter with SSE streaming support.
- Anthropic Messages protocol adapter with extended thinking and tool use support.
- Provider management (add, edit, delete, activate, test connection).
- One-click preset providers: OpenAI, Anthropic, DeepSeek, Groq, Together.
- System tray with provider switching and proxy controls.
- Codex config.toml injection and auth.json management.
- Multi-language support (Chinese and English).
- Dark, light, and system-follow theme options.
- Windows (NSIS installer), macOS (DMG/zip), and Linux (AppImage/deb) builds.
- Cross-platform Electron desktop shell with context isolation and sandbox.
- Structured logger with level filtering and IPC forwarding to UI.
- SSE stream parser shared module.
- CI workflow (syntax check + tests + audit) and build workflow (3-platform release).
- Community files: CONTRIBUTING.md, SECURITY.md, CODE_OF_CONDUCT.md, issue/PR templates.

### Fixed
- Multimodal content (images) now properly forwarded to both OpenAI and Anthropic adapters.
- System-role messages in input array correctly extracted for Anthropic top-level system field.
- Anthropic thinking budget overflow (Math.max → Math.min) and raised cap to 32000 tokens.
- Stream interruption detection in both adapters (emit error instead of false completed event).
- SSE bridge write-after-end guard to prevent crashes on closed connections.
- Model aliases in Codex config.toml now map to actual provider model ID.
- Sync error responses now proxy upstream HTTP status code instead of always returning 502.
- `/v1/models` endpoint returns all configured provider models.
- Proxy server stop now force-closes connections with 3-second timeout fallback.
- Log pipeline wired: backend logger → IPC → UI log viewer.
- Error handling added to UI init, settings save, and Codex config injection handlers.
