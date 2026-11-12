# ClaudeMom

用原版 Claude Desktop 的**完整功能模式**（Chat / Code / Cowork、汉化、原生听写），直连你自己的上游。

- **多组上游**：每组一个 Base URL + Key（Anthropic 兼容，与 `ANTHROPIC_BASE_URL` 同语义），随时切换。
- **导入**：cc-switch 的 Claude 供应商；把 Magpie 或 Codex++ 的本机网关当上游。
- **不改原版应用**：本地兼容服务 + 本机证书接管 Claude Desktop 的请求，官方 App 与登录态都不动。
- **本地听写**：SenseVoice 离线转写，音频不出本机。

## 结构

| 目录 | 说明 |
|---|---|
| `crates/claude-local` | 完整功能模式核心：本地兼容服务（`runtime/`）、证书、profile 切换、启动 / 停止、听写。CodexPlusPlus 也依赖这一份。 |
| `apps/claude-mom` | ClaudeMom 桌面程序（Tauri + React）。 |

## 开发

```bash
cd apps/claude-mom
npm install
npm run check && npm test          # 前端
cargo test --workspace             # Rust（在仓库根目录）
npx tauri build --bundles app      # 打包 macOS .app
node scripts/relaunch-local.mjs    # 构建并重启本地实例（在仓库根目录）
```

核心的 Node 测试：`cd crates/claude-local/runtime && node --test managed.test.mjs proxy.test.mjs`
（需要本地测试证书：`scripts/gen-ca.sh`）。

## 许可

AGPL-3.0-only
