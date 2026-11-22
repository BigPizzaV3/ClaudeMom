# 更新日志

## 未发布

- Projects 可以用了：左侧栏和 Code 面板（「项目 · 测试版」）会出现入口，能新建、改名、加星、归档和删除项目，数据保存在本机 `projects.json`。录制模板来自受限账号，本地模式现在把 `sink_planter_vase`（Projects）、`amber_tributary_heron/osprey/wren/ptarmigan`（Code 项目）以及 `cowork`、`omelette`、`operon` 等被 `blocked_by_org_tier` 挡掉的功能按最高档放开。
- 项目详情页完整可用：预取三件套（详情 + `conversations_v2` + `accounts`）形状对齐新版前端契约；`conversations_v2` 返回项目内真实会话，`accounts` 回 owner 行，`permissions` 回完整权限枚举（含 `chat_project:chat:create`，决定能否在项目里开会话）。
- 会话与项目绑定：会话行带 `chat_project_id`（REST 与 Code 会话行双发 `project_uuid`），`POST /chat_conversations` 接受 `project_uuid`/`chat_project_id` 建立归属；`GET /v1/code/sessions?chat_project_id=` 按项目过滤；`/projects/move_conversations` 支持把会话挪进/挪出项目。
- 知识库子资源契约修正：`/syncs` 回顶层数组（前端 `Array.isArray` 校验），`POST /sync` 回 `kb_resync_status:"done"` 避免前端 5 秒轮询，详情响应带 `has_sync_sources:false`。
- `/v1/*` 请求（claude.ai 域）现在和 `/api/*` 一样进本地 mock 层，不再落进通用 `{}` 兜底——此前 Code 会话列表等接口永远返回空对象。
- 6.x Code 面板的新建项目走 `/v1/code/channels`（createChannel）。本地实现了 channels 的创建/列表/详情/改名/归档/删除，并把 channel id 与本地项目存储打通；之前落到 `/v1/` 兜底返回 `{sessions:[]}`，前端拿不到 `channel.id` 会报「出了点问题」。
- 录制脚本在 Windows 上可用了：`sanitize-mock.mjs` 的入口判断改用 `pathToFileURL`（原先 `file://${argv[1]}` 在反斜杠路径下永远不匹配，脚本静默不执行）；录完的 shell 若不在固定路由的缓存键下，会扫描缓存按 build id 匹配。
- 新建项目弹窗不再等 GitHub 仓库列表和 GitHub App 安装状态：这些请求在本地直接回空。之前它们转发上游后 20 秒超时，会以未处理的 socket error 把本地服务打崩，弹窗按钮也一直不可用。
- Artifacts：聊天现在能真正产出作品。模型会拿到 `mcp__claude-artifacts__*` 工具（create_from_type / publish_version / list_artifacts …），调用结果写到官方 typed-artifacts 目录。`/api/frame/*`、`/api/frame/types`、frame 查看器外壳和 `*.claudeusercontent.com` 运行时都由本地服务提供，Code/Cowork 与聊天共用同一批作品。
- 上游不支持 `tools` 时自动退回纯文本回复，不影响普通聊天。

## 0.1.12 - 2026-11-20

- 只开系统代理（没开 TUN 模式）时，发给公网上游的模型请求现在也走这个代理，不再直连后被上游按地区拒绝（`403 region_blocked`）或连不上。本机和局域网里的上游仍然直连。（#36）

## 0.1.11 - 2026-11-20

- 连接器可以用了：插件页里的连接器（远程 MCP 服务器；实测过 Product Hunt 和 Notion，其它允许客户端自行注册的连接器按同样方式接入）能打开、点「添加」连接，之后新建的 Cowork 和 Code 会话里就能调用它的工具，也能断开、移除。需要登录的连接器会用系统浏览器打开对方的授权页，登录后自动回到 Claude；令牌保存在本机。只认 Anthropic 自己登记的客户端的连接器（Slack、Gmail、Google Drive、Asana 等）登录不了，会直接提示连接失败。Chat 页签里连接器的工具还不会生效。
- 插件页的搜索修好了：0.1.10 里不管搜什么都只列出已安装的插件。
- 插件详情页的「连接器」一栏不再一直显示加载中；从列表点进连接器不再报「无法加载此页面」。

## 0.1.10 - 2026-11-20

- 插件可以装了：插件页里带源码仓库的插件（Superpowers、frontend-design 这类 Skills / 钩子 / 命令）能打开详情、查看文件、点「添加」安装，装好后新建的 Cowork 和 Code 会话里就能用，也能移除。插件详情来自 Anthropic 的公开目录，安装包是插件 GitHub 仓库里审核过的那个提交的源码，所以安装时要能访问 GitHub。连接器类条目（由 Anthropic 服务端代为调用的那种）仍然打不开、装不了。（#25）
- macOS：录制版里 Cowork 报「401 Invalid bearer token」的问题修好了。虚拟机里的请求改走本地服务，不再经系统代理直连官方。虚拟机只接收按基本策略信任的证书：开着 Cowork 时，之前信任过本地证书的要再点一次「信任证书」。
- 修复 Cowork 提交任务时报「Cowork 目前不可用」：补上 `/api/bootstrap/<org>/system_prompts`，并把 `system_prompts` 写进 bootstrap。提示词在运行时从本机 `app.asar` 读取（不在仓库里分发官方文本），读不到时用内置兜底文案。
- 插件页整页报「无法加载插件。请检查您的网络连接后重试」的问题修好了（0.1.9 引入）：插件目录恢复显示，连不上 Anthropic 时显示为空。（#25）
- Chat 会话在本地服务重启后重新打开，接着用上次选的模型，不再换回默认模型。

## 0.1.9 - 2026-11-18

- 修复 11-17 版界面中，已有回复却显示「无法加载此内容」的问题。新旧会话缺少附件等列表时，现在会返回空列表；已有附件不会被清空。也补齐了页面读取的 frame 类型列表。（#26，感谢 #29 的排查）
- 修复插件页目录、注册表、扩展列表和已安装插件检查接口缺少必需字段的问题；无本地插件时显示为空列表。录制版本地 mock 不包含官方插件详情或安装包，本次不增加官方插件的浏览/安装功能。（#25、#30）
- DeepSeek 等以 `/anthropic` 结尾的上游现在可以拉取模型了：原模型列表接口返回 404 或 405 时，会尝试根路径的模型列表；鉴权失败或超时会直接报错。（#20）

## 0.1.8 - 2026-11-17

- 用 11-17 版界面时，选择器里的上游模型都显示「升级」、一切换就报错的问题修好了（不用再切回 11-07 版）。
- Windows：Cowork 虚拟机里的请求改走本地服务，不再直连官方报「401 Invalid bearer token」。
- Windows：设置 → 高级 → Cowork 下新增「安装系统证书」按钮（需要管理员授权）。Cowork 虚拟机只信任系统级证书，没装会报 x509 证书错误；取消信任时会一起清掉系统级证书。

## 0.1.7 - 2026-11-17

- 主页输入框没有「对话 | Cowork」切换、找不到 Cowork 入口的问题修好了。
- 界面数据更新到 claude.ai 2026-11-17 的版本；设置 → 版本 里可以换回之前的 11-07 版本。
- 设置 → 界面 新增「本机版」：用 Claude 自带的新界面（第三方模式），随 Claude 更新，不用信任本地证书；暂不支持中文和语音输入，也没有电脑使用等账号相关的功能。默认仍是「录制版」。
- 设置新增「合并式主页（实验）」：Claude 正在小范围试验的主页，对话和 Cowork 合在一个输入框里，默认关。
- 去掉了「用本机自带的界面（实验性）」，由「本机版」取代。

## 0.1.6 - 2026-11-16

- Chat、Cowork 的会话标题改由上游模型生成，不再全都叫「New task」或没有标题；会话可以改名、删除。
- 修复 Chat 部分请求被压缩后提问内容丢失的问题。
- Windows：听写一直连不上（语音服务 503）的问题修好了。
- Cowork 提交任务时报「Invalid BFF response format」的问题修好了。
- Artifacts 报「policy check couldn't get through」的问题修好了。
- 优先用系统里装的 Node.js（22 及以上）运行本地服务，不再借用 ChatGPT / Codex 自带的；系统里的版本太旧时才退回去用它们。

## 0.1.5 - 2026-11-16

- Code / Cowork 首次使用时「无法下载 Claude Code（IDLE_TIMEOUT）」的问题修好了：大文件改为边下边转，不再整个读进内存（下载时内存也不会再涨到几个 GB）。
- Chat 一发消息就「与 Claude 回复的连接已中断」：上游出错（Key 不对、模型不存在、网关返回非标准格式等）时，现在会把上游给的原因直接显示在回复里；也兼容了用 CRLF 分隔、不发结束事件、不按流式返回的网关。
- Windows：设置里打开「计算机使用」提示「您的账户尚未启用计算机使用功能」的问题修好了。
- Windows / macOS：同一台电脑上其他用户开着 Claude 时，不再把它当成自己的、一直显示「正在运行」。
- 打开已有会话时消息为空的问题修好了。
- 内置示例技能（本地模式下载不到内容）不再显示为已启用，Claude 也不会每次同步都去下载、报失败。

## 0.1.4 - 2026-11-16

- 首次打开 Claude 时本地服务会开出上千个连接（在代理软件、防火墙里看到大量 node 连接）的问题修好了：发往上游的请求改为共用连接、限制并发。
- 新安装时界面可能变成另一套布局、Code 页一直卡在加载的问题修好了；首次启动也不再需要能直接连上 claude.ai，减少「Couldn't connect to Claude / Bad Gateway」。
- Claude 关闭连接后，本地服务这边的连接也会一起关掉，不再越积越多；统计、错误上报等其它域名的连接也改走系统代理。
- 设置 → 高级 新增「用本机自带的界面（实验性）」，默认关，目前只供测试。

## 0.1.3 - 2026-11-15

- Windows：新版 Claude 桌面版主页没有「对话 | Cowork」切换的问题修好了，Cowork 默认打开；不想要可以在 设置 → 高级 → Cowork 关掉。
- 部分 Claude 版本没有 `ion-dist.asar`、而是把界面解包成目录，本地服务会启动失败、一直显示「本地服务未运行」；现在两种形式都支持。

## 0.1.2 - 2026-11-13

- 从 cc-switch 导入：也读取给 Claude 桌面版单独配的供应商（cc-switch 新版的「Claude Desktop」页），同一组地址和 Key 只导入一次。
- 从 cc-switch 导入：按 cc-switch 自己的规则找数据库，设置里改过配置目录的也能找到。
- cc-switch 里只有 OpenAI 格式的供应商时，说明原因，不再只提示「没有找到」。

## 0.1.1 - 2026-11-12

- macOS：改由系统（LaunchServices）启动 Claude，屏幕录制、辅助功能等隐私权限按 Claude 自己计算，不再显示「未请求」。
- 设置 → 高级 新增「新系统也开后台模式」（默认关）：Claude 在较新的 macOS 上提示「暂不支持后台模式」时，可打开它解除系统版本限制；未经 Claude 验证，可能不稳定。

## 0.1.0 - 2026-11-12

首个版本：从 CodexPlusPlus 拆出的独立程序。

- 用原版 Claude Desktop 的完整功能模式（Chat / Code / Cowork、界面汉化），直连自己的上游（Base URL + Key）。
- 多组上游随时切换；可从 cc-switch 导入 Claude 供应商，或把 Magpie / Codex++ 的本机网关当上游。
- 本地听写（SenseVoice，离线转写）。
- 自动更新。
