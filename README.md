<div align="center">

<img src="assets/banner.png" alt="Codex-Bridge" width="600">

[![CI](https://github.com/LeenixP/Codex-Bridge/actions/workflows/ci.yml/badge.svg)](https://github.com/LeenixP/Codex-Bridge/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Release](https://img.shields.io/github/v/release/LeenixP/Codex-Bridge)](https://github.com/LeenixP/Codex-Bridge/releases)

Codex Desktop / CLI 的本地协议桥接代理 —— 将 OpenAI Chat 和 Anthropic API 转换为 OpenAI Responses 格式，让 Codex 可以使用任意兼容模型。

</div>

## 工作原理

```
Codex Desktop  →  cc-switch  →  Codex-Bridge (localhost:8629)  →  上游 API
                  (配置管理)     (协议桥接 + key/model 路由)      (Chat / Anthropic)
```

Codex-Bridge 在本地监听 Responses API 请求，按 `key/modelId` 路由到对应供应商，将请求转换为上游协议（OpenAI Chat 或 Anthropic），再将响应转回 Responses SSE 事件流。

> **纯代理**：不修改 `~/.codex/` 下的任何文件，所有 Codex 配置由 [cc-switch](https://github.com/RadiaxJ/cc-switch) 管理。

## 快速开始

### 安装

从 [Releases](https://github.com/LeenixP/Codex-Bridge/releases) 下载安装包。

### 三步配置

#### 1. 添加供应商

打开 Codex-Bridge → 供应商页面 → 添加供应商：

| 字段 | 说明 | 示例 |
|------|------|------|
| 协议 | 上游 API 格式 | OpenAI Chat / Anthropic |
| Base URL | 上游 API 地址 | `https://open.bigmodel.cn/api/paas/v4` |
| API Key | 上游密钥 | `your-api-key` |
| 模型 | 可添加多个 | `glm-5.1`（max output 64K） |

保存后系统自动生成 **路由 ID**（如供应商名"智谱" → `GLM`）。

#### 2. 启动代理

点击侧边栏「启动代理」，代理默认监听 `http://localhost:8629/v1`。

> **局域网访问**：在「设置」页面开启「局域网访问」后，局域网设备可通过本机 IP（如 `http://192.168.1.100:8629/v1`）访问代理，本机 localhost 仍可正常使用。

#### 3. 连接 Codex

两种方式任选其一：

**方式 A：配合 cc-switch 使用**（适合第三方 API，API Key 登录）

在 cc-switch 中添加自定义 Provider：

```toml
wire_api = "responses"
base_url = "http://localhost:8629/v1"
model = "GLM/glm-5.1"        # 格式：路由ID/模型名
```

**方式 B：直接编辑 config.toml**（适合 ChatGPT 账号登录，完整功能）

编辑 `~/.codex/config.toml`：

```toml
model_provider = "codex-bridge"
model = "GLM/glm-5.1"
model_reasoning_effort = "high"
disable_response_storage = true
preferred_auth_method = "chatgpt"

[model_providers.codex-bridge]
name = "codex-bridge"
wire_api = "responses"
requires_openai_auth = true
base_url = "http://localhost:8629/v1"

[windows]
sandbox = "elevated"
```

### 多供应商路由

添加多个供应商时，每个供应商有独立的路由 ID，cc-switch 通过模型名路由：

```
GLM/glm-5.1        →  智谱 (OpenAI Chat 协议)
deepseek/deepseek-v4-pro  →  DeepSeek (OpenAI Chat 协议)
anth/claude-sonnet-4-20250514  →  Anthropic (Anthropic 协议)
```

同一个供应商下可配置多个模型，共享 Base URL 和 API Key。

## 功能

- **双协议适配** — OpenAI Chat Completions ↔ Anthropic Messages，均转为 Responses 格式
- **key/modelId 路由** — 按供应商路由 ID + 模型名精确路由，无冲突
- **厂商预设** — DeepSeek（reasoning 回传、双端点切换）、Kimi（Anthropic 协议）等内置优化
- **流式传输** — 完整 SSE 流，支持实时文本、推理过程、工具调用
- **思考过程透传** — `reasoning_content` 字段 + `<thinking>` 内联标签均映射为 Codex reasoning 面板
- **工具调用** — 双向转换 `function_call` ↔ `tool_use`
- **多模态** — 图片输入透传
- **请求追踪** — 实时日志 + `~/.codex-bridge/trace/` 完整请求/响应记录
- **局域网访问** — 开启后局域网设备可通过本机 IP 访问代理
- **系统托盘** — 后台运行，托盘菜单快速操作

## 开发

```bash
npm install       # 安装依赖
npm start         # 启动应用
npm test          # 运行测试（540+ 用例）
npm run lint      # ESLint 检查
npm run format    # Prettier 格式化
npm run dist:win  # 构建 Windows 安装包
```

## 故障排除

| 问题 | 解决方案 |
|------|---------|
| 代理无法启动 | 检查 8629 端口是否被占用 |
| Codex 连不上代理 | 确认 cc-switch 中 `base_url` 为 `http://localhost:8629/v1` |
| 局域网设备连不上 | 确认已开启「局域网访问」，检查防火墙是否放行 8629 端口 |
| 模型不匹配 | 使用 `路由ID/模型名` 格式，如 `GLM/glm-5.1` |
| 响应被截断 | 检查供应商配置中的 max output tokens 是否足够 |
| 连接测试失败 | 验证 API Key 和 Base URL，确认上游可达 |
| 查看详细日志 | 查看 `~/.codex-bridge/trace/` 下的请求记录 |

## 致谢

- [CodeSeeX](https://github.com/tastesteak/codeseex) — Codex 协议桥接与模型管理
- [cc-switch](https://github.com/RadiaxJ/cc-switch) — Tauri 实现的 Codex 配置管理工具

## 许可证

[MIT](LICENSE)
