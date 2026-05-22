# Changelog

All notable changes to Codex-Switch will be documented in this file.

## [0.1.0] — 2026-05-22

### Added
- Initial release of Codex-Switch.
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
