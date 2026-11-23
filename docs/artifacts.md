# Artifacts（聊天面板 + 本地作品）

Claude Desktop 的 artifact 能力在第三方网关下不可用：`/api/frame/*` 只有空壳，
模型也拿不到 artifact 工具。ClaudeMom 现在在本地把三层都补齐：

```
模型 ──tool_use──► conversation-service ──► artifacts.mjs ──► typed-artifacts 目录
                                              │                    ▲
                                              └─ /api/frame/* ─────┘
```

## 组成部分

| 位置 | 作用 |
| --- | --- |
| `crates/claude-local/runtime/artifacts.mjs` | 存储、frame 文档/运行时、`/api/frame/*`、`/api/artifacts/mcp`、本地调试接口 |
| `crates/claude-local/runtime/conversation-service.mjs` | 给模型声明 artifact 工具，执行 tool_use 并回填 tool_result |
| `crates/claude-local/runtime/proxy.mjs` | 路由：frame API、内容子域、MCP |

## 存储

作品与官方桌面端共用同一目录：

```
%APPDATA%\Claude\typed-artifacts\<账号8位>\<组织8位>\<uuid>\
  desktop.json   类型（design/slides）、标题
  artifact.json  版本列表（files: [path, blobSha, mime]）
  blobs\<sha256> 文件内容
```

因此官方 Artifacts 页、Code/Cowork 的 frame 查看器、聊天里的 artifact 卡片
看到的是同一批作品；用环境变量 `CLAUDE_LOCAL_ARTIFACT_ROOT` 可以改到别的目录（测试用）。

## 工具面

聊天请求会带上 `mcp__claude-artifacts__*` 工具（名字与官方 CLI 内置的 artifact MCP 一致）：

- `create_from_type({type_slug, title})` → `{slug}`
- `publish_version({slug, title?, files[], remove?})` → 新版本
- `list_artifacts` / `list_types` / `get_artifact` / `list_files` / `read_file` / `delete_artifact`

模型调用后由 `artifacts.mjs` 在本机执行，`tool_result` 回填给模型继续说话。
上游不支持 `tools`（常见于部分第三方网关）时自动退回纯文本一轮。

`/api/artifacts/mcp` 也对外提供同样的 MCP（JSON-RPC over HTTP），
供 Code/Cowork 的 Claude Code CLI 取工具。

## frame 运行时

design/slides 的查看器依赖官方 frame 运行时，仓库不分发官方资源。
把录制下来的 `frame-runtime/` 放到 ClaudeMom 状态目录（默认
`%USERPROFILE%\.claude-mom\frame-runtime`），或用 `CLAUDE_LOCAL_FRAME_ROOT` 指定：

```
frame-runtime/
  templates/design.json  templates/slides.json
  runtime/<ver>/_files.json + 资源
  shared/_runtime/*
```

缺省时 `/api/frame/artifacts`、`/api/frame/types` 仍可用，只是查看器页面取不到运行时。

## 本地调试接口

`/__claude_local/artifacts` 仍保留在本地服务里（作品列表、`/<id>/meta`），
仅供调试；不再往页面注入浮动面板。`/<id>/raw` 预览放在内容子域
（`<uuid>.claudeusercontent.com/__claude_local/artifacts/<id>/raw`）并带 sandbox CSP：
模型生成的 HTML 不能落在 claude.ai 源下。作品的日常使用走官方 frame 查看器
（`/code/artifact/<uuid>`）。

## 测试

```bash
cd crates/claude-local/runtime
node --test artifacts.test.mjs
```
