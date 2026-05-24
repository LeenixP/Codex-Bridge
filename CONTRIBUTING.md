# Contributing to Codex-Bridge

Thanks for your interest in contributing!

## Setup

```bash
git clone https://github.com/LeenixP/Codex-Bridge.git
cd Codex-Bridge
npm install
```

## Development

```bash
npm start            # Launch the Electron app
npm run check        # Syntax validation (all source files)
npm test             # Run all integration tests
npm run lint         # ESLint code quality check
npm run format       # Auto-format with Prettier
npm run format:check # Check formatting without modifying files
npm run icons        # Regenerate icon assets
npm run dist:win     # Build Windows installer
npm run dist:linux   # Build Linux packages
npm run dist:mac     # Build macOS packages
```

## Code Style

- `"use strict"` in all modules.
- Keep modules focused on a single responsibility.
- Follow existing adapter pattern for new protocols: export `buildUpstreamRequest`, `streamUpstream`, `callUpstream`.
- Use the shared logger (`src/shared/logger.js`) instead of `console.log`.
- Run `npm run lint` and `npm run format:check` before committing.

## Pull Request Process

1. Fork the repo and create a branch from `main`.
2. Make your changes. Add tests for new functionality.
3. Run `npm run check`, `npm test`, and `npm run lint` before pushing.
4. Write a clear PR description explaining what and why.
5. Keep changes focused — one feature or fix per PR.

## Adding a New Provider Preset

Presets let you pre-configure a vendor's API endpoint and add vendor-specific behavior without touching the generic adapters. Add presets in `src/proxy/presets/index.js`.

Adding a simple preset (no special behavior):

```js
"ali-bailian": {
  id: "ali-bailian",
  name: "阿里百炼",
  protocol: "openai-chat",
  baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
  features: {},
},
```

Adding a preset with special behavior:

```js
"deepseek": {
  id: "deepseek",
  name: "DeepSeek",
  protocol: "openai-chat",
  baseUrl: "https://api.deepseek.com/v1",
  variants: {
    "openai-chat": "https://api.deepseek.com/v1",
    anthropic: "https://api.deepseek.com/anthropic",
  },
  features: {
    reasoningPassthrough: true,
  },
  hooks: {
    onMessagesBuilt(messages, requestBody, provider) {
      // Transform messages before sending to upstream
      return messages;
    },
  },
},
```

The preset will automatically appear in the "Quick Add" buttons in the Add Provider dialog.

## Adding a New Protocol Adapter

1. Create a new file in `src/proxy/adapters/`.
2. Export three functions matching the adapter contract:
   - `buildUpstreamRequest(requestBody, provider, settings)` — converts Responses API input to upstream format
   - `streamUpstream(upstreamPayload, provider, emit)` — streams from upstream, emits SSE events via callback
   - `callUpstream(upstreamPayload, provider)` — non-streaming request, returns `{ text, reasoning, toolCalls, usage }`
3. Register the adapter in `src/proxy/core/orchestrator.js` (`resolveAdapter` function).
4. Add integration tests in `test/`.
5. See `src/proxy/adapters/openai-chat.js` and `src/proxy/adapters/anthropic.js` for reference implementations.

## Release Process

Releases are created **manually** — there is no automated build-and-publish pipeline.

1. Update the version in `package.json`.
2. Update `CHANGELOG.md` with the new version's changes. Use the format:

   ```markdown
   ## [X.Y.Z] — YYYY-MM-DD

   ### Added
   - New feature A
   - New feature B

   ### Changed
   - Improved X to do Y

   ### Fixed
   - Bug in Z when W happens
   ```

3. Build platform packages locally:

   ```bash
   npm run dist:win     # Windows: Setup exe
   npm run dist:linux   # Linux: AppImage + deb (x64, arm64)
   npm run dist:mac     # macOS: dmg + tar.gz + zip (universal)
   ```

4. Go to [GitHub Releases](https://github.com/LeenixP/Codex-Bridge/releases) and click **Draft a new release**.
5. Create a tag (e.g., `v0.2.0`) and set the release title.
6. Copy the relevant section from `CHANGELOG.md` as the release description.
7. Upload the built packages from `dist/`.
8. Publish the release.

The `dist/` directory is git-ignored — built packages are not committed to the repository.
