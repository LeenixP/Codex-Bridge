# Codex-Switch

[![CI](https://github.com/LeenixP/Codex-Switch/actions/workflows/ci.yml/badge.svg)](https://github.com/LeenixP/Codex-Switch/actions/workflows/ci.yml)
[![License](https://img.shields.io/github/license/LeenixP/Codex-Switch)](LICENSE)
[![Release](https://img.shields.io/github/v/release/LeenixP/Codex-Switch)](https://github.com/LeenixP/Codex-Switch/releases)

Codex 桌面应用的协议桥接工具 — 将 OpenAI Chat 和 Anthropic API 转换为 OpenAI Responses 格式。

## 说明

Codex-Switch 在本地运行代理服务，接收来自 Codex 的 Responses API 请求，将其转换为 OpenAI Chat Completions 或 Anthropic Messages 格式发送到上游，再将响应转换回 Responses API SSE 事件流。

```
Codex Desktop → localhost:8629 → Codex-Switch → 上游 API
                 (Responses API)   (协议转换)    (Chat/Anthropic)
```

## 功能特性

- **多协议支持**：OpenAI Chat Completions 和 Anthropic Messages API
- **流式传输**：完整 SSE 流式响应，实时文本、推理和工具调用事件
- **思考/推理**：Anthropic extended thinking 映射为 Codex reasoning 展示
- **工具调用**：双向工具调用转换（function_call ↔ tool_use）
- **Provider 管理**：添加、编辑、删除、切换多个 API 供应商
- **预设快速添加**：OpenAI、Anthropic、DeepSeek、Groq、Together 一键配置
- **系统托盘**：后台运行，托盘图标快速切换
- **Codex 集成**：一键注入配置到 `~/.codex/config.toml`
- **跨平台**：Windows、macOS、Linux（x64 + arm64）

## 安装

从 [Releases](https://github.com/LeenixP/Codex-Switch/releases) 页面下载对应平台的最新版本。

### 发行包

| 平台 | 格式 |
|------|------|
| Linux x64 | AppImage, deb |
| Linux arm64 | AppImage, deb |
| macOS | dmg, tar.gz, zip |
| Windows | Setup exe |

## 开发

```bash
# 安装依赖
npm install

# 开发运行
npm start

# 语法检查
npm run check

# 运行测试
npm test

# 生成图标
npm run icons

# 构建当前平台
npm run dist
```

## 使用方法

1. 启动 Codex-Switch
2. 添加 Provider（如 Anthropic + API Key）
3. 在设置中点击「注入配置到 Codex」
4. 启动 Codex — 请求将通过你配置的 Provider 路由

## 项目结构

```
src/
├── electron/       # 桌面应用外壳（窗口、托盘、IPC）
├── proxy/          # HTTP 代理服务器
│   ├── core/       # 编排器、SSE 桥接、事件模型
│   └── adapters/   # 协议适配器（openai-chat、anthropic）
├── codex/          # Codex 配置集成
├── ui/             # 管理面板（HTML/CSS/JS）
└── shared/         # 配置、工具函数
```

## 故障排除

| 问题 | 解决方案 |
|------|------|
| 代理无法启动 | 检查端口 8629 是否被占用 |
| Codex 未通过代理路由 | 重新点击「注入配置」，确认 `~/.codex/config.toml` 包含 `[model_providers.codex-switch]` |
| 连接测试失败 | 验证 API Key 和 Base URL，确认上游服务可达 |
| 代理启动后 Codex 不识别模型 | 检查 `~/.codex/auth.json` 是否包含 `OPENAI_API_KEY` |

## 贡献

欢迎贡献！详见 [CONTRIBUTING.md](CONTRIBUTING.md)。

## 致谢

本项目参考了以下优秀项目：

- [CodeSeeX](https://github.com/tastesteak/codeseex) — Codex 协议桥接与模型管理
- [cc-switch](https://github.com/RadiaxJ/cc-switch) — Tauri 实现的 Codex 代理切换工具

特别感谢 [@tastesteak](https://github.com/tastesteak) 和 [@RadiaxJ](https://github.com/RadiaxJ) 在协议适配和配置文件注入方面的开创性工作。

## 许可证

MIT
