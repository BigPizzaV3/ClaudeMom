#!/usr/bin/env node
/**
 * Claude Desktop 本地兼容后端（PoC）
 *
 * 目标：让 Claude.app 认为自己在跟 claude.ai 说话，实际由我们接管：
 *   - /api/*         → 本地 mock（账号、会话、feature flags）
 *   - 其余静态资源   → 转发上游（真 UI），带磁盘缓存
 *   - demo 模式      → 连上游都不需要，直接回本地演示页（用于验证链路）
 *
 * 用法：
 *   node proxy.mjs --port 8899 --mode mock --upstream https://claude.ai
 *   node proxy.mjs --mode demo
 *
 * 客户端（Claude.app）需要把系统代理或 --proxy-server 指到 127.0.0.1:8899，
 * 并信任 scripts/gen-ca.sh 生成并安装的本地 CA。
 */
import http from "node:http";
import https from "node:https";
import tls from "node:tls";
import net from "node:net";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { Duplex } from "node:stream";
import zlib from "node:zlib";
import { fileURLToPath } from "node:url";
import { ConnectorError, connectorRecord, createConnectorService } from "./connectors.mjs";
import { createConversationService } from "./conversation-service.mjs";
import { isPatchedStartupAsset, startupAssets } from "./scripts/patch-dictation-start.mjs";
import { createGatewayStreamParser, createStateStore, gatewayBody, gatewayHttpError, gatewayModel, gatewayTarget, isPrivateFile, mergePoolModels, modelList, modelSelectors, isLocalNetworkHost, modelWindow, planProfile, runtimeConfig } from "./runtime.mjs";
import { createOfficialAssets, loadCoworkSystemPrompt } from "./official-assets.mjs";
import { EXTENSION_PREFIX, createExtensions } from "./extensions.mjs";
import { DIRECTORY_MARKETPLACE, installablePlugin, installedDirectoryRecord, libraryItem, pluginRecord, pluginRepository, zipSubtree } from "./plugins.mjs";
import { createArtifactService } from "./artifacts.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const runtime = runtimeConfig();
const officialAssets = runtime.managed
  ? createOfficialAssets(process.env.CLAUDE_LOCAL_DESKTOP_RESOURCES)
  : null;
const LOCALIZATION_SHIM_PATH = "/__codex_plus/claude-localization.js";
const localizationShim = runtime.managed && !runtime.recordedDir && runtime.localization
  ? fs.readFileSync(path.join(here, "page-shim.js"))
  : null;

const LOCAL_CATALOG_VERSION = "local.local";

function addLocalizationShim(html, officialLocales) {
  if (!localizationShim) return html;
  const head = /<head\b[^>]*>/i.exec(html);
  const headEnd = /<\/head\s*>/i.exec(html);
  if (!head || !headEnd || head.index >= headEnd.index) {
    throw new Error("Claude Desktop official shell has no supported localization injection point");
  }
  const contentStart = head.index + head[0].length;
  const headContent = html.slice(contentStart, headEnd.index);
  const existingMeta = /<meta\b[^>]*\bname=(["'])i18n-catalogs\1[^>]*>/i.exec(headContent);
  const existingValue = existingMeta?.[0].match(/\bdata-i18n-catalogs=(["'])(.*?)\1/i)?.[2] ?? "";
  const catalogs = new Map();
  for (const entry of existingValue.split(",")) {
    const match = entry.trim().match(/^([\w-]+):([\w-]+)\.([\w-]+)$/);
    if (match) catalogs.set(match[1], `${match[2]}.${match[3]}`);
  }
  // 版本号必须是「基础词表.动态词表」两段：前端按 /^([\w-]+):([\w-]+)\.([\w-]+)$/ 解析，
  // 以前写的 1.1.1 是三段，整张表都解析失败、语言列表变空，界面就退回英文。
  for (const locale of officialLocales) {
    if (!catalogs.has(locale)) catalogs.set(locale, LOCAL_CATALOG_VERSION);
  }
  catalogs.set("zh-Hans", catalogs.get("zh-Hans") ?? LOCAL_CATALOG_VERSION);
  const catalogValue = [...catalogs]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([locale, versions]) => `${locale}:${versions}`)
    .join(",");
  const meta = `<meta name="i18n-catalogs" data-i18n-catalogs="${catalogValue}">`;
  const withoutMeta = existingMeta
    ? headContent.replace(existingMeta[0], "")
    : headContent;
  const firstScript = /<script\b/i.exec(withoutMeta);
  const additions = `${meta}${localizationShim && !html.includes(`src="${LOCALIZATION_SHIM_PATH}"`)
    ? `<script src="${LOCALIZATION_SHIM_PATH}"></script>`
    : ""}`;
  const insertAt = firstScript ? firstScript.index : withoutMeta.length;
  return `${html.slice(0, contentStart)}${withoutMeta.slice(0, insertAt)}${additions}${withoutMeta.slice(insertAt)}${html.slice(headEnd.index)}`;
}

const officialShell = runtime.managed
  ? addLocalizationShim(officialAssets.indexHtml, officialAssets.i18nLocales)
  : null;

// 页面扩展（见 extensions.mjs）：启用中的扩展的 js / css 以同源地址插进页面外壳，每次请求现读。
const extensions = runtime.managed && runtime.extensionDirs.length && runtime.extensionsState
  ? createExtensions({ dirs: runtime.extensionDirs.map((dir) => path.resolve(dir)), stateFile: runtime.extensionsState })
  : null;

// 插在官方脚本之前（有本地化 shim 时在它之后），这样扩展能赶在页面脚本前做事（比如包一层 fetch）。
// 页面脚本带 nonce 时抄给我们的标签：线上外壳的 CSP 按 nonce 放行脚本。
function addExtensions(body) {
  const assets = extensions?.assets() ?? [];
  if (!assets.length) return body;
  const html = Buffer.isBuffer(body) ? body.toString("utf8") : body;
  const head = /<head\b[^>]*>/i.exec(html);
  const headEnd = /<\/head\s*>/i.exec(html);
  if (!head || !headEnd || head.index >= headEnd.index) return body;
  const nonce = /<script\b[^>]*\bnonce=(["'])([\w+/=-]+)\1/i.exec(html)?.[2];
  const nonceAttr = nonce ? ` nonce="${nonce}"` : "";
  const tags = assets.map(({ type, href }) => type === "style"
    ? `<link rel="stylesheet" href="${href}"${nonceAttr}>`
    : `<script src="${href}"${nonceAttr}></script>`).join("");
  const contentStart = head.index + head[0].length;
  const headContent = html.slice(contentStart, headEnd.index);
  const shimTag = `<script src="${LOCALIZATION_SHIM_PATH}"></script>`;
  const shimAt = headContent.indexOf(shimTag);
  const firstScript = /<script\b/i.exec(headContent);
  const insertAt = contentStart + (shimAt !== -1 ? shimAt + shimTag.length
    : firstScript ? firstScript.index : headContent.length);
  return Buffer.from(`${html.slice(0, insertAt)}${tags}${html.slice(insertAt)}`);
}
const args = process.argv.slice(2);
const arg = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i === -1 ? fallback : args[i + 1] ?? fallback;
};

const PORT = Number(arg("port", "8899"));
const MODE = arg("mode", "mock"); // mock | passthrough | demo
const UPSTREAM = arg("upstream", "https://claude.ai");
const CA_DIR = arg("ca", path.join(here, "ca"));
const APP_STATE_DIR = process.env.CODEX_PLUS_STATE_DIR || path.join(os.homedir(), ".codex-session-delete");
const CACHE_DIR = process.env.CLAUDE_LOCAL_CACHE_DIR || path.join(here, ".cache");
// 完整功能模式的「PoC 数据路径」：CLAUDE_LOCAL_RECORDED_DIR 指向本机录制数据
// （.cache/ + mock/ + i18n/，不进包）。命中时数据面与 PoC 回放完全一致；
// 生命周期、网关鉴权、dictation 等仍按 managed 运行。
// POC_DIR 只在两类来源下启用：显式 dev 覆盖（CLAUDE_LOCAL_RECORDED_DIR），
// 或由后端 install_assets 写入代理旁的内嵌模板（mock/.codex-plus-template 标记）。
// 代理目录里来历不明的 mock 一律忽略（托管测试用 privateFixture 守住这条）。
const TRUSTED_TEMPLATE = fs.existsSync(path.join(here, "mock", ".codex-plus-template"));
const POC_DIR = runtime.recordedDir || (TRUSTED_TEMPLATE ? here : null);
// 模板按录制版本放在 mock/<build>/（每个前端版本一组接口数据 + 页面外壳）。设置里选了哪个用哪个，
// 没选或选的已经下架就用最新的（按外壳里的 data-build-timestamp）。没有版本目录时是旧的平铺布局
// （开发用的录制目录 CLAUDE_LOCAL_RECORDED_DIR 也是这样），直接用 mock/。
const TEMPLATE_ROOT = path.join(POC_DIR ?? here, "mock");
function templateBuildTime(dir) {
  try {
    const head = fs.readFileSync(path.join(dir, "shell.html")).subarray(0, 4096).toString("utf8");
    return Number(head.match(/\bdata-build-timestamp="(\d+)"/)?.[1]) || 0;
  } catch {
    return -1;
  }
}
function pickTemplate() {
  if (!POC_DIR) return TEMPLATE_ROOT;
  let versions = [];
  try {
    versions = fs.readdirSync(TEMPLATE_ROOT, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && /^[\w-]+$/.test(entry.name) &&
        fs.existsSync(path.join(TEMPLATE_ROOT, entry.name, "bootstrap.json")))
      .map((entry) => entry.name);
  } catch {}
  if (!versions.length) return TEMPLATE_ROOT;
  if (runtime.template && versions.includes(runtime.template)) return path.join(TEMPLATE_ROOT, runtime.template);
  const newest = versions
    .map((name) => ({ name, time: templateBuildTime(path.join(TEMPLATE_ROOT, name)) }))
    .sort((a, b) => b.time - a.time || a.name.localeCompare(b.name))[0].name;
  return path.join(TEMPLATE_ROOT, newest);
}
const POC_MOCK = pickTemplate();
const POC_I18N = path.join(POC_DIR ?? here, "i18n");
// 托管模式在存在 PoC 数据（dev 录制目录或安装的内嵌 mock 模板）时走 PoC 数据路径；
// 完全没有模板数据时保持合成兜底（officialShell/localBootstrap + 状态告警）。
const dataManaged = runtime.managed && !POC_DIR;
// 页面外壳用本机 Claude 自带的版本（ion-dist）：资源都在本地，不用每逢线上换版本就补拉上千个文件，
// 首次启动也不依赖能连上 claude.ai。只在没有模板数据时这样用：本机这份是 Claude 第三方模式的界面，
// 配上按 claude.ai 录制的模板数据对不上；要用它请选「本机版」界面（第三方模式启动）。
const useOfficialShell = Boolean(officialShell) && dataManaged;
// 模板模式下主站外壳用录制版本，但 frame-shell.html（artifact 查看器外壳）没有模板录制、
// 一直从本机 ion-dist 出（artifacts.mjs serveViewerShell）。它的 JS/CSS chunk 也必须同源：
// 走「缓存→上游」链时，本机 6.x 的 chunk 名在旧缓存里 MISS，转发上游会被 302 到
// app-unavailable-in-region（受限地区），chunk 永远加载不出 → "Couldn't load artifact"。
// officialAssets 存在时，/assets/v1/frame-*、shared-frame-*、vendor-frame-* 等查看器资产直接从 asar 出。
const FRAME_ASSETS_AVAILABLE = Boolean(officialAssets);
// 模板自带的页面外壳（mock/shell.html）：与模板数据同一次录制、同一个前端版本。
// 有它时主站的页面导航一律用它，不看缓存、不去线上抓：线上页面会换版本，
// 配上按旧版本录制的模板就会界面错乱、Code 页卡在加载（新用户没有缓存时必然拿到线上版本）。
const TEMPLATE_SHELL = (() => {
  if (!POC_DIR) return null;
  try {
    const body = fs.readFileSync(path.join(POC_MOCK, "shell.html"));
    return body.length >= 4096 && /<html\b[^>]*\bdata-build-id="[^"]+"/i.test(body.subarray(0, 4096).toString("utf8"))
      ? body
      : null;
  } catch {
    return null;
  }
})();
const READ_CACHE = POC_DIR ? path.join(POC_DIR, ".cache") : CACHE_DIR;

const LOG = arg("log", "1") !== "0";
const READY_FILE = process.env.CLAUDE_LOCAL_READY_FILE;
const INSTANCE_ID = process.env.CLAUDE_LOCAL_INSTANCE_ID || crypto.randomUUID();
const STATE_FILE = process.env.CLAUDE_LOCAL_STATE_FILE;
const DICTATION_WS_PATH = "/api/ws/speech_to_text/voice_stream";
const DICTATION_HELPER_PATH = "/dictation/claude-stream";
const MAX_DICTATION_WS_CONNECTIONS = 4;
const MAX_DICTATION_WS_BYTES = 26 * 1024 * 1024;
const MAX_DICTATION_WS_IDLE_MS = 130_000;
const MAX_DICTATION_WS_DURATION_MS = 16 * 60_000;
// Desktop 的 policy-limits 校验器要求 restrictions 是非 null 对象（不能是数组）；
// compliance_taints 可选数组，defaults 可选对象。
const POLICY_LIMITS = { restrictions: {}, compliance_taints: [], defaults: {}, artifact_create_notice: null };
const DICTATION_ALLOWED_HOSTS = new Set(["claude.ai", "claude.com", "api.anthropic.com"]);
const DESKTOP_WEB_ORIGINS = new Set(["https://claude.ai", "https://claude.com"]);
let lastClientAt = null;
let listeningPort = PORT;
let persistenceWarning = null;

if (!Number.isInteger(PORT) || PORT < 0 || PORT > 65535) throw new Error("Invalid Claude local proxy port");
if (runtime.managed && (!READY_FILE || !STATE_FILE)) throw new Error("Managed Claude requires runtime state paths");
if (runtime.managed && !officialAssets) throw new Error("Managed Claude requires the original Claude Desktop resources path");

fs.mkdirSync(CACHE_DIR, { recursive: true });

const key = fs.readFileSync(path.join(CA_DIR, "server.key"));
const cert = fs.readFileSync(path.join(CA_DIR, "server.crt"));
const ctx = tls.createSecureContext({ key, cert });

// ── mock 数据 ────────────────────────────────────────────────
// 显示给 Claude 的账号信息：用户名、邮箱与套餐来自本地设置。
const plan = planProfile(runtime.plan);
const displayName = runtime.displayName;
const isMax = plan.capabilities.includes("claude_max");
const ACCOUNT = {
  id: "c46bd1eb-fbbf-4e5a-9bb3-5ebe8521eb54",
  uuid: "c46bd1eb-fbbf-4e5a-9bb3-5ebe8521eb54",
  email: runtime.email,
  name: displayName,
  full_name: displayName,
  plan_type: plan.plan,
  plan: plan.plan,
  tier: plan.plan,
  user_tier: plan.plan,
  plan_tier: plan.plan,
  entitlement_tier: plan.plan,
  membership_plan: plan.plan,
  plan_display_name: plan.label,
  plan_display_label: plan.label,
  subscription: { plan: plan.plan, status: "active" },
  is_max: isMax,
  has_claude_max: isMax,
  capabilities: [
    "chat",
    "projects",
    "artifacts",
    "computer_use",
    "research",
    "connectors",
    "claude_code",
    "cowork",
  ],
  settings: { ...(runtime.localization ? { locale: "zh-Hans" } : {}), theme: "system" },
};

const ORG = {
  uuid: "e0e877d3-8475-44a1-a501-4fc431b085ab",
  id: "e0e877d3-8475-44a1-a501-4fc431b085ab",
  name: "Local",
  organization_type: "personal",
  raven_type: "personal",
  plan_type: plan.plan,
  plan: plan.plan,
  tier: plan.plan,
  user_tier: plan.plan,
  plan_tier: plan.plan,
  entitlement_tier: plan.plan,
  membership_plan: plan.plan,
  capabilities: [
    "chat",
    ...plan.capabilities,
    "projects",
    "artifacts",
    "computer_use",
    "research",
    "connectors",
    "claude_code",
    "cowork",
    "compliance_api",
  ],
  billing_type: "stripe_subscription",
  is_personal: true,
  settings: {},
  visibility_status: "active",
  parent_organization_uuid: null,
  rate_limit_tier: plan.rateLimitTier,
  analytics_subscription_plan: plan.analytics,
  plan_display_name: plan.label,
  plan_display_label: plan.label,
  has_hosted_code_environments: false,
  claude_ai_bootstrap_models_config: runtime.models.map((model) => ({
    model, name: runtime.modelNames?.[model]?.name || model, description: runtime.modelNames?.[model]?.description || "", paprika_modes: [], thinking_modes: [],
    hard_limit: modelWindow(runtime, model),
    context_window: modelWindow(runtime, model),
  })),
  created_at: "2026-01-01T00:00:00Z",
};

const BOOTSTRAP = {
  account: ACCOUNT,
  user: ACCOUNT,
  organization: ORG,
  organizations: [ORG],
  memberships: [{ uuid: "11111111-2222-4333-8444-555555555556", organization: ORG, role: "admin", status: "active", seat_tier: "full_member", email_address: ACCOUNT.email, created_at: "2025-01-01T00:00:00Z", updated_at: "2025-01-01T00:00:00Z" }],
  statsig: { user: { userID: ACCOUNT.id }, values: {}, dynamic_configs: {}, feature_gates: {} },
  feature_flags: Object.fromEntries(
    [
      "computer_use",
      "computer_use_rollout",
      "projects",
      "artifacts",
      "research",
      "connectors",
      "claude_code",
      "cowork",
    ].map((k) => [k, true]),
  ),
};
BOOTSTRAP.feature_flags.computer_use = runtime.computerUse;
BOOTSTRAP.feature_flags.computer_use_rollout = runtime.computerUse;
if (!runtime.computerUse) {
  ACCOUNT.capabilities = ACCOUNT.capabilities.filter((name) => name !== "computer_use");
  ORG.capabilities = ORG.capabilities.filter((name) => name !== "computer_use");
}

// 读取录制到的真实 bootstrap 作为模板（capture.mjs 产出）
function loadRecordedBootstrap() {
  if (dataManaged) return null;
  try {
    for (const f of fs.readdirSync(READ_CACHE)) {
      if (!f.endsWith(".json")) continue;
      const meta = JSON.parse(fs.readFileSync(path.join(READ_CACHE, f), "utf8"));
      if (typeof meta.url === "string" && meta.url.includes("/edge-api/bootstrap")) {
        const body = fs.readFileSync(path.join(READ_CACHE, f.replace(/\.json$/, "")));
        return JSON.parse(body.toString("utf8"));
      }
    }
  } catch {}
  return null;
}

const RECORDED_BOOTSTRAP = loadRecordedBootstrap();

// Cowork 的系统提示词由官方桌面端通过 system_prompts.cowork_system_prompt 下发。
// 本地 mock 缺这一项时，渲染端拿到的提示词是空的，会直接报「Cowork 目前不可用」。
// 优先从本机 app.asar 读（不在仓库里分发官方文本），读不到时用下面的兜底文案。
const FALLBACK_COWORK_SYSTEM_PROMPT = [
  "<application_details>",
  "Claude is operating as an agent inside the Claude desktop app. The agent is built on Claude Code and the Claude Agent SDK, but Claude should not present itself as Claude Code.",
  "</application_details>",
  "",
  "<claude_behavior>",
  "Work directly on the user's task with the file tools and the sandboxed Linux shell. Prefer the file tools for reading and writing files; use the shell for commands. Save deliverables in the workspace folder the user selected, and keep internal sandbox paths out of user-facing explanations unless they are relevant.",
  "</claude_behavior>",
].join("\n");
let coworkSystemPromptCache;
function coworkSystemPrompt() {
  if (coworkSystemPromptCache !== undefined) return coworkSystemPromptCache;
  const prompt = loadCoworkSystemPrompt(process.env.CLAUDE_LOCAL_DESKTOP_RESOURCES, process.env.CLAUDE_LOCAL_COWORK_PROMPT_FILE);
  coworkSystemPromptCache = prompt || FALLBACK_COWORK_SYSTEM_PROMPT;
  return coworkSystemPromptCache;
}
function coworkSystemPrompts() {
  return {
    cowork_system_prompt: {
      value: { prompt: coworkSystemPrompt() },
      on: true,
      off: false,
      source: "defaultValue",
      ruleId: null,
    },
  };
}

// i18n 字典：.cache 里录制过的真实翻译文件（url 形如 claude.ai/i18n/s/zh-Hans.json?v=...）
const i18nMap = (() => {
  const m = new Map(); // pathname -> abs body file
  if (dataManaged) return m;
  try {
    for (const f of fs.readdirSync(READ_CACHE)) {
      if (!f.endsWith(".json")) continue;
      const meta = JSON.parse(fs.readFileSync(path.join(READ_CACHE, f), "utf8"));
      const u = String(meta.url || "");
      const bodyFile = path.join(READ_CACHE, f.replace(/\.json$/, ""));
      if (!u.includes("/i18n/") || meta.status !== 200 || !fs.existsSync(bodyFile)) continue;
      const pathPart = u.slice(u.indexOf("/i18n/")).split("?")[0];
      m.set(pathPart, bodyFile);
    }
  } catch {}
  return m;
})();

function readI18n(file) {
  if (!file) return {};
  try {
    const catalog = JSON.parse(fs.readFileSync(file, "utf8"));
    return catalog && !Array.isArray(catalog) && typeof catalog === "object" &&
      Object.values(catalog).every((value) => typeof value === "string") ? catalog : {};
  } catch {
    return {};
  }
}

// app.asar 的词表只覆盖桌面壳；主界面需要完整 Web 词表。
const I18N_DIR = path.join(here, "i18n");
const WEB_I18N_DIR = process.env.CLAUDE_LOCAL_WEB_I18N_DIR || path.resolve(here, "../assets/localization/catalogs");
const i18nResponses = new Map();
function localI18n(pathname) {
  const match = pathname.match(/^\/i18n\/(?:(s|dynamic)\/)?([a-zA-Z-]+)\.json$/);
  if (!match) return null;
  if (i18nResponses.has(pathname)) return i18nResponses.get(pathname);
  const [, kind, requestedLocale] = match;
  const locale = runtime.localization || requestedLocale === "zh-CN"
    ? "zh-Hans"
    : requestedLocale;
  const base = `${locale}.json`;
  const catalog = kind === "dynamic" ? {
    ...readI18n(path.join(WEB_I18N_DIR, "dynamic", base)),
    ...readI18n(i18nMap.get(pathname)),
  } : {
    ...(!dataManaged ? readI18n(path.join(POC_I18N || I18N_DIR, base)) : {}),
    ...readI18n(path.join(WEB_I18N_DIR, base)),
    ...readI18n(i18nMap.get(`/i18n/${base}`)),
    ...readI18n(path.join(WEB_I18N_DIR, `${locale}.overrides.json`)),
    ...(kind === "s" ? readI18n(i18nMap.get(pathname)) : {}),
  };
  if (kind === "s") {
    // 与客户端 cI() 一致：仅为无冲突的长 ID 补短别名，并保留已有短 ID。
    const prefixes = new Map();
    for (const id of Object.keys(catalog)) {
      if (!/^[A-Za-z0-9+/]{10}$/.test(id)) continue;
      const short = id.slice(0, 6);
      prefixes.set(short, prefixes.has(short) ? null : id);
    }
    for (const [short, id] of prefixes) {
      if (id !== null && !Object.hasOwn(catalog, short)) catalog[short] = catalog[id];
    }
  }
  const body = Buffer.from(JSON.stringify(catalog));
  i18nResponses.set(pathname, body);
  return body;
}

// ── 工具 ─────────────────────────────────────────────────────
const now = () => new Date().toISOString();
const log = (...a) => LOG && console.log(`[${now()}]`, ...a);

// ── Artifacts（typed-artifact 本地实现）──────────────────────
// 读写官方 Claude Desktop 的 typed-artifacts 目录：官方 Artifacts 页、Code/Cowork
// 的 frame 查看器和聊天里的 artifact 卡片看到的是同一批作品。
// Claude 数据目录按官方桌面端的布局取（Windows %APPDATA%\Claude，
// macOS ~/Library/Application Support/Claude），否则 macOS 上与官方作品库不共用。
function claudeAppDataDir() {
  if (process.platform === "darwin") {
    return path.join(os.homedir(), "Library", "Application Support", "Claude");
  }
  return path.join(
    process.env.APPDATA || path.join(os.homedir(), "AppData", "Roaming"),
    "Claude",
  );
}
const ARTIFACT_ROOT = process.env.CLAUDE_LOCAL_ARTIFACT_ROOT || path.join(
  claudeAppDataDir(), "typed-artifacts",
  String(ACCOUNT.uuid).slice(0, 8), String(ORG.uuid).slice(0, 8),
);
// frame 运行时按 docs/artifacts.md 放在 ClaudeMom 状态目录下（backend.rs 的 install_assets
// 也落这里），仓库/代理目录里没有只是开发布局的回退。
const FRAME_ROOT = process.env.CLAUDE_LOCAL_FRAME_ROOT || path.join(APP_STATE_DIR, "frame-runtime");
const artifactService = createArtifactService({
  artifactRoot: ARTIFACT_ROOT,
  frameRoot: FRAME_ROOT,
  officialAssets,
  localAccount: { uuid: ACCOUNT.uuid, name: ACCOUNT.name, email: ACCOUNT.email },
  log,
});
// 页面外壳直接用录制/官方的 HTML；本地 Artifact 面板不再注入页面。
const OFFICIAL_SHELL_HTML = officialShell || null;
const TEMPLATE_SHELL_HTML = TEMPLATE_SHELL || null;
// Chat 的 completion 请求体字段随客户端版本变化：从常见位置兜底取最近一条用户文本（跳过助手消息）。
function firstUserText(value, depth = 0) {
  if (depth > 4 || value == null) return "";
  if (typeof value === "string") return value;
  if (typeof value === "object" && !Array.isArray(value) && typeof value.role === "string" && value.role !== "user") return "";
  if (Array.isArray(value)) {
    for (let i = value.length - 1; i >= 0; i -= 1) {
      const text = firstUserText(value[i], depth + 1);
      if (text) return text;
    }
    return "";
  }
  if (typeof value === "object") {
    for (const key of ["text", "content", "prompt", "message"]) {
      if (Object.hasOwn(value, key)) {
        const text = firstUserText(value[key], depth + 1);
        if (text) return text;
      }
    }
  }
  return "";
}

function json(res, obj, code = 200, extraHeaders = {}) {
  const body = JSON.stringify(obj);
  res.writeHead(code, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(body),
    "cache-control": "no-store",
    ...extraHeaders,
  });
  res.end(body);
}

function activeOrgCookies() {
  return [
    `org_uuid=${ORG.uuid}; Path=/; SameSite=Lax`,
    `active_org_uuid=${ORG.uuid}; Path=/; SameSite=Lax`,
    `last_active_org=${ORG.uuid}; Path=/; SameSite=Lax`,
    `lastActiveOrg=${ORG.uuid}; Domain=.claude.ai; Path=/; Secure; SameSite=None`,
    `sessionKey=${ACCOUNT.uuid}-local-session; Path=/; HttpOnly; Secure; SameSite=None`,
  ];
}

function jsonWithActiveOrg(res, obj, code = 200) {
  return json(res, obj, code, { "set-cookie": activeOrgCookies() });
}

function health() {
  return {
    instanceId: INSTANCE_ID, pid: process.pid, port: listeningPort, mode: MODE,
    lastClientAt, ...(persistenceWarning ? { warning: persistenceWarning } : {}),
  };
}

let readyWriteTimer;
function writeReady() {
  if (!READY_FILE) return;
  const temporary = `${READY_FILE}.${process.pid}.tmp`;
  try {
    fs.mkdirSync(path.dirname(READY_FILE), { recursive: true, mode: 0o700 });
    fs.writeFileSync(temporary, `${JSON.stringify(health())}\n`, { mode: 0o600 });
    fs.renameSync(temporary, READY_FILE);
    fs.chmodSync(READY_FILE, 0o600);
  } catch {
    console.error("Claude local readiness could not be saved");
  }
}

function noteClient() {
  lastClientAt = now();
  if (!readyWriteTimer) {
    readyWriteTimer = setTimeout(() => {
      readyWriteTimer = undefined;
      writeReady();
    }, 500);
    readyWriteTimer.unref();
  }
}

const CONV_STATE = new Map();
const NOTIFICATION_SETTINGS = new Map();
const INSTALLED_PLUGINS = new Map(); // 插件 id → 安装时的目录记录
const CONNECTORS = new Map(); // 连接器 uuid → 记录（见 connectors.mjs）
let DEVICE_ROW = null; // Code 模式注册的设备行 {id, k, ...}
const stateStore = createStateStore(STATE_FILE, CONV_STATE, NOTIFICATION_SETTINGS, (warning) => {
  persistenceWarning = warning;
  console.error(warning);
}, INSTALLED_PLUGINS, CONNECTORS);

function ensureConv(uuid, { chatProjectId } = {}) {
  if (!CONV_STATE.has(uuid)) {
    CONV_STATE.set(uuid, {
      uuid,
      name: "",
      created_at: now(),
      updated_at: now(),
      chat_messages: [],
      current_leaf_message_uuid: null,
      // claudeai-rpc 侧状态：turns 是完整的消息实体历史，供 StreamTimeline 回放
      turns: [],
      nextIndex: 0,
      leafMessageId: null,
      model: runtime.model,
      // Code 会话归属的项目 uuid（/epitaxy/project/{id} 内发起的会话）；null = 不属于任何项目
      chat_project_id: typeof chatProjectId === "string" && chatProjectId ? chatProjectId : null,
    });
    stateStore.changed();
  }
  const conv = CONV_STATE.get(uuid);
  // 项目内补建：会话已存在但没记项目归属时补上（StreamTimeline 先于 REST 创建到达的路径）
  if (chatProjectId && !conv.chat_project_id) {
    conv.chat_project_id = chatProjectId;
    conv.updated_at = now();
    stateStore.changed();
  }
  return conv;
}

// claudeai-rpc 服务：StreamTimeline / PerformAction / 其余 ConversationService 方法
const conversationService = createConversationService({
  ensureConv,
  listConvs: () => [...CONV_STATE.values()],
  artifacts: artifactService,
  log,
  onChange: (flush) => flush ? stateStore.flush() : stateStore.changed(),
  request: (target, options, callback) => gatewayRequest(target, options, callback),
});

function pushMessage(conv, msg) {
  const index = conv.chat_messages.length;
  const m = {
    uuid: msg.uuid,
    sender: msg.sender,
    index,
    parent_message_uuid: msg.parent ?? null,
    text: msg.text ?? "",
    content: [{ type: "text", text: msg.text ?? "", citations: [] }],
    created_at: now(),
    updated_at: now(),
    ...(msg.stop_reason ? { stop_reason: msg.stop_reason } : {}),
  };
  conv.chat_messages.push(m);
  conv.current_leaf_message_uuid = m.uuid;
  conv.updated_at = now();
  stateStore.changed();
  return m;
}

const FAKE_ACCOUNT = {
  uuid: ACCOUNT.id,
  id: ACCOUNT.id,
  email: ACCOUNT.email,
  name: ACCOUNT.name,
  full_name: ACCOUNT.name,
  plan_type: plan.plan,
  plan: plan.plan,
  tier: plan.plan,
  user_tier: plan.plan,
  plan_tier: plan.plan,
  entitlement_tier: plan.plan,
  membership_plan: plan.plan,
  plan_display_name: plan.label,
  plan_display_label: plan.label,
  is_max: isMax,
  has_claude_max: isMax,
  membership: { plan: plan.plan, status: "active", plan_type: plan.plan },
  subscription: { plan: plan.plan, status: "active" },
  organization_uuid: ORG.uuid,
  organization: ORG,
  capabilities: ACCOUNT.capabilities,
  settings: {},
};

const LOCAL_MEMBERSHIP_ID = "11111111-2222-4333-8444-555555555556";

function localMembership() {
  return {
    uuid: LOCAL_MEMBERSHIP_ID,
    organization_uuid: ORG.uuid,
    organization: ORG,
    role: "admin",
    status: "active",
    seat_tier: "full_member",
    joined: true,
    is_member: true,
    created_at: "2025-01-01T00:00:00Z",
    updated_at: "2025-01-01T00:00:00Z",
  };
}

function fakeAccount() {
  const membership = localMembership();
  return {
    ...FAKE_ACCOUNT,
    tagged_id: `acct_${ACCOUNT.uuid}`,
    email_address: ACCOUNT.email,
    display_name: ACCOUNT.name,
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z",
    is_verified: true,
    age_is_verified: true,
    is_anonymous: false,
    onboarding_complete: true,
    workspace_memberships: [membership],
    invites: [],
    never_accepted_legal_document_types: [],
    accepted_clickwrap_versions: {},
    display_avatar: null,
    settings: { ...ACCOUNT.settings },
    memberships: [membership],
    memberships_incomplete: false,
  };
}

function localAccount(source = {}) {
  const account = source && typeof source === "object" && !Array.isArray(source) ? source : {};
  const normalized = {
    ...account,
    ...fakeAccount(),
    settings: { ...(account.settings || {}), ...ACCOUNT.settings },
  };
  const membership = localMembership();
  normalized.organization_uuid = ORG.uuid;
  normalized.organization = ORG;
  normalized.plan_type = plan.plan;
  normalized.plan = plan.plan;
  normalized.tier = plan.plan;
  normalized.user_tier = plan.plan;
  normalized.plan_tier = plan.plan;
  normalized.entitlement_tier = plan.plan;
  normalized.membership_plan = plan.plan;
  normalized.plan_display_name = plan.label;
  normalized.plan_display_label = plan.label;
  normalized.subscription = { plan: plan.plan, status: "active" };
  normalized.memberships = [membership];
  normalized.workspace_memberships = [membership];
  normalized.memberships_incomplete = false;
  normalized.onboarding_complete = true;
  return normalized;
}

function normalizeLocalIdentity(source = {}) {
  const payload = source && typeof source === "object" && !Array.isArray(source) ? source : {};
  const membership = localMembership();
  const account = localAccount(payload.account);
  const user = localAccount(payload.user || payload.account);
  return {
    ...payload,
    account,
    user,
    organization: ORG,
    activeOrganization: ORG,
    organizations: [ORG],
    memberships: [membership],
    resolved_org_uuid: ORG.uuid,
    org_uuid: ORG.uuid,
    active_org_uuid: ORG.uuid,
    organization_uuid: ORG.uuid,
    locale: runtime.localization ? "zh-Hans" : (payload.locale || "en-US"),
  };
}

function normalizeAccountProfile(source = {}) {
  const profile = source && typeof source === "object" && !Array.isArray(source) ? source : {};
  return {
    ...profile,
    account: localAccount(profile.account),
    organization: ORG,
    organization_uuid: ORG.uuid,
    activeOrganization: ORG,
    resolved_org_uuid: ORG.uuid,
    display_name: ACCOUNT.name,
    full_name: ACCOUNT.name,
    email_address: ACCOUNT.email,
    locale: runtime.localization ? "zh-Hans" : (profile.locale || "en-US"),
    membership: localMembership(),
    memberships: [localMembership()],
    workspace_memberships: [localMembership()],
  };
}

// 本地模式按 1P 最高档放开录制模板里被组织等级挡掉的功能。
// 录制账号是受限账号（cowork、omelette、operon 等大量 blocked_by_org_tier），
// 直接回放会让设置页缺 Cowork / Design system，相关的知识检索也不可用。
// 只改已有条目的 status，不增删字段；未列出的 feature 原样保留。
const FEATURE_OVERRIDES = {
  cowork: "available",
  cowork_browser_pane: "available",
  cowork_remote_control: "available",
  cowork_watch_record: "available",
  omelette: "available",
  operon: "available",
  operon_memory: "available",
  operon_custom_connectors: "available",
  operon_custom_skills: "available",
  operon_network_allowlist: "available",
  operon_ssh_hosts: "available",
  operon_modal: "available",
  operon_model_endpoints: "available",
  operon_local_work_import: "available",
  operon_auto_mode: "available",
  computer_use: "available",
  work_across_apps: "available",
  dittos: "available",
  claude_code_remote_control: "available",
  claude_code_fast_mode: "available",
  claude_code_security: "available",
  claude_code_routines: "available",
  claude_browser_extension: "available",
  project_knowledge_search: "available",
  member_usage_dashboard: "available",
  browser_data_import: "available",
  academy_personalization: "available",
  // Code 面板 Artifacts：侧边栏 gate=frame-gallery 只查 cobalt_plinth；
  // 前端默认表把它判 blocked_by_platform，不给 available 入口都不出现。
  // wiggle 用于 iframe 侧 send-to-partner（Am() 要求 chat+cobalt_plinth+wiggle 三件）。
  // （chat 侧 artifacts / cowork 侧 cowork-artifacts 条目的 gate 是客户端布尔，非 feature。）
  cobalt_plinth: "available",
  wiggle: "available",
  mcp_artifacts: "available",
};
function applyFeatureOverrides(access) {
  if (!access || typeof access !== "object") return access;
  const patch = (list) => Array.isArray(list)
    ? list.map((entry) => {
      if (!entry || typeof entry !== "object") return entry;
      const status = FEATURE_OVERRIDES[entry.feature];
      return status && entry.status !== status ? { ...entry, status } : entry;
    })
    : list;
  return { ...access, features: patch(access.features), account_features: patch(access.account_features) };
}

function localUserAccess() {
  return {
    features: [],
    account_features: [],
    organization_permissions: [],
    core_skill_names: [],
    code_execution_network_egress_enabled: false,
    code_execution_network_egress_template: "",
    code_execution_network_egress_settable: "disabled",
    artifacts_setting_blocks_classic_sharing: false,
    classic_sharing_block_reason: null,
  };
}

function localBootstrap() {
  return normalizeLocalIdentity({
    ...BOOTSTRAP,
    account: fakeAccount(),
    user: fakeAccount(),
    activeOrganization: ORG,
    resolved_org_uuid: ORG.uuid,
    locale: runtime.localization ? "zh-Hans" : "en-US",
    org_statsig: { user: {}, values: {}, values_hash: "local" },
    org_feature_flags: { user: {}, values: {}, values_hash: "local" },
    org_growthbook: { features: {}, hashing_algorithm: "fnv", user: {} },
    intercom_account_hash: null,
    intercom_user_jwt: null,
    server_localizations: null,
    system_prompts: null,
    current_user_access: localUserAccess(),
    ...modelSelectors(runtime),
    memory_mode: "melange",
    classic_mode_available: false,
    melange_available: false,
    claude_ai_available_models: { models: runtime.models.map((model) => ({ model_id: model, minimum_tier: "free" })) },
    personalized_greeting: null,
    hold_notice: null,
    served_copy: {},
    gated_messages: { messages: {}, gates: [], locale: runtime.localization ? "zh-Hans" : "en-US" },
    gated_imports: {},
    ...(officialAssets ? { gated_imports_build_id: officialAssets.buildId } : {}),
  });
}

function mockEdgeApi(req, res, url) {
  const p = url.pathname.replace(/\/+$/, "");
  if (p.includes("/edge-api/bootstrap")) {
    return jsonWithActiveOrg(res, resolvedBootstrap());
  }
  if (p.endsWith("/edge-api/client-health/check")) return json(res, {});
  return json(res, {});
}

// ── Projects（1P 的 Projects / Code 项目列表）─────────────────────────────
// 官方前端读写 /api/organizations/{org}/projects[_v2]，录制模板里没有这些数据。
// 原先只有空分页兜底：列表能开但永远为空，创建时返回分页对象会让界面报错。
// 这里给本地模式一套最小可用的持久化存储（projects.json 与 conversations.json 并列）。
// 与 conversations.json 放在同一个状态目录（测试里是临时目录，避免污染仓库）。
const PROJECTS_FILE = path.join(STATE_FILE ? path.dirname(STATE_FILE) : here, "projects.json");
const PROJECTS = new Map();
try {
  if (fs.existsSync(PROJECTS_FILE)) {
    const rows = JSON.parse(fs.readFileSync(PROJECTS_FILE, "utf8"));
    if (Array.isArray(rows)) {
      for (const row of rows) if (row && typeof row.uuid === "string") PROJECTS.set(row.uuid, row);
    }
  }
} catch {}
function saveProjects() {
  try {
    fs.writeFileSync(PROJECTS_FILE, JSON.stringify([...PROJECTS.values()], null, 2));
  } catch (error) {
    console.error("Local projects could not be saved:", error.message);
  }
}
function projectRecord(body = {}) {
  const ts = now();
  const name = typeof body.name === "string" && body.name.trim()
    ? body.name.trim().slice(0, 200) : "Untitled project";
  const uuid = crypto.randomUUID();
  return {
    uuid,
    // 前端部分列表适配器读 id；本地把它和 uuid 保持一致。
    id: uuid,
    name,
    description: typeof body.description === "string" ? body.description : "",
    instructions: typeof body.instructions === "string" ? body.instructions : "",
    prompt_template: typeof body.prompt_template === "string" ? body.prompt_template : "",
    is_starred: body.is_starred === true,
    is_private: body.is_private !== false,
    is_starter_project: false,
    is_harmony_project: false,
    type: body.type === undefined || body.type === null ? null : body.type,
    settings: {},
    permissions: [
      "chat_project:chat:view", "chat_project:chat:create", "chat_project:members:manage",
      "chat_project:owner:manage", "chat_project:knowledge:edit", "chat_project:knowledge:view",
      "chat_project:delete", "chat_project:view", "chat_project:settings:edit",
    ],
    created_at: ts,
    updated_at: ts,
    last_activity_at: ts,
    archived_at: null,
    creator: {
      uuid: ACCOUNT.uuid, name: ACCOUNT.name, full_name: ACCOUNT.name, email_address: ACCOUNT.email,
    },
  };
}
function projectsPage(url) {
  const params = url.searchParams;
  const limit = Math.min(Math.max(Number(params.get("limit")) || 30, 1), 100);
  const offset = Math.max(Number(params.get("offset")) || 0, 0);
  const uuids = params.getAll("uuids").filter(Boolean);
  const starred = params.get("starred");
  const archived = params.get("is_archived");
  const type = params.get("type");
  const creatorFilter = params.get("creator_filter") || params.get("creator") || params.get("filter");
  const search = String(params.get("searchQuery") || params.get("search") || "").trim().toLowerCase();
  let rows = [...PROJECTS.values()];
  if (uuids.length) rows = rows.filter((row) => uuids.includes(row.uuid));
  if (creatorFilter === "is_creator" || creatorFilter === "own") {
    rows = rows.filter((row) => row.creator?.uuid === ACCOUNT.uuid);
  }
  if (starred === "true") rows = rows.filter((row) => row.is_starred);
  if (archived === "true") rows = rows.filter((row) => row.archived_at);
  else if (archived !== "all") rows = rows.filter((row) => !row.archived_at);
  if (type) rows = rows.filter((row) => row.type === type);
  if (search) rows = rows.filter((row) => `${row.name} ${row.description}`.toLowerCase().includes(search));
  const orderBy = params.get("order_by") || "latest_activity";
  rows.sort(orderBy === "name"
    ? (a, b) => a.name.localeCompare(b.name)
    : (a, b) => String(b.last_activity_at || b.updated_at).localeCompare(String(a.last_activity_at || a.updated_at)));
  const data = rows.slice(offset, offset + limit);
  return {
    data,
    items: data,
    pagination: { has_more: offset + limit < rows.length, limit, offset, total: rows.length, next_cursor: null },
  };
}
function projectView(project) {
  return { ...project, prompt_template: project.prompt_template || "" };
}
function projectsApi(req, res, url, p) {
  const match = p.match(/^\/api\/organizations\/([^/]+)\/projects(?:_v2)?(\/.*)?$/);
  if (!match) return false;
  const method = req.method;
  const rest = match[2] || "";
  const emptyPage = {
    items: [], data: [], next_cursor: null, has_more: false, facets: null,
    pagination: { has_more: false, next_cursor: null, cursor: null, limit: 30, offset: 0, total: 0 },
  };
  if (rest === "/count" && method === "GET") {
    const rows = [...PROJECTS.values()].filter((row) => !row.archived_at);
    return json(res, { count: rows.length }), true;
  }
  if (rest === "/request_haystack") return json(res, {}), true;
  // 会话移动：把会话挪进/挪出项目。请求体 {conversation_uuids:[...], project_uuid: uuid|null}
  // 放在 projectsApi 里，避免被通用的未知 sub 空分页分支吞掉。
  if (rest === "/move_conversations" && method === "POST") {
    return readBody(req, (raw) => {
      const body = decodeJsonBody(req, raw);
      const target = typeof body.project_uuid === "string" && body.project_uuid ? body.project_uuid : null;
      const ids = Array.isArray(body.conversation_uuids) ? body.conversation_uuids : [];
      for (const id of ids) {
        if (CONV_STATE.has(id)) {
          CONV_STATE.get(id).chat_project_id = target;
          CONV_STATE.get(id).updated_at = now();
        }
      }
      stateStore.flush();
      json(res, { moved: ids.length, project_uuid: target });
    }), true;
  }
  if (!rest) {
    if (method === "GET") return json(res, projectsPage(url)), true;
    if (method === "POST") {
      readBody(req, (raw) => {
        const body = decodeJsonBody(req, raw);
        const project = projectRecord(body?.project ?? body ?? {});
        PROJECTS.set(project.uuid, project);
        saveProjects();
        json(res, projectView(project), 201);
      });
      return true;
    }
    return json(res, emptyPage), true;
  }
  const tail = rest.match(/^\/([^/]+)(\/.*)?$/);
  if (!tail) return json(res, emptyPage), true;
  const uuid = tail[1];
  const sub = tail[2] || "";
  const project = PROJECTS.get(uuid);
  if (sub === "/settings") {
    if (method === "PATCH" || method === "PUT") {
      readBody(req, (raw) => {
        const body = decodeJsonBody(req, raw);
        if (project) {
          const patch = body?.project ?? body?.settings ?? body ?? {};
          for (const key of ["name", "description", "instructions", "is_starred", "is_private", "archived_at"]) {
            if (patch[key] !== undefined) project[key] = patch[key];
          }
          project.updated_at = now();
          project.last_activity_at = project.updated_at;
          saveProjects();
        }
        json(res, { settings: {} });
      });
      return true;
    }
    return json(res, { settings: {} }), true;
  }
  if (sub === "/kb/stats") return json(res, { documents: 0, files: 0, syncs: 0, conversations: 0, total_size: 0 }), true;
  if (sub === "/conversations_v2") {
    // 详情页预取三件套之一；data 必须是数组，否则前端进 fatal boundary。
    // 返回归属本项目的本地会话（chat_project_id === 项目 uuid）。
    const limit = Math.min(Math.max(Number(url.searchParams.get("limit")) || 30, 1), 100);
    const offset = Math.max(Number(url.searchParams.get("offset")) || 0, 0);
    const rows = [...CONV_STATE.values()]
      .filter((c) => c.chat_project_id === uuid)
      .sort((a, b) => String(b.updated_at).localeCompare(String(a.updated_at)));
    const page = rows.slice(offset, offset + limit).map((c) => convToRest(c));
    return json(res, {
      data: page,
      items: page,
      pagination: { has_more: offset + limit < rows.length, next_cursor: null, limit, offset, total: rows.length },
    }), true;
  }
  if (sub === "/accounts") {
    return json(res, {
      data: [{ account: { uuid: ACCOUNT.uuid, name: ACCOUNT.name, email_address: ACCOUNT.email }, role: "owner" }],
      pagination: { has_more: false, next_cursor: null, limit: 30, offset: 0, total: 1 },
    }), true;
  }
  if (sub === "/permissions") {
    return json(res, [
      "chat_project:chat:view", "chat_project:chat:create", "chat_project:members:manage",
      "chat_project:owner:manage", "chat_project:knowledge:edit", "chat_project:knowledge:view",
      "chat_project:delete", "chat_project:view", "chat_project:settings:edit",
    ]), true;
  }
  if (sub === "/activity_v2") return json(res, emptyPage), true;
  if (sub === "/accounts_bulk" || sub === "/groups_bulk" || sub === "/upload") return json(res, {}), true;
  // 触发知识库重同步：回 done 状态避免前端把项目标记成"同步中"再轮询 /syncs。
  if (sub === "/sync" && method === "POST") {
    return json(res, { kb_resync_status: "done", gdrive_resource_backfill_triggered: false }), true;
  }
  if (sub === "/roles") return json(res, { group_assignments: [], data: [], items: [] }), true;
  if (sub === "/docs" || sub === "/files") return json(res, emptyPage), true;
  // /syncs 消费端要求顶层数组（Array.isArray 校验）；行带 kb_resync_status:"done"
  // 避免 "in progress" 行驱动前端 5 秒轮询。
  if (sub === "/syncs" && method === "GET") return json(res, []), true;
  if (sub === "/syncs") return json(res, {}), true;
  if (sub === "/report" && method === "POST") return json(res, { ok: true }), true;
  if (sub) return json(res, emptyPage), true;
  if (!project) {
    if (method === "DELETE") { res.writeHead(204, { "content-length": 0 }); return res.end(), true; }
    return json(res, { error: "not_found", message: "Project not found" }, 404), true;
  }
  if (method === "DELETE") {
    PROJECTS.delete(uuid);
    saveProjects();
    res.writeHead(204, { "content-length": 0 });
    return res.end(), true;
  }
  if (method === "PATCH" || method === "PUT") {
    readBody(req, (raw) => {
      const body = decodeJsonBody(req, raw);
      const patch = body?.project ?? body ?? {};
      for (const key of ["name", "description", "instructions", "prompt_template", "is_starred", "is_private", "type", "archived_at"]) {
        if (patch[key] !== undefined) project[key] = patch[key];
      }
      // 归档/取消归档走 PUT {is_archived:true|false}，不是 archived_at。
      if (patch.is_archived !== undefined) {
        project.archived_at = patch.is_archived ? now() : null;
        if (patch.is_archived) project.is_starred = false;
      }
      project.updated_at = now();
      project.last_activity_at = project.updated_at;
      saveProjects();
      json(res, projectView(project));
    });
    return true;
  }
  // 详情响应：include_has_sync_sources 对应 has_sync_sources 布尔，include_counts=false
  // 表示前端不要 counts 字段（本地无知识库，缺省即可）。
  return json(res, { ...projectView(project), has_sync_sources: false }), true;
}

// 新建项目弹窗会拉 GitHub 仓库列表与 GitHub App 安装状态；这些请求如果转发上游，
// 20 秒超时后会以未处理的 socket error 打崩整个 proxy。本地模式一律回空。
// RUM / 事件上报同理，本地吞掉。
function localCodeApi(req, res, url, p) {
  if (p === "/api/v2/rum" || p.startsWith("/api/event_logging/")) {
    json(res, {});
    return true;
  }
  // /api/eval/*（Statsig/实验求值）：转发上游 403，前端 gate 求值失败会连带弹窗类组件
  // 进入 failed 态。本地回空配置。
  if (/^\/api\/eval\//.test(p)) {
    json(res, {});
    return true;
  }
  // frame 契约：转发上游 403，Artifacts/Frame 面板会报加载失败。本地回最小契约。
  if (p === "/api/frame/contract/latest") {
    json(res, { contract: null, version: null });
    return true;
  }
  // 插件目录端点表与 Artifacts MCP 的 GET 探活（POST 走 artifactService.handleMcp）。
  if (p === "/api/directory/server-urls") {
    json(res, { claude_ai: "https://claude.ai", api: "https://api.anthropic.com" });
    return true;
  }
  if (req.method === "GET" && p === "/api/artifacts/mcp") {
    json(res, {});
    return true;
  }
  if (/^\/api\/organizations\/[^/]+\/code\/repos$/.test(p)) {
    json(res, {
      repos: [], data: [], items: [],
      pagination: { has_more: false, next_cursor: null, total: 0, limit: 100, offset: 0 },
    });
    return true;
  }
  if (/^\/api\/organizations\/[^/]+\/code\/repos\/resync$/.test(p)) {
    json(res, { ok: true });
    return true;
  }
  if (p === "/v1/code/github/org-connection/installations-status") {
    json(res, { installations: [], org_connection: null, connected: false, viewer: null });
    return true;
  }
  if (p === "/v1/code/mcp-config/prewarm") {
    json(res, {});
    return true;
  }
  return false;
}

// Code 面板的「项目」在 6.x 前端实际走 /v1/code/channels（createChannel / listChannels /
// updateChannel）。创建项目 = 创建一个 channel；这里把 channel 映射到本地 project 存储，
// 保证同一个 id 既能从 channels 读，也能从 /api/organizations/{org}/projects/{id} 读。
function channelView(project) {
  return {
    id: project.uuid,
    channel_id: project.uuid,
    name: project.name,
    visibility: project.is_private ? "private" : "public",
    is_private: project.is_private !== false,
    topic: project.description || "",
    icon: project.icon ?? null,
    color: project.color ?? null,
    archived: !!project.archived_at,
    is_archived: !!project.archived_at,
    created_at: project.created_at,
    updated_at: project.updated_at,
    creator: project.creator,
    created_by_account_id: project.creator?.uuid ?? ACCOUNT.uuid,
    caller_relations: ["owner"],
    caller_through_group: false,
    // 侧栏/详情用 members 判断「joined」并把 channel 收进本地 space store；
    // 空数组会让项目出现在列表里却在详情页被当作不存在。
    members: [{ account_id: ACCOUNT.uuid, role: "owner", through_group: false }],
    members_truncated: false,
    member_count: 0,
    group_count: 0,
    context_sources: [],
    unavailable_actions: [],
    space_id: null,
    has_unread: false,
    unread_count: 0,
  };
}
function channelsApi(req, res, url, p) {
  const match = p.match(/^\/v1\/code\/channels(?:\/([^/]+))?(\/.*)?$/);
  if (!match) return false;
  const id = match[1] ? decodeURIComponent(match[1]) : null;
  const sub = match[2] || "";
  const all = () => [...PROJECTS.values()].filter((row) => !row.archived_at).map(channelView);
  if (!id) {
    if (req.method === "GET") {
      const channels = all();
      return json(res, { channels, data: channels, items: channels, has_more: false, next_cursor: null }), true;
    }
    if (req.method === "POST") {
      readBody(req, (raw) => {
        const body = decodeJsonBody(req, raw);
        const project = projectRecord({
          name: body.name,
          description: body.topic ?? body.description,
          is_private: body.visibility !== "public",
        });
        project.icon = body.icon ?? null;
        project.color = body.color ?? null;
        PROJECTS.set(project.uuid, project);
        saveProjects();
        json(res, { channel: channelView(project) }, 201);
      });
      return true;
    }
    return json(res, { channels: [], data: [], items: [], has_more: false }), true;
  }
  const project = PROJECTS.get(id);
  if (sub === "/archive" || sub === "/unarchive") {
    if (project) {
      project.archived_at = sub === "/archive" ? now() : null;
      project.updated_at = now();
      project.last_activity_at = project.updated_at;
      saveProjects();
    }
    return json(res, { channel: project ? channelView(project) : null }), true;
  }
  if (sub === "/config") return json(res, { channel_id: id, default_environment_id: null }), true;
  if (sub === "/remote-control-preapproval") return json(res, { folders: [], paths: [] }), true;
  if (sub === "/threads" || sub === "/timeline") {
    return json(res, { data: [], items: [], threads: [], has_more: false, next_cursor: null }), true;
  }
  if (sub) return json(res, {}), true;
  if (!project) return json(res, { error: "not_found" }, 404), true;
  if (req.method === "GET") {
    const view = channelView(project);
    // 同时给 `{channel}` 包装和顶层字段：不同版本的详情 hook 读取位置不一样。
    return json(res, { ...view, channel: view }), true;
  }
  if (req.method === "PATCH" || req.method === "PUT") {
    readBody(req, (raw) => {
      const body = decodeJsonBody(req, raw);
      if (typeof body.name === "string") project.name = body.name;
      if (typeof body.topic === "string") project.description = body.topic;
      if (typeof body.description === "string") project.description = body.description;
      if (body.visibility !== undefined) project.is_private = body.visibility !== "public";
      if (body.icon !== undefined) project.icon = body.icon;
      if (body.color !== undefined) project.color = body.color;
      project.updated_at = now();
      project.last_activity_at = project.updated_at;
      saveProjects();
      json(res, { channel: channelView(project) });
    });
    return true;
  }
  if (req.method === "DELETE") {
    PROJECTS.delete(id);
    saveProjects();
    res.writeHead(204, { "content-length": 0 });
    return res.end(), true;
  }
  return json(res, { channel: channelView(project) }), true;
}

// Cowork 总开关：GrowthBook 功能 `yukon_silver`，id 是功能名的 Java hashCode（574905726）。
// 录制模板里它是 false，新版 Claude 因此只显示 Chat / Code。必须在模板合并之后改写，
// 否则模板的 false 会盖掉。id 的算法跟模板走：只改写模板自带的 GrowthBook 表，
// 合成兜底（localBootstrap 的空表）的 hashing_algorithm 不同，不往里塞。
const COWORK_FEATURE_ID = "574905726";
function forceCowork(result, template) {
  if (!template?.org_growthbook?.features || !result.org_growthbook?.features) return;
  result.org_growthbook = {
    ...result.org_growthbook,
    features: { ...result.org_growthbook.features, [COWORK_FEATURE_ID]: { defaultValue: true } },
  };
}

// Projects 总开关：GrowthBook 功能 `sink_planter_vase`（Java hashCode 1946445808）。
// 录制模板里它是 false，1P 前端据此隐藏 Projects 入口；本地模式按最高档放开。
// claude_ai_projects_limits（id 3704139687）模板里已有 {max_free_projects:5}，
// 付费套餐不看这个上限，不需要改。
const PROJECTS_FEATURE_ID = "1946445808";
function forceProjects(result, template) {
  if (!template?.org_growthbook?.features || !result.org_growthbook?.features) return;
  result.org_growthbook = {
    ...result.org_growthbook,
    features: { ...result.org_growthbook.features, [PROJECTS_FEATURE_ID]: { defaultValue: true } },
  };
}

// Code 面板的 Projects 入口由 GrowthBook 的 amber_tributary_* 开关控制：
//   epitaxy-projects 的 gate = amber_tributary_heron && amber_tributary_osprey
//   wren / ptarmigan 控制侧栏项目区块与归档视图。模板里全是 false，本地按最高档打开。
const CODE_PROJECT_FLAGS = [
  "amber_tributary_heron",
  "amber_tributary_osprey",
  "amber_tributary_wren",
  "amber_tributary_ptarmigan",
];
function javaHashId(name) {
  let hash = 0;
  for (const ch of name) hash = (Math.imul(31, hash) + ch.charCodeAt(0)) | 0;
  return String(hash >>> 0);
}
function forceCodeProjects(result) {
  if (!result.org_growthbook?.features) return;
  const features = { ...result.org_growthbook.features };
  for (const name of CODE_PROJECT_FLAGS) features[javaHashId(name)] = { defaultValue: true };
  result.org_growthbook = { ...result.org_growthbook, features };
}

// claude_ai_hub_web_delivery：Claude 的合并式主页，对话和 Cowork 合在一个输入框里，没有「对话 | Cowork」切换。
// 录制模板的账号在 chatwork_free_experiment 实验组里，这个开关是开的。设置里没选合并式主页时关掉它，
// 用回有切换的经典主页。
const HUB_DELIVERY_FEATURE_ID = "2436273311";
function useClassicHome(result, template) {
  if (template?.org_growthbook?.features && result.org_growthbook?.features) {
    result.org_growthbook = {
      ...result.org_growthbook,
      features: { ...result.org_growthbook.features, [HUB_DELIVERY_FEATURE_ID]: { defaultValue: false } },
    };
  }
  // 合并式主页的代码是按 gated_imports 下发的，光关 GrowthBook 开关不够：前端看到这一项仍会装上它。
  if (result.gated_imports?.claude_ai_hub_web_delivery) {
    const { claude_ai_hub_web_delivery: _hub, ...rest } = result.gated_imports;
    result.gated_imports = rest;
  }
}

// 连接器登录在应用内完成，页面这一侧的开关（桌面端那一侧是 /api/desktop/features 里的 600735300）。
// 较早的录制版本里没有这一项。
const CONNECTOR_SIGN_IN_FEATURE_ID = "1286103945";
function allowConnectorSignIn(result, template) {
  if (!template?.org_growthbook?.features || !result.org_growthbook?.features) return;
  result.org_growthbook = {
    ...result.org_growthbook,
    features: { ...result.org_growthbook.features, [CONNECTOR_SIGN_IN_FEATURE_ID]: { defaultValue: true } },
  };
}

let resolvedBootstrapCache;
// 主页问候语里带着称呼：模板里是「Local User」（脱敏时换的），按设置里的用户名换掉。
const TEMPLATE_DISPLAY_NAME = "Local User";
function withDisplayName(value) {
  if (displayName === TEMPLATE_DISPLAY_NAME) return value;
  if (typeof value === "string") return value.split(TEMPLATE_DISPLAY_NAME).join(displayName);
  if (Array.isArray(value)) return value.map(withDisplayName);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, withDisplayName(item)]));
  return value;
}

function resolvedBootstrap() {
  if (resolvedBootstrapCache) return resolvedBootstrapCache;
  let template = RECORDED_BOOTSTRAP ?? {};
  if (!dataManaged) {
    try { template = JSON.parse(fs.readFileSync(path.join(POC_MOCK, "bootstrap.json"), "utf8")); } catch {}
  }
  const result = normalizeLocalIdentity({
    ...localBootstrap(), ...structuredClone(template),
    intercom_account_hash: null, intercom_user_jwt: null,
  });
  // 模板合并之后覆盖，否则模板里的 blocked_by_org_tier 会盖掉。
  result.current_user_access = applyFeatureOverrides(result.current_user_access);
  result.served_copy = {
    ...result.served_copy,
    "web.plan_name.max_20x": runtime.localization ? "Codex++ 本地网关" : "Codex++ local gateway",
  };
  // 录制账号自己的状态，不属于本地模式：身份验证待办（hold_notice）会让 Claude 弹「完成验证以继续」、拦掉回复。
  result.hold_notice = null;
  result.personalized_greeting = withDisplayName(result.personalized_greeting);
  if (runtime.cowork) {
    result.system_prompts = { ...result.system_prompts, ...coworkSystemPrompts() };
    forceCowork(result, template);
  }
  forceProjects(result, template);
  forceCodeProjects(result);
  if (!runtime.hubHome) useClassicHome(result, template);
  allowConnectorSignIn(result, template);
  if (useOfficialShell) {
    // 模板里的 gated_imports 是录制时线上版本的分块清单，与本机外壳对不上：换成本机版本。
    result.gated_imports = {};
    result.gated_imports_build_id = officialAssets.buildId;
  }
  mergePoolModels(result, runtime);
  resolvedBootstrapCache = result;
  return result;
}

// REST 侧的会话条目：拿录制文件里的第一条当模板，叠动态字段
let REST_CONV_TEMPLATE = null;
/**
 * 模板里录下的 Anthropic 示例技能，内容只能从 Anthropic 下载，本地模式一个都装不上。
 * 原样标成「已启用」的话，Claude 每次同步都要去下载、全部失败（0 downloaded / 5 failed）。
 */
function offlineSkills(data) {
  if (!Array.isArray(data?.skills)) return data;
  return { ...data, skills: data.skills.map((skill) => ({ ...skill, enabled: false })) };
}

function restTime(value, fallback) {
  const date = value ? new Date(value) : null;
  return date && !Number.isNaN(date.getTime()) ? date.toISOString() : fallback;
}

/**
 * 会话详情里的消息。REST 的 /completion 记在 chat_messages；claudeai-rpc 记在 turns，
 * 两边都要能读出来，否则从另一条路径建的会话打开就是空的。
 */
function restMessages(c) {
  // 旧版状态文件可能把数组字段缺省或显式置为 null；新版前端会直接对其调用 .some()/.map()。
  const withArrays = (message) => ({
    ...message,
    files: Array.isArray(message?.files) ? message.files : [],
    files_v2: Array.isArray(message?.files_v2) ? message.files_v2 : [],
    attachments: Array.isArray(message?.attachments) ? message.attachments : [],
    sync_sources: Array.isArray(message?.sync_sources) ? message.sync_sources : [],
  });
  if (c.chat_messages?.length) return c.chat_messages.map(withArrays);
  const messages = [];
  for (const turn of c.turns || []) {
    const created = restTime(turn.created, c.created_at);
    const entry = (uuid, sender, index, parent, text, extra = {}) => withArrays({
      uuid, sender, index, parent_message_uuid: parent ?? null, text,
      content: [{ type: "text", text, citations: [] }],
      created_at: created, updated_at: created, ...extra,
    });
    messages.push(entry(turn.humanId, "human", turn.humanIndex, turn.humanParent, turn.prompt || ""));
    if (turn.complete || turn.text) {
      // artifact 工具调用：把 tool_use / tool_result 放进内容块，前端据此渲染 artifact 卡片。
      const content = [];
      if (turn.text) content.push({ type: "text", text: turn.text, citations: [] });
      for (const call of turn.toolCalls || []) {
        content.push({ type: "tool_use", id: call.id, name: call.name, input: call.input ?? {} });
        content.push({
          type: "tool_result",
          tool_use_id: call.id,
          content: [{ type: "text", text: call.result ?? "" }],
        });
      }
      if (!content.length) content.push({ type: "text", text: turn.text || "", citations: [] });
      messages.push(entry(turn.asstId, "assistant", turn.asstIndex, turn.humanId, turn.text || "",
        { content, ...(turn.complete ? { stop_reason: turn.stopReason === "error" ? "error" : "end_turn" } : {}) }));
    }
  }
  return messages;
}

function convToRest(c, { messages = false } = {}) {
  if (!REST_CONV_TEMPLATE) {
    try {
      if (dataManaged) throw new Error("Managed mode uses synthetic data");
      const f = path.join(POC_MOCK, "api", "conversations.json");
      REST_CONV_TEMPLATE = JSON.parse(fs.readFileSync(f, "utf8")).data[0] ?? {};
    } catch { REST_CONV_TEMPLATE = {}; }
  }
  const live = c.turns?.some((t) => !t.complete);
  const title = c.name && c.name !== "New conversation" ? c.name : "";
  return {
    ...REST_CONV_TEMPLATE,
    // 新版前端会对这些字段直接调用数组/对象操作；录制的 conversations.json 可能为空，
    // 而旧模板字段也可能是 null，因此本地 API 必须保证返回正确形状。
    settings: REST_CONV_TEMPLATE.settings && typeof REST_CONV_TEMPLATE.settings === "object" ? REST_CONV_TEMPLATE.settings : {},
    is_starred: REST_CONV_TEMPLATE.is_starred ?? false,
    is_archived: REST_CONV_TEMPLATE.is_archived ?? false,
    files: Array.isArray(REST_CONV_TEMPLATE.files) ? REST_CONV_TEMPLATE.files : [],
    sync_sources: Array.isArray(REST_CONV_TEMPLATE.sync_sources) ? REST_CONV_TEMPLATE.sync_sources : [],
    uuid: c.uuid,
    id: c.uuid,
    name: title,
    summary: title,
    model: c.model || runtime.model,
    // Code 会话行必须带项目归属；project_uuid 是 Chat 侧字段，同值双发保持两条消费路径兼容
    chat_project_id: c.chat_project_id ?? null,
    project_uuid: c.chat_project_id ?? REST_CONV_TEMPLATE.project_uuid ?? null,
    created_at: c.created_at,
    updated_at: c.updated_at,
    current_leaf_message_uuid: c.leafMessageId || c.current_leaf_message_uuid || null,
    live_status: live ? "running" : null,
    last_settled_at: live ? null : c.updated_at,
    ...(messages ? { chat_messages: restMessages(c) } : {}),
  };
}

function extractTitleInput(rawText) {
  const text = typeof rawText === "string" ? rawText.trim() : "";
  if (!text) return "";
  const first = text.match(/^Message 1:\s*([\s\S]*?)(?:\n+\s*Message 2:|$)/i);
  return (first ? first[1] : text).trim();
}

function fallbackSessionTitle(rawText, emptyFallback = "New task") {
  const cleaned = extractTitleInput(rawText)
    .replace(/^["'“”‘’`《【]+|["'“”‘’`》】]+$/g, "")
    .replace(/\s+/g, " ")
    .trim();
  if (!cleaned) return emptyFallback;
  return cleaned.length > 30 ? `${cleaned.slice(0, 30)}…` : cleaned;
}

function sanitizeGeneratedTitle(raw) {
  if (typeof raw !== "string") return "";
  const tagged = raw.match(/<title>([\s\S]*?)<\/title>/i);
  const line = (tagged ? tagged[1] : raw)
    .replace(/\r?\n[\s\S]*$/, "")
    .replace(/^["'“”‘’`*#:\s]+|["'“”‘’`*\s]+$/g, "")
    .replace(/\s+/g, " ")
    .trim();
  if (!line) return "";
  return line.length > 80 ? `${line.slice(0, 80)}…` : line;
}

function generateSessionTitle(rawText, requestedModel, emptyFallback, callback) {
  const input = extractTitleInput(rawText);
  const fallback = fallbackSessionTitle(input, emptyFallback);
  if (!input) return callback(fallback);
  let target;
  try {
    target = gatewayTarget(runtime, "/v1/messages");
  } catch {
    return callback(fallback);
  }
  const model = gatewayModel(runtime, runtime.smallModel || requestedModel || runtime.model);
  const payload = JSON.stringify({
    model,
    max_tokens: 128,
    stream: false,
    // 推理模型默认先输出 thinking，标题这种短任务会被 thinking 吃满 budget。
    thinking: { type: "disabled" },
    system: "Generate a concise session title (3-8 words or short Chinese phrase) in the same language as the user message. Reply with only the title, no quotes or markdown.",
    messages: [{ role: "user", content: input.slice(0, 2000) }],
  });
  let settled = false;
  const finish = (title) => {
    if (settled) return;
    settled = true;
    callback(title || fallback);
  };
  const greq = gatewayRequest(
    target,
    {
      hostname: target.hostname,
      port: target.port || (target.protocol === "https:" ? 443 : 80),
      path: target.pathname + target.search,
      method: "POST",
      headers: {
        "content-type": "application/json",
        "content-length": Buffer.byteLength(payload),
        "x-api-key": runtime.key,
        authorization: `Bearer ${runtime.key}`,
        "anthropic-version": "2023-06-01",
      },
      // 网关在跑长任务时首字可能排队：标题生成等久一点，别退回“截断提示词”。
      timeout: 20000,
    },
    (gres) => {
      const chunks = [];
      gres.on("data", (chunk) => chunks.push(chunk));
      gres.on("end", () => {
        if (gres.statusCode !== 200) return finish(fallback);
        try {
          const data = JSON.parse(Buffer.concat(chunks).toString("utf8"));
          const text = Array.isArray(data.content)
            ? data.content.filter((b) => b?.type === "text" && typeof b.text === "string").map((b) => b.text).join("")
            : (typeof data.completion === "string" ? data.completion : "");
          finish(sanitizeGeneratedTitle(text) || fallback);
        } catch {
          finish(fallback);
        }
      });
    },
  );
  greq.on("timeout", () => { greq.destroy(); finish(fallback); });
  greq.on("error", () => finish(fallback));
  greq.end(payload);
}

function mockApi(req, res, url) {
  const p = url.pathname.replace(/\/+$/, "");
  const method = req.method;

  // Artifacts：frame 列表/类型/文档/新建 和 claude-artifacts MCP。
  // 必须在通用 /api/frame/* 兜底之前，否则会先落到空 pageShape。
  if (artifactService.handleFrameApi(method, url, req, res)) return;
  if (method === "POST" && p === "/api/artifacts/mcp") return serveArtifactsMcp(req, res, url, url.hostname);

  // Claude Code CLI / Code 面板的 bootstrap 也会打到 claude.ai 这一侧。
  // 不本地接住会落到上游 claude.ai 并得到 403，Code 面板会一直等账号/配置就绪。
  if (/^\/api\/claude_cli\/bootstrap/.test(p)) {
    return json(res, { client_data: {}, settings: {}, config: {}, enabled: true, environments: [], sessions: [], plugins: [], items: [], data: [] });
  }
  if (/^\/api\/claude_cli\//.test(p)) {
    return json(res, { settings: {}, config: {}, enabled: true, data: [], items: [], sessions: [], environments: [] });
  }

  // Code 的上下文来自 CLI model_selector，不读取网页的 hard_limit。
  const selector = p.match(/^\/api\/(?:organizations\/[^/]+\/)?model_selector\/([^/]+)$/);
  if (method === "GET" && selector) {
    const catalog = modelSelectors(runtime);
    const config = catalog.model_selector_config.find((entry) => entry.id === selector[1]);
    const state = catalog.model_selector_state.find((entry) => entry.id === selector[1]);
    return json(res, {
      model_selector_config: config ? [config] : [],
      model_selector_state: state ? [state] : [],
      organization_uuid: ORG.uuid,
    });
  }

  const convGet = p.match(/\/chat_conversations\/([0-9a-f-]{36})$/);
  if (convGet && method === "GET") {
    return json(res, convToRest(ensureConv(convGet[1]), { messages: true }));
  }

  // 会话列表：静态模板 + 运行期动态会话（RPC 建的）合并，按更新时间倒序
  if (/\/chat_conversations_v2$/.test(p) && method === "GET") {
    const f = path.join(POC_MOCK, "api", "conversations.json");
    let base = { data: [], has_more: false };
    if (!dataManaged) {
      try { base = JSON.parse(fs.readFileSync(f, "utf8")); } catch {}
    }
    const dynamic = [...CONV_STATE.values()].map(convToRest);
    const seen = new Set(dynamic.map((c) => c.uuid));
    const merged = [...dynamic, ...(base.data ?? []).filter((c) => !seen.has(c.uuid))];
    merged.sort((a, b) => String(b.updated_at).localeCompare(String(a.updated_at)));
    return json(res, { ...base, data: merged });
  }

  // 录制下来的真实接口形状（mock/api/*.json）
  const apiMap = [
    [/\/reflections\/settings$/, "reflections_settings"],
    [/\/user_settings$/, "claude_code_user_settings"],
    [/\/mcp\/remote_servers_with_connection$/, "mcp_servers"],
    [/\/memory\/settings$/, "memory_settings"],
    [/^\/api\/account_profile$/, "account_profile"],
    [/\/trial_status$/, "trial_status"],
    [/\/skills\/list-skills$/, "skills"],
    [/\/experiences\/claude_web$/, "experiences"],
  ];
  for (const [re, slug] of apiMap) {
    if (re.test(p)) {
      const f = path.join(POC_MOCK, "api", `${slug}.json`);
      if (!dataManaged && fs.existsSync(f)) {
        try {
          const data = JSON.parse(fs.readFileSync(f, "utf8"));
          if (slug === "skills") return json(res, offlineSkills(data));
          return slug === "account_profile"
            ? jsonWithActiveOrg(res, normalizeAccountProfile(data))
            : json(res, data);
        } catch {}
      }
      if (dataManaged) {
        const synthetic = {
          reflections_settings: { time_alert_daily_minutes: null, quiet_hours: null },
          claude_code_user_settings: {
            userId: ACCOUNT.uuid, version: 1, lastModified: "2026-01-01T00:00:00Z",
            checksum: "local-1", content: { entries: {} },
          },
          mcp_servers: [],
          memory_settings: {
            enabled_saffron: null, enabled_saffron_search: false, enabled_melange: null,
            memory_mode: "melange", classic_mode_available: false,
            melange_available: false, melange_imported_at: null,
          },
          account_profile: {
            work_function: "", conversation_preferences: null, cowork_global_instructions: null,
            cowork_instructions_union: false, conversation_preferences_cloud_max_chars: 10000,
            conversation_preferences_over_cloud_max_chars: false,
            locale: runtime.localization ? "zh-Hans" : "en-US", onboarding_topics: [], science_fields: [],
            avatar: null, pixel_avatar: null, avatar_image_url: null, display_avatar: null,
          },
          trial_status: { eligible: false, in_trial: false, trial_status: null },
          skills: { skills: [] },
          experiences: { experiences: [], rules: { global: { rate_limit: null, cooldown: null }, placements: {}, tiers: {} } },
        };
        return slug === "account_profile"
          ? jsonWithActiveOrg(res, normalizeAccountProfile(synthetic[slug]))
          : json(res, synthetic[slug]);
      }
    }
  }

  // Code 设置页直接对响应调用 filter，已连接实例必须返回顶层数组。
  if (method === "GET" && /^\/api\/oauth\/organizations\/[^/]+\/oauth_tokens$/.test(p)) {
    return json(res, []);
  }

  // 本地模拟账号不需要身份验证；空对象会被设置页判为尚未完成验证。
  if (method === "GET" && /^\/api\/organizations\/[^/]+\/kyc_status$/.test(p)) {
    return json(res, { status: "not_required", should_poll: false });
  }
  // 原生桌面使用已求值的 GrowthBook 结果；用户开关和系统权限仍由客户端检查。
  if (method === "GET" && p === "/api/desktop/features") {
    const features = {
      "1291166712": {
        value: { enabled: runtime.computerUse, appScopedEnabled: runtime.computerUse && runtime.backgroundMode },
        on: runtime.computerUse, off: !runtime.computerUse, source: "force",
        experiment: null, experimentResult: null,
      },
      // Windows 上计算机使用的另一道门：Claude 里是 `process.platform==="win32"&&!X("40173473")` 就不给开，
      // 设置页显示「您的账户尚未启用计算机使用功能」。macOS 不读它。
      "40173473": {
        value: runtime.computerUse, on: runtime.computerUse, off: !runtime.computerUse, source: "force",
        experiment: null, experimentResult: null,
      },
      // 账号插件的同步：关着时桌面端不读已装列表、不下载插件、会话里也不挂载（见 pluginApi）。
      "2340532315": {
        value: true, on: true, off: false, source: "force", experiment: null, experimentResult: null,
      },
      // 连接器登录在应用内完成（见 connectors.mjs）：关着时桌面端不报这个能力，页面会改走经过真 claude.ai 的登录。
      "600735300": {
        value: true, on: true, off: false, source: "force", experiment: null, experimentResult: null,
      },
    };
    // 后台模式的 macOS 版本上限（Claude 内置默认 26.x，系统更新就提示「暂不支持」）。
    // 强制开启时把上限抬到 99，新系统也放行。
    if (runtime.forceBackgroundMode) {
      features["1346958739"] = {
        value: { major: 99, minor: 9999 }, on: true, off: false, source: "force",
        experiment: null, experimentResult: null,
      };
    }
    return json(res, { features });
  }

  // 账户页会直接读取 reasons.length；本地后端不开放账号删除。
  if (method === "GET" && p === "/api/account/deletion-allowed") {
    return json(res, { deletable: false, reasons: [], display_message: null });
  }
  if (method === "GET" && p === "/api/auth/trusted_devices") {
    return json(res, { devices: [] });
  }
  if (method === "GET" && p === "/api/auth/mfa") {
    return json(res, { mfa_enrolled: false, methods: [] });
  }
  if (method === "GET" && p === "/api/auth/sessions/list-active") {
    return json(res, { data: [], pagination: { has_more: false, total: 0 } });
  }
  if (method === "GET" && /^\/api\/stripe\/[^/]+\/invoices$/.test(p)) {
    return json(res, { invoices: [], next_page: null });
  }
  if (method === "GET" && /^\/api\/organizations\/[^/]+\/user_artifacts$/.test(p)) {
    return json(res, { artifacts: [] });
  }
  if (method === "GET" && /^\/api\/organizations\/[^/]+\/user_artifacts\/count$/.test(p)) {
    return json(res, { count: 0 });
  }
  // /api/frame/frames[/external] 由 artifactService.handleFrameApi 处理（mockApi 开头已调用）。
  const notifications = p.match(/^\/api\/organizations\/([^/]+)\/notification\/preferences$/);
  if (notifications && (method === "GET" || method === "PATCH")) {
    const org = notifications[1];
    const state = NOTIFICATION_SETTINGS.get(org) ?? {
      preferences: { feature_preference: {} },
      effective_preferences: {},
      push_reachability: {
        has_active_channel: false, platforms: [], most_recent_token_refresh: null,
      },
    };
    NOTIFICATION_SETTINGS.set(org, state);
    if (method === "GET") return json(res, state);
    return readBody(req, (body) => {
      let patch;
      try { patch = JSON.parse(body.toString("utf8"))?.preferences?.feature_preference; } catch {}
      if (!patch || typeof patch !== "object" || Array.isArray(patch)) {
        return json(res, { error: "Invalid notification preferences" }, 400);
      }
      // 按功能和渠道合并，保留未修改项以及显式关闭的 false。
      for (const [feature, channels] of Object.entries(patch)) {
        if (!channels || typeof channels !== "object" || Array.isArray(channels)) continue;
        for (const channel of ["push", "email"]) {
          const key = `enable_${channel}`;
          if (typeof channels[key] !== "boolean") continue;
          const previous = Object.hasOwn(state.preferences.feature_preference, feature)
            ? state.preferences.feature_preference[feature] : {};
          const effective = Object.hasOwn(state.effective_preferences, feature)
            ? state.effective_preferences[feature] : {};
          state.preferences.feature_preference = {
            ...state.preferences.feature_preference, [feature]: { ...previous, [key]: channels[key] },
          };
          state.effective_preferences = {
            ...state.effective_preferences,
            [feature]: { ...effective, [key]: channels[key], [`${channel}_source`]: "explicit" },
          };
        }
      }
      stateStore.changed();
      return json(res, state);
    });
  }

  // 插件安装状态核对：客户端要求 `checked` 数组；通用 library 分页结构会触发加载错误。
  // 空数组表示都还在，桌面端不会删本地已装的插件。
  if (method === "POST" && /^\/api\/organizations\/[^/]+\/library\/plugins\/installed_check$/.test(p)) {
    return json(res, { checked: [] });
  }
  if (pluginApi(req, res, url, p)) return;
  if (connectorApi(req, res, url, p)) return;

  // 分页/列表类接口：客户端会 flatMap 取 .items/.data，回 {} 会出 [undefined] 元素
  // → render 时 TypeError 进 fatal boundary（0NV6PUA 崩溃页的来源）
  // 列表页校验（shared-l-p-m-w-0 rG）：{data:[...], pagination:{has_more:boolean}} 必须成立
  const pageShape = {
    items: [], data: [], next_cursor: null, has_more: false, facets: null,
    pagination: { has_more: false, next_cursor: null, cursor: null },
  };
  if (/\/library(\/|$)/.test(p)) return json(res, pageShape);
  if (projectsApi(req, res, url, p)) return;
  if (localCodeApi(req, res, url, p)) return;
  // Code 模式 OAuth：刷新 token（被通用 /v1/ 兜底吃掉会导致 stale_relogin 常驻）
  if (p === "/v1/oauth/token" && req.method === "POST") {
    return json(res, {
      access_token: "claude-local-access-" + crypto.randomBytes(16).toString("hex"),
      refresh_token: "claude-local-refresh-" + crypto.randomBytes(16).toString("hex"),
      token_type: "bearer",
      expires_in: 86400,
      scope: "user:profile user:inference user:sessions:claude_code",
      created_at: Math.floor(Date.now() / 1000),
    });
  }
  // /v1/code/sessions/watch 是 EventSource：必须 text/event-stream
  // 实测桌面端也会直接对 /v1/code/sessions 开 EventSource；按 Accept 分流，
  // 否则 EventSource 收到 application/json 会中断连接，Code 面板永远停在骨架屏。
  const wantsSse = req.headers.accept?.includes("text/event-stream");
  if (p === "/v1/code/sessions/watch" || p.startsWith("/v1/code/sessions/watch") ||
      (wantsSse && /^\/v1\//.test(p))) {
    res.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-store",
      connection: "keep-alive",
    });
    res.write(`event: keep_alive\ndata: {}\n\n`);
    const ka = setInterval(() => res.write(`event: keep_alive\ndata: {}\n\n`), 25000);
    res.on("close", () => clearInterval(ka));
    return;
  }
  // ── Code 会话列表（/v1/code/sessions）：支持 chat_project_id 过滤 ──
  // 项目详情页/侧边栏按项目拉会话；响应行带 chat_project_id。前端把 sessions/data 都当数组消费。
  if (/^\/v1\/code\/sessions$/.test(p) && method === "GET" && url.searchParams.get("chat_project_id")) {
    const projectId = url.searchParams.get("chat_project_id");
    const limit = Math.min(Math.max(Number(url.searchParams.get("limit")) || 30, 1), 100);
    const cursor = Number(url.searchParams.get("cursor")) || 0;
    const rows = [...CONV_STATE.values()]
      .filter((c) => c.chat_project_id === projectId)
      .sort((a, b) => String(b.updated_at).localeCompare(String(a.updated_at)));
    const page = rows.slice(cursor, cursor + limit);
    const sessionRow = (c) => ({
      id: c.uuid,
      uuid: c.uuid,
      session_id: c.uuid,
      name: c.name || "New task",
      title: c.name || "New task",
      chat_project_id: c.chat_project_id ?? null,
      project_uuid: c.chat_project_id ?? null,
      session_status: c.turns?.some((t) => !t.complete) ? "running" : "idle",
      status: c.turns?.some((t) => !t.complete) ? "running" : "idle",
      lifecycle_status: c.turns?.some((t) => !t.complete) ? "running" : "idle",
      created_at: c.created_at,
      updated_at: c.updated_at,
      model: c.model || runtime.model,
    });
    const shaped = page.map(sessionRow);
    return json(res, {
      sessions: shaped,
      data: shaped,
      items: shaped,
      next_cursor: cursor + limit < rows.length ? String(cursor + limit) : null,
      has_more: cursor + limit < rows.length,
    });
  }
  // 会话移动的另一个可能形状 /projects/move_conversations 已在 projectsApi 内处理；
  // 这里保留独立路径以防前端把它打在组织层之外（以日志捕获为准）。
  if (method === "POST" && /\/move_conversations$/.test(p) && !/\/projects\/move_conversations$/.test(p)) {
    return readBody(req, (raw) => {
      const body = decodeJsonBody(req, raw);
      const target = typeof body.project_uuid === "string" && body.project_uuid ? body.project_uuid : null;
      const ids = Array.isArray(body.conversation_uuids) ? body.conversation_uuids : [];
      for (const id of ids) {
        if (CONV_STATE.has(id)) {
          CONV_STATE.get(id).chat_project_id = target;
          CONV_STATE.get(id).updated_at = now();
        }
      }
      stateStore.flush();
      json(res, { moved: ids.length, project_uuid: target });
    });
  }

  if (channelsApi(req, res, url, p)) return;
  // 代码会话/环境（epitaxy 路由）：(n ?? Ra).filter 要求字段为数组
  if (/^\/v1\//.test(p)) {
    return json(res, {
      sessions: [], triggers: [], environments: [], data: [], items: [],
      next_cursor: null, has_more: false,
    });
  }
  if (/\/marketplaces\//.test(p)) {
    return json(res, { ...pageShape, marketplaces: [] });
  }
  // /api/frame/* 已由 artifactService.handleFrameApi 处理；这里只兜未知子路径（pageShape 空结构）。
  if (p.startsWith("/api/frame/")) return json(res, pageShape);
  if (method === "GET" && /^\/api\/organizations\/[^/]+\/plugins\/registry$/.test(p)) return json(res, { data: [] });
  // 客户端按 plugin id 读取元数据字典，每个值都必须是对象。
  if (p.endsWith("/cowork_plugin_metadata")) return json(res, {});

  // Code 模式设备注册：POST 提交 enclave 公钥注册设备行，GET 要看到 {id, k} 行；
  // 空 {} 会触发 device_register_miss(no_row_pk) → "Couldn't verify your sign-in"
  if (/\/cowork\/remote_devices$/.test(p)) {
    if (req.method === "POST" || req.method === "PUT") {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        try {
          const d = JSON.parse(body);
          DEVICE_ROW = {
            id: crypto.randomUUID(),
            ...d,
            k: d.k ?? d.public_key ?? d.enclave_public_key ?? d.key ?? d.device_key,
          };
        } catch {
          DEVICE_ROW ??= { id: crypto.randomUUID() };
        }
        return json(res, DEVICE_ROW);
      });
      return;
    }
    return json(res, {
      devices: DEVICE_ROW ? [DEVICE_ROW] : [],
      rows: DEVICE_ROW ? [DEVICE_ROW] : [],
      items: DEVICE_ROW ? [DEVICE_ROW] : [],
      data: DEVICE_ROW ? [DEVICE_ROW] : [],
    });
  }

  // /upgrade 页：缺这些会 TypeError 进 fatal boundary（toLowerCase of undefined）
  if (/\/subscription_details$/.test(p)) {
    return json(res, {
      plan: { code: `claude_${plan.plan}`, name: plan.label, tier: plan.plan },
      status: "active", billing_type: "stripe_subscription",
      interval: "month", amount: 10000, currency: "usd",
      next_payment_date: null, cancel_at_period_end: false, seats: 1,
    });
  }
  if (p.includes("/api/billing/")) {
    return json(res, { plans: [], prices: [], items: [], currency: "usd", available_plans: [] });
  }
  if (/eligible$/.test(p)) return json(res, { eligible: false });

  // 当前用户访问权限（app 用它判断能否进入主界面 + 套餐判定）
  if (/\/api\/bootstrap\/[^/]+\/current_user_access$/.test(p)) {
    let base = localUserAccess();
    if (!dataManaged) {
      try { base = JSON.parse(fs.readFileSync(path.join(POC_MOCK, "bootstrap.json"), "utf8")).current_user_access ?? base; } catch {}
    }
    base = applyFeatureOverrides(base);
    return jsonWithActiveOrg(res, {
      ...base,
      has_access: true,
      can_access: true,
      status: "allowed",
      is_eligible: true,
      reason: null,
      plan: plan.plan,
      plan_type: plan.plan,
      subscription_plan: plan.plan,
      billing_type: "stripe_subscription",
      rate_limit_tier: plan.rateLimitTier,
      analytics_subscription_plan: plan.analytics,
      organization: ORG,
      organization_uuid: ORG.uuid,
      account: localAccount(ACCOUNT),
      memberships: [localMembership()],
      workspace_memberships: [localMembership()],
      membership: localMembership(),
      is_member: true,
      member: true,
      joined: true,
      activeOrganization: ORG,
      resolved_org_uuid: ORG.uuid,
      feature_flags: BOOTSTRAP.feature_flags,
    });
  }
  // 隐私同意（非 /api 前缀，单独兜底）
  if (p.startsWith("/v1/privacy-consents")) {
    return json(res, { consents: {}, data: [], prefix: "cookies." });
  }

  if (p === "/api/bootstrap" || p === "/api/account" || p === "/api/account_profile") {
    return jsonWithActiveOrg(res, resolvedBootstrap());
  }
  if (method === "GET" && /^\/api\/bootstrap\/[^/]+\/system_prompts$/.test(p)) {
    return json(res, resolvedBootstrap().system_prompts ?? {});
  }
  if (/^\/api\/bootstrap\/[^/]+\/app_start$/.test(p)) {
    return jsonWithActiveOrg(res, resolvedBootstrap());
  }
  if (p === "/api/organizations") {
    return jsonWithActiveOrg(res, { organizations: [ORG], data: [ORG], items: [ORG] });
  }
  // org 级别的设置/记忆/skills 端点：未覆盖的通用 mock 形状会触发前端 parse 失败 notice
  if (/\/memory\/settings/.test(p)) {
    return json(res, { settings: {}, entries: [], items: [] });
  }
  if (/\/skills\/download-dot-skill-file/.test(p)) {
    // 技能内容在 Anthropic 服务器上，本地拿不到。列表里已经都标成未启用（offlineSkills），
    // 用户手动打开时回一个明确的 404，而不是 204 空体（Claude 会报「Response body is null」）。
    return json(res, { type: "error", error: { type: "not_found_error", message: "本地模式没有这个技能的内容" } }, 404);
  }
  // 登录后组织选择页的数据源；item 的 uuid 要放在客户端读的位置（否则 join 打成 /undefined/join）
  if (p === "/api/organizations/discoverable") {
    // 已经加入的 Local 组织不能出现在 discoverable 列表，否则官方桌面端会
    // 在主界面显示“加入您的团队”横幅。显式 join 路由仍保留给旧 onboarding
    // 流程重试，但正常登录态应视为没有可加入的组织。
    return jsonWithActiveOrg(res, { organizations: [], data: [], items: [] });
  }
  // Join 组织确认
  if (/^\/api\/organizations\/[^/]+\/(join|memberships?)$/.test(p) && method !== "GET") {
    return jsonWithActiveOrg(res, {
      ok: true,
      organization: ORG,
      organization_uuid: ORG.uuid,
      membership: localMembership(),
      memberships: [localMembership()],
      joined: true,
      is_member: true,
    });
  }
  // 组织详情不能带 Set-Cookie：Desktop 主进程监听 lastActiveOrg cookie，一变就重查插件白名单，
  // 而白名单检查正是请求这个接口——每次响应都重写 cookie 会形成死循环，主进程卡死、窗口点不动。
  // 活动组织的 cookie 由 bootstrap / account 等入口设置一次就够了。
  if (/^\/api\/organizations\/[^/]+$/.test(p)) {
    return json(res, ORG);
  }
  if (/\/dust\/generate_session_title$/.test(p) && method === "POST") {
    return readBody(req, (raw) => {
      const body = decodeJsonBody(req, raw);
      const firstMsg = body.first_session_message ?? body.message ?? body.prompt ?? "";
      generateSessionTitle(firstMsg, body.model, "New task", (title) => json(res, { title }));
    });
  }
  if (/\/dust\/generate_title_and_branch$/.test(p) && method === "POST") {
    return readBody(req, (raw) => {
      const body = decodeJsonBody(req, raw);
      const firstMsg = body.first_session_message ?? body.message ?? body.prompt ?? "";
      generateSessionTitle(firstMsg, body.model, "New session", (title) => {
        const slug = title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 50).replace(/-+$/, "");
        json(res, { title, branch_name: slug ? `claude/${slug}` : undefined });
      });
    });
  }
  if (/\/chat_conversations$/.test(p)) {
    if (method === "GET") return json(res, [...CONV_STATE.values()].map(convToRest));
    if (method === "POST") {
      return readBody(req, (raw) => {
        const body = decodeJsonBody(req, raw);
        const requestedId = typeof body.uuid === "string" && /^[0-9a-f-]{36}$/i.test(body.uuid)
          ? body.uuid
          : crypto.randomUUID();
        // 项目详情页新建会话时前端会带 project_uuid / chat_project_id / project 字段
        const chatProjectId = typeof body.chat_project_id === "string" && body.chat_project_id
          ? body.chat_project_id
          : typeof body.project_uuid === "string" && body.project_uuid
            ? body.project_uuid
            : null;
        const conv = ensureConv(requestedId, { chatProjectId });
        if (typeof body.name === "string" && body.name.trim()) {
          conv.name = body.name.trim().slice(0, 200);
          conv.updated_at = now();
          stateStore.flush();
        }
        return json(res, convToRest(conv), 201);
      });
    }
  }
  const convTitleMatch = p.match(/\/chat_conversations\/([0-9a-f-]{36})\/title$/);
  if (convTitleMatch && method === "POST") {
    return readBody(req, (raw) => {
      const body = decodeJsonBody(req, raw);
      const conv = ensureConv(convTitleMatch[1]);
      const firstHuman = conv.chat_messages.find((m) => m.sender === "human")?.text || "";
      const source = typeof body.message_content === "string" && body.message_content.trim()
        ? body.message_content
        : firstHuman;
      generateSessionTitle(source, conv.model, "New conversation", (title) => {
        if (title) {
          conv.name = title;
          conv.updated_at = now();
          stateStore.flush();
        }
        json(res, { title });
      });
    });
  }
  const convMatch = p.match(/\/chat_conversations\/([^/]+)$/);
  if (convMatch) {
    if (method === "PUT" || method === "PATCH") {
      return readBody(req, (raw) => {
        const body = decodeJsonBody(req, raw);
        const conv = ensureConv(convMatch[1]);
        if (typeof body.name === "string") {
          conv.name = body.name.trim().slice(0, 200);
          conv.updated_at = now();
          stateStore.flush();
        }
        return json(res, convToRest(conv));
      });
    }
    if (method === "DELETE") {
      CONV_STATE.delete(convMatch[1]);
      stateStore.flush();
      res.writeHead(204, { "content-length": 0 });
      return res.end();
    }
    if (CONV_STATE.has(convMatch[1])) return json(res, convToRest(ensureConv(convMatch[1]), { messages: true }));
    return json(res, { error: "not found" }, 404);
  }
  if (/\/completion$/.test(p)) {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const body = decodeJsonBody(req, Buffer.concat(chunks));
      const prompt = (typeof body.prompt === "string" && body.prompt.trim() ? body.prompt : "")
        || firstUserText(body.messages)
        || firstUserText(body.message)
        || firstUserText(body.content)
        || "";
      const human = body.turn_message_uuids?.human_message_uuid || crypto.randomUUID();
      const asst = body.turn_message_uuids?.assistant_message_uuid || crypto.randomUUID();
      const convUuid = (p.match(/\/chat_conversations\/([0-9a-f-]{36})\/completion/) || [])[1];
      const conv = convUuid ? ensureConv(convUuid) : null;
      const model = gatewayModel(runtime, body.model || conv?.model || process.env.GATEWAY_MODEL);
      if (conv && conv.model !== model) {
        conv.model = model;
        stateStore.changed();
      }
      const sendEv = (ev, obj) => {
        res.write(`event: ${ev}\ndata: ${JSON.stringify(obj)}\n\n`);
      };
      res.writeHead(200, {
        "content-type": "text/event-stream; charset=utf-8",
        "cache-control": "no-cache",
        connection: "keep-alive",
      });
      sendEv("message_start", {
        type: "message_start",
        message: { uuid: asst, parent_uuid: human, model: body.model || model, role: "assistant", content: [] },
      });
      sendEv("content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } });
      if (conv && !conv.chat_messages.some((m) => m.uuid === human)) {
        pushMessage(conv, { uuid: human, sender: "human", text: prompt });
        if ((!conv.name || conv.name === "New conversation") && prompt.trim()) {
          const compact = prompt.replace(/\s+/g, " ").trim();
          conv.name = compact.length > 30 ? `${compact.slice(0, 30)}…` : compact;
          stateStore.changed();
        }
      }
      let acc = "";
      let settled = false;
      // 上游出错时把原因写进回复里：只发 error 事件的话，Claude 只会显示「连接已中断」。
      const fail = (message) => {
        if (settled) return;
        settled = true;
        log(`completion failed${runtime.managed ? "" : `: ${message}`}`);
        const text = `${acc ? "\n\n" : ""}[网关错误：${message}]`;
        sendEv("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text } });
        sendEv("content_block_stop", { type: "content_block_stop", index: 0 });
        sendEv("message_delta", { type: "message_delta", delta: { stop_reason: "end_turn" } });
        sendEv("message_stop", { type: "message_stop" });
        res.end();
      };
      const payload = JSON.stringify({
        model,
        max_tokens: 4096,
        stream: true,
        messages: conv ? conv.chat_messages.map((message) => ({
          role: message.sender === "human" ? "user" : "assistant", content: message.text,
        })) : [{ role: "user", content: prompt }],
      });
      const target = gatewayTarget(runtime, "/v1/messages");
      const greq = gatewayRequest(
        target,
        {
          hostname: target.hostname,
          port: target.port || (target.protocol === "https:" ? 443 : 80),
          path: target.pathname + target.search,
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-api-key": runtime.key,
            authorization: `Bearer ${runtime.key}`,
            "anthropic-version": "2023-06-01",
            accept: "text/event-stream",
          },
        },
        (gres) => {
          if (gres.statusCode < 200 || gres.statusCode >= 300) {
            const chunks = [];
            let size = 0;
            gres.on("data", (c) => { if (size < 65536) { chunks.push(c); size += c.length; } });
            gres.on("end", () => fail(gatewayHttpError(gres.statusCode, Buffer.concat(chunks))));
            gres.on("error", (e) => fail(e.message));
            return;
          }
          const parser = createGatewayStreamParser({
            text: (text) => {
              if (settled) return;
              acc += text;
              sendEv("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text } });
            },
            stop: () => {
              if (settled) return;
              settled = true;
              if (conv && !conv.chat_messages.some((m) => m.uuid === asst)) {
                pushMessage(conv, { uuid: asst, sender: "assistant", parent: human, text: acc, stop_reason: "end_turn" });
                stateStore.flush();
              }
              sendEv("content_block_stop", { type: "content_block_stop", index: 0 });
              sendEv("message_delta", { type: "message_delta", delta: { stop_reason: "end_turn" } });
              sendEv("message_stop", { type: "message_stop" });
              res.end();
            },
            error: fail,
          });
          gres.on("data", (chunk) => parser.write(chunk));
          gres.on("end", () => parser.end());
          gres.on("error", (e) => fail(e.message));
        },
      );
      greq.setTimeout(300_000, () => greq.destroy(new Error("上游超时：5 分钟没有响应")));
      greq.on("error", (e) => fail(e.message));
      res.on("close", () => { if (!settled) { settled = true; greq.destroy(); } });
      greq.end(payload);
    });
    return;
  }
  // 这两个接口 Claude 用 zod 校验：通用兜底的 {} 会报「Invalid BFF response format」，
  // Cowork 提交任务时直接中断（来自 PR #8 的排查）。
  if (method === "GET" && p === "/api/directory/servers") {
    return json(res, { servers: [], next_cursor: null });
  }
  // 插件目录页校验 {data:[...]}；通用 {} 会触发 RegistryFetchError: expected array。
  if (method === "GET" && (p === "/api/directory/plugins" || /^\/api\/organizations\/[^/]+\/directory\/plugins$/.test(p))) {
    return json(res, EMPTY_PLUGIN_DIRECTORY);
  }
  if (method === "GET" && /\/dxt\/(?:extensions|installable_extensions)$/.test(p)) {
    return json(res, { entries: [], total: 0 });
  }
  if (method === "GET" && /^\/api\/organizations\/[^/]+\/activation\/[^/]+\/tasks$/.test(p)) {
    return json(res, { tasks: [] });
  }
  if (/\/completion_status/.test(p)) {
    return json(res, { is_pending: false, is_error: false });
  }
  if (/\/(usage|rate_limits|limits)/.test(p)) {
    // windows 是前端由 limits 转换出的视图。本地网关没有 Anthropic 套餐额度。
    return json(res, {
      limits: [],
      five_hour: null,
      seven_day: null,
      seven_day_oauth_apps: null,
      seven_day_opus: null,
      seven_day_cowork: null,
      extra_usage: { is_enabled: false, monthly_limit: null, used_credits: null, utilization: null, currency: "USD" },
      iguana_necktie: null,
    });
  }
  if (/\/feature|flags|eligib/.test(p)) {
    return json(res, BOOTSTRAP.feature_flags);
  }
  // 未知 API 兜底；有结构要求的接口必须在上方单独实现。
  return json(res, {});
}

// ── 上游转发（带缓存） ───────────────────────────────────────
function cachePathFor(keyStr) {
  return path.join(READ_CACHE, crypto.createHash("sha1").update(keyStr).digest("hex"));
}

function isHashedStaticAsset(req, url) {
  if (req.method !== "GET" || req.headers.range || url.search) return false;
  const prefix = url.hostname === "assets-proxy.anthropic.com" ? "/claude-ai/v2/assets/"
    : /^(?:www\.)?claude\.(?:ai|com)$/.test(url.hostname) ? "/assets/" : null;
  return prefix !== null && url.pathname.startsWith(prefix) &&
    /\/[^/]+-[A-Za-z0-9_-]{8,}\.(?:m?js|css|wasm|woff2?|ttf|otf|png|jpe?g|webp|gif|svg|ico|json)$/.test(url.pathname);
}

function withoutHopByHop(headers) {
  const result = { ...headers };
  const connectionHeaders = String(result.connection || "").split(",").map((name) => name.trim().toLowerCase());
  for (const name of ["connection", "transfer-encoding", "keep-alive", "proxy-authenticate", "proxy-authorization", "te", "trailer", "upgrade", ...connectionHeaders]) {
    delete result[name];
  }
  return result;
}

function bufferedResponseHeaders(headers, length) {
  const result = withoutHopByHop(headers);
  // Buffer 未解压，保留 content-encoding 并以实际传输字节数更新长度。
  result["content-length"] = length;
  return result;
}

/** 原样转发的响应头：上游给了长度就沿用（下载器靠它显示进度），分块传输由 Node 重新分块。 */
function streamedResponseHeaders(headers) {
  const result = withoutHopByHop(headers);
  if (headers["transfer-encoding"]) delete result["content-length"];
  return result;
}

function serveCachedStaticAsset(req, res, url) {
  if (MODE === "passthrough" || !isHashedStaticAsset(req, url)) return false;
  const cacheKey = `${url.host}${url.pathname}${url.search}`;
  const cp = cachePathFor(cacheKey);
  try {
    const meta = JSON.parse(fs.readFileSync(`${cp}.json`, "utf8"));
    if (meta.status !== 200 || meta.url !== cacheKey ||
        typeof meta.headers?.["content-type"] !== "string" ||
        /\b(?:private|no-store)\b/i.test(String(meta.headers["cache-control"] || ""))) return false;
    let body = fs.readFileSync(cp);
    // 录制模板（5.x）与 6.x 客户端混用时，新建项目弹窗的提交守卫依赖本地永远不齐的异步查询
    // （账号 provider / environments），表现为按钮置灰或点击无反应。这里在返回这些弹窗
    // chunk 时放宽提交条件；只影响本地模式下的这两个模块。
    if (/\/c4a0274e5-[^/]+\.js$/.test(url.pathname) || /\/cf0b6cdd1-[^/]+\.js$/.test(url.pathname)) {
      let bytes = body;
      const encoding = String(meta.headers?.["content-encoding"] || "").toLowerCase();
      try {
        if (encoding.includes("gzip")) bytes = zlib.gunzipSync(body);
        else if (encoding.includes("br")) bytes = zlib.brotliDecompressSync(body);
        else if (encoding.includes("deflate")) bytes = zlib.inflateSync(body);
      } catch {}
      const source = bytes.toString("utf8");
      let patched = source;
      if (patched.includes("isAccountLoading:")) {
        // 只改父组件向下传的 prop（形如 `isSubmitting:H,isAccountLoading:Lt,dialogLook:q}`），
        // 不动解构赋值里的 `isAccountLoading:o}`，否则模块本身会语法错误。
        patched = patched.replace(
          /isSubmitting:([A-Za-z0-9_$]+),isAccountLoading:[A-Za-z0-9_$]+,dialogLook:([A-Za-z0-9_$]+)(?!\}=)/g,
          "isSubmitting:$1,isAccountLoading:!1,dialogLook:$2",
        );
      }
      // 6.x 的创建项目弹窗：提交按钮 disabled 由一个组合条件 `ap=!fd||En||ai` 决定，
      // 本地模式下前置数据永远不齐，先强制可提交以验证创建链路。
      patched = patched.replace("ap=!fd||En||ai", "ap=!1");
      // 旧版(模板 build)的提交守卫：onClick:Xd 里 `if(!Jd)` 才动作，Jd=!fd||Al||_n||En。
      // fd 依赖的 environments/account 查询在本地模式永远不齐 → Jd 恒 true → 点了没反应。
      // 强制 Jd=false 让 requestSubmit()/Yd() 走通。
      patched = patched.replace("Jd=!fd||Al||_n||En", "Jd=!1");
      // gd(真正提交)的 guard 里有 !rl（environments 查询 loading），本地永远 true，同样放宽。
      patched = patched.replace("cs||!rl||", "cs||");
      if (patched !== source) {
        body = Buffer.from(patched);
        const headers = {
          "content-type": "text/javascript; charset=utf-8",
          "content-length": body.length,
          "cache-control": "no-store",
          // 跨域 ESM import（claude.ai 页面 → assets-proxy 模块）必须带 CORS 头，
          // 否则 Chromium 报 "Failed to fetch dynamically imported module"（Qr 重试 4 次后放弃）。
          "access-control-allow-origin": "*",
        };
        res.writeHead(200, headers);
        res.end(body);
        return true;
      }
    }
    const headers = bufferedResponseHeaders(meta.headers, body.length);
    delete headers["set-cookie"];
    res.writeHead(200, headers);
    res.end(body);
    return true;
  } catch {
    return false;
  }
}

function readBody(req, cb) {
  const chunks = [];
  req.on("data", (c) => chunks.push(c));
  req.on("end", () => cb(Buffer.concat(chunks)));
  req.on("error", () => cb(Buffer.alloc(0)));
}

// Chat 的 completion 请求体可能被客户端按 gzip/br/deflate 压缩；直接 JSON.parse 会得到 {}。
function decodeJsonBody(req, raw) {
  const encoding = String(req.headers["content-encoding"] || "").toLowerCase().trim();
  let bytes = raw;
  try {
    if (encoding === "gzip" || encoding === "x-gzip") bytes = zlib.gunzipSync(raw);
    else if (encoding === "br") bytes = zlib.brotliDecompressSync(raw);
    else if (encoding === "deflate") bytes = zlib.inflateSync(raw);
  } catch {
    bytes = raw;
  }
  try {
    return JSON.parse(bytes.toString("utf8") || "{}");
  } catch {
    return {};
  }
}

// 文档导航判定：GET + 无扩展名 + 显式要 HTML。/api|/v1|/edge-api 等接口路径在此前分支已返回。
function isDocNav(req, url) {
  return req.method === "GET" && !path.extname(url.pathname) &&
    String(req.headers.accept || "").includes("text/html");
}

// 缓存里的真 SPA 外壳：>=4KB 的 200 HTML；登出落地页/重定向桩体（143B 等）一律不算。
function readDocShell(host) {
  for (const key of [`${host}/epitaxy`, `${host}/login`, `${host}/new`, `${host}/`]) {
    const cp = cachePathFor(key);
    try {
      if (!fs.existsSync(cp) || !fs.existsSync(`${cp}.json`)) continue;
      const meta = JSON.parse(fs.readFileSync(`${cp}.json`, "utf8"));
      const body = fs.readFileSync(cp);
      if (meta.status === 200 && body.length >= 4096) return body;
    } catch { /* ignore corrupt entries */ }
  }
  return null;
}

// 文档导航的规范外壳兜底：优先回放缓存真壳；缺失时从上游抓一次 /epitaxy 写穿。
// 绝不回放登出落地页桩体——那会让 SPA 永远卡在骨架屏。
function serveDocShell(req, res, url) {
  const host = url.host || "claude.ai";
  const shell = readDocShell(host);
  if (shell) {
    const body = Buffer.from(addExtensions(shell), "utf8");
    res.writeHead(200, {
      "content-type": "text/html; charset=utf-8",
      "content-length": body.length,
      "cache-control": "no-store",
    });
    return res.end(body);
  }
  const base = UPSTREAM_MAP[host] || `https://${host}`;
  const target = new URL("/epitaxy", base);
  // 带上 Claude Desktop 自己的浏览器 UA：只写「Claude」会被 Cloudflare 当成机器人 403。
  const userAgent = String(req.headers["user-agent"] || "") || "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Claude Chrome Safari/537.36";
  const up = upstreamRequest(
    target,
    {
      hostname: target.hostname,
      port: target.port || 443,
      path: "/epitaxy",
      method: "GET",
      headers: { accept: "text/html", host, "user-agent": userAgent },
      timeout: 15000,
    },
    (r) => {
      const chunks = [];
      r.on("data", (c) => chunks.push(c));
      r.on("end", () => {
        const body = Buffer.concat(chunks);
        if (r.statusCode === 200 && body.length >= 4096) {
          const cp = cachePathFor(`${host}/epitaxy`);
          fs.mkdirSync(path.dirname(cp), { recursive: true });
          fs.writeFileSync(cp, body);
          fs.writeFileSync(
            `${cp}.json`,
            JSON.stringify({ status: 200, headers: { "content-type": "text/html" }, url: `${host}/epitaxy` }),
          );
        }
        const page = r.statusCode === 200 && !r.headers["content-encoding"] ? addExtensions(body) : body;
        const html = Buffer.isBuffer(page) ? page : Buffer.from(String(page), "utf8");
        res.writeHead(r.statusCode || 502, {
          "content-type": "text/html; charset=utf-8",
          "content-length": html.length,
        });
        res.end(html);
      });
    },
  );
  up.on("timeout", () => up.destroy(new Error("timeout")));
  up.on("error", () => {
    res.writeHead(502);
    res.end("upstream shell unavailable\n");
  });
  up.end();
}

function forwardGateway(req, res, requestPath, raw) {
  let body = raw;
  const requested = new URL(requestPath, "http://localhost");
  if (req.method === "POST" && requested.pathname === "/v1/messages") {
    try { body = gatewayBody(runtime, raw); }
    catch { return json(res, { error: "Invalid model request" }, 400); }
  }
  const target = gatewayTarget(runtime, requestPath);
  const headers = {
    ...req.headers, host: target.host, "content-length": body.length,
    "x-api-key": runtime.key, authorization: `Bearer ${runtime.key}`,
  };
  for (const key of ["proxy-connection", "accept-encoding", "connection", "cookie", "transfer-encoding"]) delete headers[key];
  const up = gatewayRequest(target, {
    hostname: target.hostname, port: target.port || (target.protocol === "https:" ? 443 : 80),
    path: target.pathname + target.search, method: req.method, headers, timeout: 300000,
  }, (response) => {
    res.writeHead(response.statusCode, response.headers);
    response.pipe(res);
  });
  up.on("timeout", () => up.destroy(new Error("gateway timeout")));
  up.on("error", () => {
    if (res.headersSent) return res.destroy();
    json(res, { type: "error", error: { type: "api_error", message: "Local gateway unavailable" } }, 502);
  });
  req.once("aborted", () => up.destroy());
  up.end(body);
}

// 测试/运维可把某主机的上游重定向到本地 fixture；默认保留原始主机走 https。
const UPSTREAM_MAP = (() => {
  try { return JSON.parse(process.env.CLAUDE_LOCAL_UPSTREAM_MAP || "{}"); } catch { return {}; }
})();

// 抓 claude.ai 网页（首次写穿缓存的外壳、静态资源）可选经出站代理：受限地区直连会被 302 到
// app-unavailable-in-region。代理地址由后端检测系统代理后传入（只支持 http:// 的 CONNECT 代理）。
// 本机地址一律直连。
const UPSTREAM_PROXY = (() => {
  try {
    const proxy = new URL(process.env.CLAUDE_LOCAL_UPSTREAM_PROXY || "");
    return proxy.protocol === "http:" && proxy.hostname ? proxy : null;
  } catch {
    return null;
  }
})();

function isLoopbackHost(hostname) {
  return ["localhost", "127.0.0.1", "::1", "[::1]"].includes(String(hostname).toLowerCase());
}

function upstreamProxyAuth() {
  return UPSTREAM_PROXY?.username
    ? { "proxy-authorization": `Basic ${Buffer.from(`${decodeURIComponent(UPSTREAM_PROXY.username)}:${decodeURIComponent(UPSTREAM_PROXY.password)}`).toString("base64")}` }
    : {};
}

// 发往上游网页的请求共用连接池：首次启动（或线上页面换版本后）要补拉上千个前端资源，
// 逐个新建连接会在代理软件 / 防火墙里刷出上千条 node 连接。每个主机最多并发这么多条，
// 用完的连接留着复用，空闲一段时间后关掉。
const UPSTREAM_MAX_SOCKETS_PER_HOST = 16;
const UPSTREAM_IDLE_SOCKET_MS = 30_000;
const UPSTREAM_POOL = { keepAlive: true, maxSockets: UPSTREAM_MAX_SOCKETS_PER_HOST, timeout: UPSTREAM_IDLE_SOCKET_MS };

/** 隧道还没打通时先替它收着 TLS 握手数据；打通后接上，两边原样转发。 */
class PendingTunnel extends Duplex {
  constructor() {
    super();
    this.socket = null;
    this.queued = [];
    this.finalCallback = null;
  }
  attach(socket) {
    if (this.destroyed) return socket.destroy();
    this.socket = socket;
    socket.on("data", (chunk) => {
      if (!this.push(chunk)) socket.pause();
    });
    socket.once("end", () => this.push(null));
    socket.once("error", (error) => this.destroy(error));
    socket.once("close", () => this.destroy());
    for (const [chunk, encoding, callback] of this.queued) socket.write(chunk, encoding, callback);
    this.queued = [];
    if (this.finalCallback) {
      socket.end();
      this.finalCallback();
    }
  }
  _read() {
    this.socket?.resume();
  }
  _write(chunk, encoding, callback) {
    if (this.socket) this.socket.write(chunk, encoding, callback);
    else this.queued.push([chunk, encoding, callback]);
  }
  _final(callback) {
    if (this.socket) {
      this.socket.end();
      callback();
    } else {
      this.finalCallback = callback;
    }
  }
  _destroy(error, callback) {
    this.socket?.destroy();
    callback(error);
  }
}

/**
 * 经出站代理的连接池：新连接先 CONNECT 打通隧道，再在隧道上做 TLS；建好的连接照常复用。
 * createConnection 必须同步交出 socket，连接池才会立刻把它计入 maxSockets
 * （回调式异步交出时，隧道打通前的并发请求每个都会再开一条）。
 */
class UpstreamTunnelAgent extends https.Agent {
  createConnection(options) {
    const host = options.hostname || options.host;
    const authority = `${host}:${Number(options.port || 443)}`;
    const tunnel = new PendingTunnel();
    const connect = http.request({
      host: UPSTREAM_PROXY.hostname,
      port: Number(UPSTREAM_PROXY.port || 80),
      method: "CONNECT",
      path: authority,
      headers: { host: authority, ...upstreamProxyAuth() },
      agent: false,
      timeout: 20000,
    });
    connect.once("connect", (response, socket, head) => {
      if (response.statusCode !== 200) {
        socket.destroy();
        return tunnel.destroy(new Error(`upstream proxy CONNECT ${response.statusCode}`));
      }
      if (head?.length) socket.unshift(head);
      tunnel.attach(socket);
    });
    connect.once("timeout", () => connect.destroy(new Error("upstream proxy timeout")));
    connect.once("error", (error) => tunnel.destroy(error));
    // 请求方先放弃（TLS 连接被销毁）时，没打通的 CONNECT 一并取消。
    tunnel.once("close", () => connect.destroy());
    connect.end();
    return tls.connect({ socket: tunnel, servername: options.servername || host });
  }
}

const directAgent = new https.Agent(UPSTREAM_POOL);
const tunnelAgent = UPSTREAM_PROXY ? new UpstreamTunnelAgent(UPSTREAM_POOL) : null;

/** 发往上游网页的请求：https 走连接池，配置了出站代理时经代理隧道（本机地址一律直连）。 */
function upstreamRequest(target, options, callback) {
  if (target.protocol !== "https:") return http.request(options, callback);
  const viaProxy = tunnelAgent && !isLoopbackHost(target.hostname);
  return https.request({ ...options, agent: viaProxy ? tunnelAgent : directAgent }, callback);
}

// 模型请求经出站代理时用自己的隧道连接池，不设并发上限：并行的子任务会同时开很多条流，
// 和网页资源共用每个主机 16 条的池子会排队。
const gatewayTunnelAgent = UPSTREAM_PROXY ? new UpstreamTunnelAgent({ keepAlive: true }) : null;

/**
 * 发往模型网关（用户配置的上游）的请求。配置了出站代理、上游又在公网上时经代理走：
 * 只开系统代理（没开 TUN）时直连会被上游按地区拒绝。其余情况和以前一样直连。
 */
function gatewayRequest(target, options, callback) {
  if (!UPSTREAM_PROXY || isLocalNetworkHost(target.hostname)) {
    return (target.protocol === "https:" ? https : http).request(options, callback);
  }
  if (target.protocol === "https:") return https.request({ ...options, agent: gatewayTunnelAgent }, callback);
  // 明文 http 的上游：按转发代理的写法，请求行里给完整地址。
  return http.request({
    ...options,
    host: UPSTREAM_PROXY.hostname,
    hostname: UPSTREAM_PROXY.hostname,
    port: Number(UPSTREAM_PROXY.port || 80),
    path: target.href,
    headers: { host: target.host, ...options.headers, ...upstreamProxyAuth() },
  }, callback);
}

function upstreamFailureHeaders(req) {
  const result = {
    "content-type": "text/plain; charset=utf-8",
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
    "vary": "Origin",
  };
  const origin = req.headers.origin;
  if (DESKTOP_WEB_ORIGINS.has(origin)) {
    result["access-control-allow-origin"] = origin;
    result["access-control-allow-credentials"] = "true";
  }
  return result;
}

/** 能原样改写的页面：200、HTML、未压缩。 */
function isHtmlResponse(status, headers) {
  return status === 200 && /^text\/html\b/i.test(String(headers?.["content-type"] || "")) &&
    !headers["content-encoding"];
}

function proxyUpstream(req, res, url) {
  const cacheKey = `${url.host}${url.pathname}${url.search}`;
  const cp = cachePathFor(cacheKey);
  const metaPath = `${cp}.json`;
  const staticAsset = isHashedStaticAsset(req, url);
  const document = /^(?:www\.)?claude\.(?:ai|com)$/.test(url.hostname) && isDocNav(req, url);
  const canCache = MODE !== "passthrough" && (staticAsset || document);

  // 保留原始主机（downloads.claude.ai 等），不再统一改写到 claude.ai。
  const base = UPSTREAM_MAP[url.host] || `https://${url.host || "claude.ai"}`;
  const target = new URL(url.pathname + url.search, base);
  const headers = { ...req.headers, host: url.host || target.host };
  delete headers["proxy-connection"];
  delete headers["accept-encoding"];
  // 逐跳头只管 Claude 与本代理之间那一段；转给上游会让它每回一个请求就关连接，连接池复用不了。
  delete headers.connection;
  delete headers["keep-alive"];

  const upstreamReq = upstreamRequest(
    target,
    {
      hostname: target.hostname,
      port: target.port || 443,
      path: target.pathname + target.search,
      method: req.method,
      headers,
      timeout: 20000,
    },
    (up) => {
      if (!canCache) {
        // 边收边转：Claude Code 安装包（上百 MB）、Cowork 虚拟机镜像（GB 级）以前要整个读进内存才开始回，
        // 下载器在这段时间收不到一个字节，空闲超时（IDLE_TIMEOUT）就放弃了。
        res.writeHead(up.statusCode, streamedResponseHeaders(up.headers));
        up.pipe(res);
        res.on("close", () => { if (!up.complete) upstreamReq.destroy(); });
        up.on("close", () => { if (!up.complete) res.destroy(); });
        return;
      }
      // 要缓存的只有带哈希的静态资源和页面，都不大：收齐再回，和之后从缓存回放的字节、长度一致。
      const chunks = [];
      up.on("data", (c) => chunks.push(c));
      up.on("end", () => {
        const body = Buffer.concat(chunks);
        const ok = up.statusCode >= 200 && up.statusCode < 400;
        // 文档路由不缓存桩体/落地页 HTML（登出页会让 SPA 卡骨架屏）
        const docStub = isDocNav(req, url) && body.length < 4096;
        if (ok && !docStub && (!staticAsset || (
          up.statusCode === 200 && !up.headers["set-cookie"] &&
          !/\b(?:private|no-store)\b/i.test(String(up.headers["cache-control"] || ""))
        ))) {
          fs.mkdirSync(path.dirname(cp), { recursive: true });
          fs.writeFileSync(cp, body);
          fs.writeFileSync(
            metaPath,
            JSON.stringify({ status: up.statusCode, headers: bufferedResponseHeaders(up.headers, body.length), url: cacheKey }),
          );
        }
        // 缓存里存原文，注入只改这次返回的页面。
        const page = document && isHtmlResponse(up.statusCode, up.headers) ? addExtensions(body) : body;
        res.writeHead(up.statusCode, bufferedResponseHeaders(up.headers, page.length));
        res.end(page);
      });
    },
  );
  upstreamReq.on("timeout", () => upstreamReq.destroy(new Error("upstream timeout")));
  upstreamReq.on("error", (err) => {
    if (res.headersSent) {
      // 已经开始转发了，没法再换成兜底响应；断开让客户端知道没收全。
      log(`UPSTREAM FAIL ${url.pathname} (mid-stream): ${err.message}`);
      return res.destroy();
    }
    if (serveCachedStaticAsset(req, res, url)) return;
    // 动态接口不能回放其它会话的缓存；文档仍沿用本地外壳兜底。
    if (canCache && document && fs.existsSync(cp) && fs.existsSync(metaPath)) {
      const meta = JSON.parse(fs.readFileSync(metaPath, "utf8"));
      const body = fs.readFileSync(cp);
      const docStub = isDocNav(req, url) && (meta.status !== 200 || body.length < 4096);
      if (docStub) {
        // 桩体不落回客户端；真外壳兜底已在上层分支兜底
        res.writeHead(502, upstreamFailureHeaders(req));
        res.end("upstream unavailable (doc stub suppressed)\n");
        return;
      }
      const page = isHtmlResponse(meta.status, meta.headers) ? addExtensions(body) : body;
      res.writeHead(meta.status || 200, bufferedResponseHeaders(meta.headers, page.length));
      res.end(page);
      log(`CACHE HIT ${url.pathname}`);
      return;
    }
    log(`UPSTREAM FAIL ${url.pathname}: ${err.message}`);
    res.writeHead(502, upstreamFailureHeaders(req));
    res.end(`upstream unavailable: ${err.message}\n`);
  });
  // 超时 destroy 会让底层 TLSSocket 在请求结束后再 emit 一次 error：
  // 没有 socket 级监听时 Node 会把它当未处理错误，整个 proxy 直接退出。
  upstreamReq.on("socket", (socket) => socket.on("error", () => {}));
  req.pipe(upstreamReq);
}

const EMPTY_PLUGIN_DIRECTORY = { data: [], next_page: null, facets: {}, omitted: [] };

// api.anthropic.com 的插件目录是公开接口（不用登录），插件页从 claude.ai 跨域读它：转给真接口。
// 连不上或被拒时回空目录。响应必须带 CORS 头：缺了页面读不到，整页报「无法加载插件」（#25）。
function publicPluginDirectory(req, res, url) {
  const cors = { "access-control-allow-origin": "*" };
  const empty = () => json(res, EMPTY_PLUGIN_DIRECTORY, 200, cors);
  const target = new URL(url.pathname + url.search, UPSTREAM_MAP[url.host] || `https://${url.host}`);
  const upstreamReq = upstreamRequest(
    target,
    {
      hostname: target.hostname,
      port: target.port || 443,
      path: target.pathname + target.search,
      headers: { host: url.host, accept: "application/json" },
      timeout: 20000,
    },
    (up) => {
      if (up.statusCode !== 200) {
        up.resume();
        return empty();
      }
      res.writeHead(200, { ...streamedResponseHeaders(up.headers), ...cors });
      up.pipe(res);
      res.on("close", () => { if (!up.complete) upstreamReq.destroy(); });
      up.on("close", () => { if (!up.complete) res.destroy(); });
    },
  );
  upstreamReq.on("timeout", () => upstreamReq.destroy(new Error("upstream timeout")));
  upstreamReq.on("error", () => (res.headersSent ? res.destroy() : empty()));
  upstreamReq.end();
}

/**
 * 向一个上游地址发请求，读完整个响应体（超过 `limit` 字节放弃）。
 * `until(正文)`：返回真时不等对方结束连接就交回，SSE 形式的回复用。
 */
function upstreamCall(address, { method = "GET", headers = {}, body, limit = 8 * 1024 * 1024, timeout = 30000, until } = {}) {
  return new Promise((resolve, reject) => {
    const url = new URL(address);
    const target = new URL(url.pathname + url.search, UPSTREAM_MAP[url.host] || url.origin);
    const payload = body === undefined ? undefined : Buffer.from(body);
    const request = upstreamRequest(
      target,
      {
        hostname: target.hostname,
        port: target.port || 443,
        path: target.pathname + target.search,
        method,
        headers: {
          accept: "*/*", "user-agent": "claude-local", ...headers, host: url.host,
          ...(payload ? { "content-length": payload.length } : {}),
        },
        timeout,
      },
      (response) => {
        const chunks = [];
        let size = 0;
        const done = () => resolve({ status: response.statusCode, headers: response.headers, body: Buffer.concat(chunks) });
        response.on("data", (chunk) => {
          size += chunk.length;
          if (size > limit) return request.destroy(new Error("upstream response too large"));
          chunks.push(chunk);
          if (until?.(Buffer.concat(chunks).toString("utf8"))) {
            done();
            request.destroy();
          }
        });
        response.on("end", done);
        response.on("error", reject);
      },
    );
    request.on("timeout", () => request.destroy(new Error("upstream timeout")));
    request.on("error", reject);
    request.end(payload);
  });
}

const fetchUpstream = (address, limit) => upstreamCall(address, { limit });

const PLUGIN_DIRECTORY_URL = "https://api.anthropic.com/api/directory/plugins";
const PLUGIN_LOOKUP_TTL_MS = 10 * 60_000;
// 桌面端自己的上限是解压后 200 MB。
const MAX_PLUGIN_ZIP_BYTES = 256 * 1024 * 1024;
const pluginLookups = new Map();

/** 到公开目录查一个插件：能装的返回目录记录，查不到或装不了（没有源码仓库）返回 null。目录连不上时抛错。 */
async function directoryPlugin(key, address) {
  const cached = pluginLookups.get(key);
  if (cached && Date.now() - cached.at < PLUGIN_LOOKUP_TTL_MS) return cached.entry;
  const { status, body } = await fetchUpstream(address, 4 * 1024 * 1024);
  if (status !== 200 && status !== 404) throw new Error(`plugin directory answered ${status}`);
  let entry = null;
  if (status === 200) {
    const parsed = JSON.parse(body.toString("utf8"));
    const row = Array.isArray(parsed?.data) ? parsed.data[0] : parsed;
    if (installablePlugin(row)) entry = row;
  }
  if (pluginLookups.size >= 500) pluginLookups.clear();
  pluginLookups.set(key, { at: Date.now(), entry });
  return entry;
}

// id 和名字都要拼进目录的地址和过滤表达式，格式不对的直接当查不到。
function directoryPluginById(id) {
  if (!/^plugin_\w{1,64}$/.test(id)) return null;
  return directoryPlugin(`id:${id}`, `${PLUGIN_DIRECTORY_URL}/${id}`);
}

function directoryPluginByName(name) {
  if (!/^[\w.-]{1,128}$/.test(name)) return null;
  const filter = `manifest_name == '${name}' && source.marketplace_slug == '${DIRECTORY_MARKETPLACE.name}'`;
  return directoryPlugin(`name:${name}`, `${PLUGIN_DIRECTORY_URL}?limit=1&filter=${encodeURIComponent(filter)}`);
}

const connectorService = createConnectorService({
  connectors: CONNECTORS,
  send: upstreamCall,
  changed: () => stateStore.flush(),
  redirectUri: () => `http://127.0.0.1:${listeningPort}${CONNECTOR_SIGN_IN_PATH}`,
});

/**
 * 账号侧的连接器接口（见 connectors.mjs）：添加 / 列出 / 移除、连接和登录、状态事件流、会话里的工具调用。
 * 处理了返回 true。
 */
function connectorApi(req, res, url, p) {
  const method = req.method;
  const fail = (error) => {
    if (res.headersSent) return res.destroy();
    const known = error instanceof ConnectorError;
    json(res, {
      type: "error",
      error: {
        type: known ? "invalid_request_error" : "api_error",
        message: known ? error.message : "Connector request failed",
        details: { error_code: known ? error.code : "mcp_request_failed" },
      },
    }, known ? error.status : 502);
  };
  const answer = (work) => {
    Promise.resolve().then(work).then((value) => { if (value !== undefined) json(res, value); }).catch(fail);
    return true;
  };
  const withBody = (work) => {
    readBody(req, (raw) => answer(() => work(decodeJsonBody(req, raw))));
    return true;
  };

  // 页面拿登录结果（不带组织）。
  if (method === "GET" && p === "/api/mcp/auth_callback") {
    return answer(() => connectorService.claim(url.searchParams.get("state") ?? "", url.searchParams.get("ticket") ?? ""));
  }
  const route = /^\/api\/organizations\/[^/]+\/mcp\/(.+)$/.exec(p)?.[1];
  if (!route) return false;

  if (method === "GET" && route === "v2/bootstrap") {
    res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-store" });
    const write = (event, data) => { if (!res.writableEnded) res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`); };
    connectorService.stream(write).catch(() => {}).finally(() => res.end());
    return true;
  }
  if (method === "GET" && route === "remote_servers_with_connection") {
    return answer(() => connectorService.list().map((connector) => ({
      ...connectorRecord(connector),
      connection_state: connector.disconnected ? "user_disconnected" : connectorService.connected(connector) ? "connected" : null,
      connection_auth_type: null,
    })));
  }
  if (route === "remote_servers") {
    if (method === "GET") return answer(() => connectorService.list().map(connectorRecord));
    if (method === "POST") {
      return withBody((body) => {
        const { connector, existing } = connectorService.create({
          name: body.name, url: body.url, directoryUuid: body.mcp_directory_server_uuid ?? body.install?.mcp_directory_server_uuid,
        });
        return { ...connectorRecord(connector), ...(existing ? { existing: true } : {}) };
      });
    }
    return false;
  }
  if (method === "POST" && route === "desktop_finish/wait_ended") return answer(() => ({}));
  // 连接表单（要用户填地址或密钥的连接器）没有数据来源；404 时页面直接走普通的添加。
  if (method === "GET" && /^directory_servers\/[^/]+\/install_form$/.test(route)) {
    return answer(() => { throw new ConnectorError("not_found", "No install form", 404); });
  }

  const target = /^(remote_servers|logout|start-auth|servers)\/([0-9a-f-]{36})(?:\/(.+))?$/.exec(route);
  if (!target) return false;
  const [, kind, uuid, rest] = target;
  const connector = connectorService.get(uuid);
  if (!connector) {
    return answer(() => { throw new ConnectorError("mcp_connector_removed", "This connector was removed.", 404); });
  }

  if (kind === "remote_servers" && rest === undefined) {
    if (method === "GET") return answer(() => connectorRecord(connector));
    if (method === "PUT") {
      return withBody((body) => {
        connectorService.rename(connector, body.name);
        return connectorRecord(connector);
      });
    }
    if (method === "DELETE") {
      return answer(() => {
        connectorService.remove(uuid);
        return {};
      });
    }
    return false;
  }
  if (kind === "remote_servers" && method === "POST" && rest === "clear_cache") {
    return answer(() => {
      connectorService.refreshStatus(connector);
      return {};
    });
  }
  // 逐个工具的权限设置：本地不做，空对象在页面里是「没有清单」。
  if (kind === "remote_servers" && method === "GET" && rest === "tools") return answer(() => ({}));
  if (kind === "logout" && method === "POST" && rest === undefined) {
    return answer(() => {
      connectorService.logout(connector);
      return {};
    });
  }
  if (kind === "start-auth" && method === "GET" && rest === undefined) {
    return answer(() => {
      // 不带 response_format=json 的是整页跳转式登录，目的地在真正的 claude.ai 上，本地接不住。
      if (url.searchParams.get("response_format") !== "json") {
        throw new ConnectorError("mcp_sign_in_unavailable", "This sign-in route is not available locally.");
      }
      return connectorService.startAuth(connector, url.searchParams.get("desktop_finish") ?? "");
    });
  }
  if (kind === "servers" && method === "POST" && rest === "tools/call") {
    return withBody((body) => connectorService.callTool(connector, String(body.tool_name ?? ""), body.arguments));
  }
  if (kind === "servers" && method === "GET" && rest === "resources/list") return answer(() => ({ resources: [] }));
  if (kind === "servers" && method === "POST" && rest === "resources/read") return answer(() => ({ contents: [] }));
  return false;
}

const CONNECTOR_SIGN_IN_PATH = "/mcp-oauth-callback";

/** 浏览器登录完跳回来的本机页面：换好令牌后把人送回 Claude。 */
function connectorSignInCallback(res, url) {
  const page = (status, title, detail, link) => {
    const escape = (text) => String(text).replace(/[&<>"]/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[char]);
    const body = `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">` +
      `<title>${escape(title)}</title>` +
      (link ? `<meta http-equiv="refresh" content="0;url=${escape(link)}">` : "") +
      `<body style="font: 16px system-ui; max-width: 28rem; margin: 20vh auto; padding: 0 1rem; text-align: center">` +
      `<h1 style="font-size: 1.25rem">${escape(title)}</h1><p>${escape(detail)}</p>` +
      (link ? `<p><a href="${escape(link)}">${escape(runtime.localization ? "回到 Claude" : "Back to Claude")}</a></p>` : "");
    res.writeHead(status, {
      "content-type": "text/html; charset=utf-8", "content-length": Buffer.byteLength(body),
      "cache-control": "no-store", "x-content-type-options": "nosniff", "referrer-policy": "no-referrer",
    });
    res.end(body);
  };
  const zh = runtime.localization;
  connectorService.finishAuth({
    state: url.searchParams.get("state") ?? "", code: url.searchParams.get("code"), error: url.searchParams.get("error"),
  }).then((result) => {
    if (!result) {
      return page(400, zh ? "登录已失效" : "Sign-in expired", zh ? "请回到 Claude，重新点一次「连接」。" : "Go back to Claude and choose Connect again.");
    }
    if (result.success) {
      return page(200, zh ? `已登录 ${result.name}` : `Signed in to ${result.name}`, zh ? "正在回到 Claude…" : "Returning to Claude…", result.link);
    }
    page(200, zh ? `没能登录 ${result.name}` : `Could not sign in to ${result.name}`, zh ? "正在回到 Claude…" : "Returning to Claude…", result.link);
  }).catch(() => page(502, zh ? "登录出错" : "Sign-in failed", zh ? "请回到 Claude 再试一次。" : "Go back to Claude and try again."));
}

/**
 * 账号侧的插件接口（详情、已装列表、启用状态、安装包）。处理了返回 true。
 *
 * 安装的过程：网页 PUT `plugins/<id>/enabled`，然后让桌面端同步；桌面端读「已启用的插件」列表，
 * 对本地没有的逐个 GET `plugins/<id>/download` 取 zip 解压，之后的 Cowork / Code 会话里就有这个插件。
 * 卸载是 PUT enabled=false，桌面端删掉本地那份。
 */
function pluginApi(req, res, url, p) {
  const route = /^\/api\/organizations\/[^/]+\/(.+)$/.exec(p)?.[1];
  if (!route) return false;
  const method = req.method;
  const notFound = () => json(res, { error: { details: { error_code: "plugin_not_found" } } }, 404);
  const answer = (work) => {
    work().catch(() => {
      if (res.headersSent) return res.destroy();
      json(res, { type: "error", error: { type: "api_error", message: "Plugin directory unavailable" } }, 502);
    });
    return true;
  };
  const installed = () => [...INSTALLED_PLUGINS.values()];

  if (method === "GET" && route === "marketplaces/list-default-marketplaces") {
    json(res, { marketplaces: [DIRECTORY_MARKETPLACE] });
    return true;
  }
  // 市场自己的插件清单：浏览用的是公开目录，这里不重复列。
  if (method === "GET" && /^marketplaces\/[^/]+\/plugins\/(?:account-)?list-plugins$/.test(route)) {
    json(res, { plugins: [], has_more: false });
    return true;
  }
  if (method === "GET" && route === "plugins/list-plugins") {
    // 桌面端分三种查：组织强制安装的、账号启用的（enabled_only）、可浏览的。只有第二种有内容。
    const enabledOnly = url.searchParams.get("enabled_only") === "true";
    json(res, { plugins: enabledOnly ? installed().map((entry) => pluginRecord(entry, true)) : [], has_more: false });
    return true;
  }
  // 「您的插件」：只接按种类查插件的那种读法，其余（skill、分组）留给通用的空列表。
  if (method === "GET" && route === "library/mine" && url.searchParams.get("kind") === "plugin" &&
      !url.searchParams.has("group_by_kind")) {
    json(res, { items: installed().map(libraryItem), next_cursor: null });
    return true;
  }
  // 组织目录：合并式插件页的「您的插件」、搜索、连接器详情页（按 id 查）都读它。
  if (method === "GET" && route === "directory/plugins") {
    const filter = url.searchParams.get("filter") ?? "";
    const wanted = (url.searchParams.get("q") ?? "").trim().toLowerCase();
    // 「您的插件」：状态为已启用 / 已停用的记录，搜索时再按名字筛。
    if (/^\(?installation\.state in \[/.test(filter)) {
      const matches = (entry) => !wanted ||
        [entry.name, entry.slug, entry.summary, entry.publisher?.name].some((text) => String(text ?? "").toLowerCase().includes(wanted));
      json(res, { ...EMPTY_PLUGIN_DIRECTORY, data: installed().filter(matches).map(installedDirectoryRecord) });
      return true;
    }
    // 其余的查询里只接搜索和按 id 查，原样问公开目录；别的（首页各栏）页面自己会读公开目录，这里留空。
    if (!wanted && !/^id in \[/.test(filter)) return false;
    return answer(async () => {
      // 公开目录不认登录后才有的 include（installation.*），带着会被 400 拒绝。
      const query = new URLSearchParams(url.searchParams);
      const include = (query.get("include") ?? "").split(",").filter((part) => part && !part.startsWith("installation"));
      if (include.length) query.set("include", include.join(","));
      else query.delete("include");
      const { status, body } = await fetchUpstream(`${PLUGIN_DIRECTORY_URL}?${query}`, 4 * 1024 * 1024);
      const page = status === 200 ? JSON.parse(body.toString("utf8")) : EMPTY_PLUGIN_DIRECTORY;
      // 公开目录里每条都是「未登录」：已装的换成已启用（查询要求没装的时去掉），其余换成未安装。
      const rows = (Array.isArray(page.data) ? page.data : [])
        .filter((row) => !(filter.startsWith("!(installation.state in [") && INSTALLED_PLUGINS.has(row?.id)));
      json(res, {
        ...page,
        data: rows.map((row) => (INSTALLED_PLUGINS.has(row?.id) ? installedDirectoryRecord(row) : {
          ...row,
          installation: { state: "not_installed", actions: { install: true }, admin_policy: { type: "set", install_mode: "optional" } },
        })),
      });
    });
  }
  if (method === "GET" && route === "plugins/enabled-state") {
    json(res, {
      preferences: installed().map((entry) => ({
        plugin_name: entry.manifest_name,
        marketplace_id: DIRECTORY_MARKETPLACE.id,
        marketplace_name: DIRECTORY_MARKETPLACE.name,
        enabled: true,
      })),
    });
    return true;
  }

  const byName = /^plugins\/by-name\/([^/]+)$/.exec(route);
  if (method === "GET" && byName) {
    return answer(async () => {
      let name = "";
      try { name = decodeURIComponent(byName[1]); } catch {}
      const marketplace = url.searchParams.get("marketplace_name");
      const entry = marketplace && marketplace !== DIRECTORY_MARKETPLACE.name
        ? null
        : installed().find((plugin) => plugin.manifest_name === name) ?? await directoryPluginByName(name);
      if (!entry) return notFound();
      json(res, pluginRecord(entry, INSTALLED_PLUGINS.has(entry.id)));
    });
  }

  const plugin = /^plugins\/([^/]+)(?:\/(scan-status|versions|download|enabled))?$/.exec(route);
  if (!plugin || plugin[1] === "registry") return false;
  const [, id, action] = plugin;

  if (method === "PUT" && action === "enabled") {
    readBody(req, (raw) => answer(async () => {
      const enabled = decodeJsonBody(req, raw).enabled !== false;
      // 启用时重新查一次目录：重装就能拿到新审核的提交。目录连不上时沿用已装的那份。
      const entry = (enabled ? await Promise.resolve(directoryPluginById(id)).catch(() => null) : null)
        ?? INSTALLED_PLUGINS.get(id) ?? await directoryPluginById(id);
      if (!entry) return notFound();
      if (enabled) INSTALLED_PLUGINS.set(id, entry);
      else INSTALLED_PLUGINS.delete(id);
      stateStore.flush();
      json(res, pluginRecord(entry, enabled));
    }));
    return true;
  }
  if (method !== "GET") return false;
  if (action === "versions") {
    // 版本历史没有数据来源；404 在前端表示「不支持」，页面照常显示。
    notFound();
    return true;
  }
  return answer(async () => {
    const entry = INSTALLED_PLUGINS.get(id) ?? await directoryPluginById(id);
    if (!entry) return notFound();
    if (action === "scan-status") return json(res, { content_scan: null });
    if (action !== "download") return json(res, pluginRecord(entry, INSTALLED_PLUGINS.has(id)));
    const { owner, repo, commit, dir } = pluginRepository(entry);
    const source = await fetchUpstream(`https://codeload.github.com/${owner}/${repo}/zip/${commit}`, MAX_PLUGIN_ZIP_BYTES);
    if (source.status !== 200) throw new Error(`plugin source answered ${source.status}`);
    // 桌面端解压时会去掉唯一的最外层目录，整个仓库就是插件时原样给。
    const zip = dir ? zipSubtree(source.body, dir) : source.body;
    res.writeHead(200, { "content-type": "application/zip", "content-length": zip.length, "cache-control": "no-store" });
    res.end(zip);
  });
}

// ── 请求处理 ─────────────────────────────────────────────────
const demoHtml = MODE === "demo" ? fs.readFileSync(path.join(here, "demo", "index.html")) : null;

// ── Artifacts MCP 鉴权闸 ─────────────────────────────────────
// POST /api/artifacts/mcp 能读/写/删整个作品库，必须挡住浏览器里跑的内容：
//  - claudeusercontent.com 内容子域（作品 iframe 的源）一律 404——作品没有合法理由调它；
//  - 带 origin 的请求（浏览器发起）只认主站源 claude.ai/claude.com；
//  - 其余（桌面 CLI 直连、无 origin）放行——MITM 域本身已被代理接管，外层端口另有 Bearer 鉴权。
function serveArtifactsMcp(req, res, url, hostName) {
  if (/(^|\.)claudeusercontent\.com$/i.test(hostName)) {
    return json(res, { error: "not_found" }, 404);
  }
  const origin = typeof req.headers.origin === "string" ? req.headers.origin : "";
  if (origin && !/^https:\/\/(?:www\.)?claude\.(?:ai|com)\/?$/i.test(origin)) {
    return json(res, { error: "origin_not_allowed" }, 403);
  }
  return artifactService.handleMcp(req, res);
}

function handle(req, res, hostHeader) {
  const host = hostHeader || "claude.ai";
  const url = new URL(req.url, `https://${host}`);
  noteClient();
  log(`${req.method} ${url.pathname}`);

  const hostName = url.hostname.toLowerCase();
  const isMainClaudeHost = /^(claude\.ai|www\.claude\.ai|claude\.com|www\.claude\.com)$/.test(hostName);

  // Artifacts：MCP 端点在主站与 api.anthropic.com 上可用（CLI 两侧都会打），经鉴权闸。
  if (req.method === "POST" && url.pathname === "/api/artifacts/mcp") {
    return serveArtifactsMcp(req, res, url, hostName);
  }
  // 作品内容子域：<uuid>.claudeusercontent.com 的 _f/<ver>/* 与 _runtime/*。
  if (/(^|\.)claudeusercontent\.com$/i.test(hostName)) {
    return artifactService.handleFrameHost(req, res, url, hostName);
  }
  // 本地 Artifact 面板的同源接口：只回 JSON 元数据（列表/meta）。raw 预览已挪到
  // 内容子域（handleFrameHost），主站源下不再提供模型生成的 HTML。
  if (isMainClaudeHost && url.pathname.startsWith("/__claude_local/artifacts")) {
    if (artifactService.handleLocalApi(req.method, url, req, res)) return;
    if (/^\/__claude_local\/artifacts\/[^/]+\/raw$/.test(url.pathname)) {
      return json(res, { error: "not_found" }, 404);
    }
  }
  // 查看器外壳：iframe / product=viewer 的 /code/artifact/<uuid>，以及短链 /artifact/<short>。
  if (
    isMainClaudeHost &&
    (req.method === "GET" || req.method === "HEAD") &&
    /^\/(?:code\/(?:artifact|frame)|artifact)\/[0-9A-Za-z_-]{8,36}$/.test(url.pathname) &&
    (url.searchParams.get("product") === "viewer" ||
      req.headers["sec-fetch-dest"] === "iframe" ||
      url.pathname.startsWith("/artifact/"))
  ) {
    return artifactService.serveViewerShell(req, res, url);
  }

  if (MODE === "mock" && req.method === "GET" &&
      (isMainClaudeHost || hostName === "api.anthropic.com") &&
      /^\/api\/(?:organizations\/[^/]+\/)?model_selector\/[^/]+\/?$/.test(url.pathname)) {
    return mockApi(req, res, url);
  }
  if (runtime.managed && isMainClaudeHost && url.pathname.startsWith("/__codex_plus/")) {
    const asset = extensions && ["GET", "HEAD"].includes(req.method) && url.pathname.startsWith(EXTENSION_PREFIX)
      ? extensions.read(url.pathname.slice(EXTENSION_PREFIX.length))
      : null;
    if (asset) {
      res.writeHead(200, {
        "content-type": asset.type,
        "content-length": asset.body.length,
        "cache-control": "no-store",
        "x-content-type-options": "nosniff",
      });
      return res.end(req.method === "HEAD" ? undefined : asset.body);
    }
    if (
      url.pathname !== LOCALIZATION_SHIM_PATH ||
      !localizationShim ||
      !["GET", "HEAD"].includes(req.method)
    ) {
      res.writeHead(404, { "cache-control": "no-store", "x-content-type-options": "nosniff" });
      return res.end();
    }
    const headers = {
      "content-type": "text/javascript; charset=utf-8",
      "content-length": localizationShim.length,
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
    };
    res.writeHead(200, headers);
    return res.end(req.method === "HEAD" ? undefined : localizationShim);
  }

  const cdnI18nPrefix = "/claude-ai/v2/i18n/";
  const localI18nPath = isMainClaudeHost
    ? url.pathname
    : hostName === "assets-proxy.anthropic.com" && url.pathname.startsWith(cdnI18nPrefix)
      ? url.pathname.slice("/claude-ai/v2".length)
      : null;
  if (
    runtime.managed &&
    runtime.localization &&
    localI18nPath?.startsWith("/i18n/") &&
    ["GET", "HEAD"].includes(req.method)
  ) {
    const body = localI18n(localI18nPath);
    const headers = {
      "content-type": "application/json; charset=utf-8",
      "content-length": body.length,
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
    };
    if (hostName === "assets-proxy.anthropic.com") headers["access-control-allow-origin"] = "*";
    res.writeHead(200, headers);
    return res.end(req.method === "HEAD" ? undefined : body);
  }

  const officialResourcePath = (() => {
    // 外壳用本机版本时，它引用的静态资源也从本机资源包出（见 useOfficialShell）。
    if (!["GET", "HEAD"].includes(req.method)) return null;
    if (!useOfficialShell) {
      // 模板模式：主站 UI 资源仍跟模板走，但 artifact 查看器（frame）资产没有模板录制、
      // 外壳 HTML 来自本机 ion-dist（serveViewerShell），chunk 必须同源，否则旧缓存
      // MISS 后转发上游会被 302 到 app-unavailable-in-region。范围不用猜文件名：
      // frame 外壳只引用 /assets/v1/ 下的资源，asar 里有就接管（JS/CSS/字体/图标），
      // 没有则回落模板链。模板 UI chunk 与 asar 重名时以 asar 为准也无碍——模板外壳
      // 引用的是自己录制的文件名（build 不同，不重名）。
      if (!FRAME_ASSETS_AVAILABLE || !isMainClaudeHost) return null;
      if (!/^\/assets\/v1\/[^\s]+\.(?:m?js|css|woff2?|ttf|otf|png|jpe?g|webp|gif|svg|ico|wasm|json)$/.test(url.pathname)) return null;
      return officialAssets.read(url.pathname) ? url.pathname : null;
    }
    const mapI18nPath = (pathname) => {
      const match = pathname.match(/^\/i18n\/(?:(s|dynamic)\/)?([a-zA-Z-]+)\.json$/);
      if (!match) return pathname;
      if (runtime.localization) return null;
      return `/i18n/${match[1] === "dynamic" ? "dynamic/" : ""}${match[2]}.json`;
    };
    if (isMainClaudeHost && (
      url.pathname.startsWith("/assets/") ||
      url.pathname.startsWith("/audio/") ||
      url.pathname.startsWith("/i18n/") && !runtime.localization ||
      url.pathname.startsWith("/images/") ||
      ["/client-shell-v1.html", "/favicon-internal.ico", "/favicon-staging.ico", "/favicon.ico",
        "/frame-connect.html", "/frame-manage.html", "/frame-shell.html", "/scc.json",
        "/third-party-notices.txt"].includes(url.pathname)
    )) return mapI18nPath(url.pathname);
    const cdnPrefix = "/claude-ai/v2/";
    if (hostName === "assets-proxy.anthropic.com" && url.pathname.startsWith(cdnPrefix)) {
      const pathname = `/${url.pathname.slice(cdnPrefix.length)}`;
      if (
        pathname.startsWith("/assets/") ||
        pathname.startsWith("/audio/") ||
        pathname.startsWith("/i18n/") && !runtime.localization ||
        pathname.startsWith("/images/") ||
        ["/client-shell-v1.html", "/favicon-internal.ico", "/favicon-staging.ico", "/favicon.ico",
          "/frame-connect.html", "/frame-manage.html", "/frame-shell.html", "/scc.json",
          "/third-party-notices.txt"].includes(pathname)
      ) return mapI18nPath(pathname);
    }
    return null;
  })();
  if (officialResourcePath) {
    const resource = officialAssets.read(officialResourcePath);
    if (!resource) {
      if (hostName !== "assets-proxy.anthropic.com") {
        res.writeHead(404, { "cache-control": "no-store" });
        return res.end();
      }
    } else {
      const headers = {
        "content-type": resource.contentType,
        "content-length": resource.body.length,
        "cache-control": resource.isHtml ? "no-cache" : "public, max-age=31536000, immutable",
        "x-content-type-options": "nosniff",
      };
      if (hostName === "assets-proxy.anthropic.com") headers["access-control-allow-origin"] = "*";
      if (req.method === "HEAD") {
        res.writeHead(200, headers);
        return res.end();
      }
      res.writeHead(200, headers);
      return res.end(resource.body);
    }
  }

  // 受管 profile 直接使用安装包内同一版本的官方SPA和静态资源，不依赖旧HTML录制缓存（见 useOfficialShell）。
  if (
    useOfficialShell &&
    MODE === "mock" &&
    isMainClaudeHost &&
    req.method === "GET" &&
    !path.extname(url.pathname) &&
    !/^\/(?:api|edge-api|v1|claudeai-rpc)(?:\/|$)/.test(url.pathname)
  ) {
    const shell = addExtensions(officialShell);
    res.writeHead(200, {
      "content-type": "text/html; charset=utf-8",
      "content-length": Buffer.byteLength(shell),
      "cache-control": "no-cache",
    });
    return res.end(shell);
  }

  if (
    MODE === "mock" && runtime.voiceInput &&
    req.method === "GET" &&
    url.hostname.toLowerCase() === "assets-proxy.anthropic.com" &&
    (
      url.pathname === "/claude-ai/v2/assets/v1/c342ae4ef-ROR3Yba4.js" ||
      startupAssets.some((asset) => asset.pathname === url.pathname)
    ) &&
    !url.search
  ) {
    const cacheKey = `${url.host}${url.pathname}`;
    const cachedPath = cachePathFor(cacheKey);
    const metaPath = `${cachedPath}.json`;
    if (fs.existsSync(cachedPath) && fs.existsSync(metaPath)) {
      const meta = JSON.parse(fs.readFileSync(metaPath, "utf8"));
      const body = fs.readFileSync(cachedPath);
      const patched = url.pathname === "/claude-ai/v2/assets/v1/c342ae4ef-ROR3Yba4.js"
        ? body.includes(Buffer.from("D=125e3")) && !body.includes(Buffer.from("D=2e3"))
        : isPatchedStartupAsset(url.pathname, body);
      if (
        meta.status === 200 &&
        meta.url === cacheKey &&
        typeof meta.headers?.["content-type"] === "string" &&
        !meta.headers?.["content-encoding"] &&
        patched
      ) {
        res.writeHead(200, {
          ...meta.headers,
          // 主界面从 claude.ai 跨域导入 CDN 模块，本地副本也必须保留公开资源的 CORS 契约。
          "access-control-allow-origin": "*",
          "content-length": body.length,
          "cache-control": "no-store",
        });
        log(`LOCAL DICTATION ASSET CACHE HIT ${url.pathname}`);
        return res.end(body);
      }
    }
  }

  // isolated-segment.html：前端 IsolatedMarketingPixelSegmentProvider 的分析像素 iframe
  // （shared-l-p-m-w-5: `https://a.claude.ai/isolated-segment.html?v=${buildId}`）。域名是
  // a.claude.ai（不在主站白名单内，会落进下面的非主站直通分支），转发上游会 302 到
  // app-unavailable-in-region。必须在非主站分支**之前**截住。回最小空文档让 iframe 正常加载。
  if (MODE === "mock" && /^\/(?:isolated-segment|sealed-entry)\.html$/.test(url.pathname) &&
      /(^|\.)claude\.(ai|com)$/i.test(hostName)) {
    const stub = "<!doctype html><html lang=\"en\"><head><meta charset=\"UTF-8\">" +
      "<title>segment</title><style>html,body{margin:0;padding:0;background:transparent}</style>" +
      "</head><body></body></html>";
    res.writeHead(200, {
      "content-type": "text/html; charset=utf-8",
      "content-length": Buffer.byteLength(stub),
      "cache-control": "no-store",
    });
    return res.end(stub);
  }

  // 只有主站 claude.ai/claude.com 本身走 mock；其余子域（downloads/assets-proxy 等）
  // 和其他 MITM 域一样直通真 host —— 否则 downloads.claude.ai 会被改写成 claude.ai 而 404。
  if (!/^(claude\.ai|www\.claude\.ai|claude\.com|www\.claude\.com)$/i.test(host)) {
    if (serveCachedStaticAsset(req, res, url)) return;
    // api.anthropic.com 的 OAuth 换票链本地化：authorize 回 redirect_uri(带 code)，token 回凭据。
    // 真服务器会拒掉我们种的假 sessionKey，导致 oauth-v2 fresh exchange 失败、
    // 客户端判 session_stale_relogin → "Couldn't verify your sign-in"。
    if (MODE !== "passthrough" && /(^|\.)anthropic\.com$/i.test(host)) {
      // GET 探测：会话是否对 elevate grant 过期 → false 即新鲜
      if (req.method === "GET" && /^\/v1\/oauth\/[^/]+\/authorize$/.test(url.pathname)) {
        return json(res, { session_stale_for_elevated_grant: false });
      }
      if (req.method === "POST" && /^\/(v1\/)?oauth\/([^/]+\/)?authorize$/.test(url.pathname)) {
        return readBody(req, (raw) => {
          const authCode = "local-auth-code-" + crypto.randomUUID().slice(0, 8);
          try {
            const j = JSON.parse(raw.toString("utf8"));
            const rt = String(j.redirect_uri || "claude://oauth/callback");
            const sep = rt.includes("?") ? "&" : "?";
            const loc = `${rt}${sep}code=${authCode}${j.state ? `&state=${encodeURIComponent(j.state)}` : ""}`;
            return json(res, { redirect_uri: loc, code: authCode, state: j.state });
          } catch {
            return json(res, { redirect_uri: `claude://oauth/callback?code=${authCode}`, code: authCode });
          }
        });
      }
      if (req.method === "POST" && url.pathname === "/v1/oauth/token") {
        return readBody(req, (raw) => {
          let scope;
          try { scope = JSON.parse(raw.toString("utf8")).scope; } catch {}
          return json(res, {
            access_token: "local-access-" + crypto.randomUUID(),
            refresh_token: "local-refresh-" + crypto.randomUUID(),
            token_type: "Bearer",
            expires_in: 28800,
            ...(scope ? { scope } : {}),
          });
        });
      }
      // oauth profile：authorize 后的身份确认
      if (req.method === "GET" && url.pathname === "/api/oauth/profile") {
        return json(res, {
          account: { uuid: ACCOUNT.uuid, email_address: ACCOUNT.email, full_name: ACCOUNT.name },
          organization: { uuid: ORG.uuid, name: ORG.name },
        });
      }
      if (req.method === "GET" && url.pathname === "/api/directory/plugins") {
        return publicPluginDirectory(req, res, url);
      }
      if (/^\/api\/organizations\/[^/]+\/directory\/plugins$/.test(url.pathname)) {
        return json(res, EMPTY_PLUGIN_DIRECTORY);
      }
      if (/\/dxt\/(?:extensions|installable_extensions)$/.test(url.pathname)) {
        return json(res, { entries: [], total: 0 });
      }
      // Statsig/实验求值与 frame 契约：这些请求从 api.anthropic.com 域发出，转发上游 403。
      // claude.ai 域的同名请求在 mockApi 的 localCodeApi 里处理；这里覆盖 anthropic 域。
      // POST 带 body 的请求必须先读完请求体再响应，否则客户端写剩余 body 时 ECONNRESET。
      if (/^\/api\/eval\//.test(url.pathname) || url.pathname === "/api/frame/contract/latest" ||
          url.pathname === "/api/directory/server-urls" ||
          /^\/api\/frame\//.test(url.pathname) ||
          (req.method === "GET" && url.pathname === "/api/artifacts/mcp")) {
        return readBody(req, () => {
          if (url.pathname === "/api/frame/contract/latest") return json(res, { contract: null, version: null });
          if (url.pathname === "/api/directory/server-urls") {
            return json(res, { claude_ai: "https://claude.ai", api: "https://api.anthropic.com" });
          }
          if (/^\/api\/frame\/track/.test(url.pathname)) return json(res, { ok: true });
          if (/^\/api\/frame\/[^/]+$/.test(url.pathname)) {
            return json(res, { error: "not_found", message: "Frame not found" }, 404);
          }
          json(res, {});
        });
      }
      // 远端托管策略：本地空放行（不挡插件/连接器）。
      // CLI 比 Desktop 校验更严格，settings 响应必须包含 uuid/checksum/settings。
      // policy_limits → {restrictions:{},compliance_taints:[],defaults:{}}（BymwSUZ2 校验器）
      if (/^\/api\/claude_code\/settings/.test(url.pathname)) {
        const body = JSON.stringify({ uuid: ORG.uuid, settings: {}, content: { entries: {} }, checksum: "local-1" });
        res.writeHead(200, {
          "content-type": "application/json; charset=utf-8",
          "content-length": Buffer.byteLength(body),
          etag: '"local-1"',
          "cache-control": "no-store",
        });
        return res.end(body);
      }
      if (/^\/api\/claude_code\/policy_limits/.test(url.pathname)) {
        return json(res, POLICY_LIMITS);
      }
      // token 计数：网关不一定实现，本地估算
      if (req.method === "POST" && url.pathname === "/v1/messages/count_tokens") {
        return readBody(req, (raw) =>
          json(res, { input_tokens: Math.max(1, Math.ceil(raw.length / 4)), context_management: null }),
        );
      }
      if (req.method === "GET" && /^\/v1\/models/.test(url.pathname)) {
        return json(res, modelList(runtime));
      }
      // 用户自定义 API 网关（reclaude2api / ccbobi.com 等）：桌面端会多发 diagnostics
      // 等字段，严格 schema 的网关会 400。剥掉已知不兼容字段后转发到真 host。
      // 真正的模型调用：转发到本地 Anthropic 兼容网关（流式原样透传）
      if (req.method === "POST" && url.pathname === "/v1/messages") {
        return readBody(req, (raw) => forwardGateway(req, res, url.pathname + url.search, raw));
      }
      // Code 面板打到 api.anthropic.com 的本地化接口：GitHub App 安装状态 / MCP 预热 /
      // 仓库信任。这些请求转发上游会 20 秒超时并打崩 proxy，本地直接回空。
      if (req.method === "GET" && url.pathname === "/v1/code/github/org-connection/installations-status") {
        return json(res, { installations: [], org_connection: null, connected: false, viewer: null });
      }
      if (req.method === "POST" && url.pathname === "/v1/code/mcp-config/prewarm") return json(res, {});
      if (req.method === "GET" && url.pathname === "/v1/code/repository-trust") {
        return json(res, { repositories: [] });
      }
      if (/^\/v1\/code\/github\//.test(url.pathname)) return json(res, { installations: [] });
      // Code 面板的 CLI bootstrap 会以 api.anthropic.com 为主机；本地直接回，
      // 不能转发上游（真服务器对本地会话返回 403，Code 面板会一直等账号就绪）。
      if (/^\/api\/claude_cli\/bootstrap/.test(url.pathname)) {
        return json(res, { client_data: {}, settings: {}, config: {}, enabled: true, environments: [], sessions: [], plugins: [], items: [], data: [] });
      }
      if (/^\/api\/claude_cli\//.test(url.pathname)) {
        return json(res, { settings: {}, config: {}, enabled: true, data: [], items: [], sessions: [], environments: [] });
      }
    }
    // 非主站域（downloads/assets-proxy 等）：统一走 proxyUpstream，
    // 保留原始主机、写穿缓存、UPSTREAM_MAP 可重定向到本地 fixture。
    return proxyUpstream(req, res, url);
  }

  if (url.pathname.startsWith("/edge-api/")) return mockEdgeApi(req, res, url);

  // i18n：复用仓库与本机录制词表，短 ID 和动态词表按各自契约返回。
  if (MODE !== "passthrough" && runtime.localization && url.pathname.startsWith("/i18n/")) {
    const hit = localI18n(url.pathname);
    if (hit) {
      res.writeHead(200, {
        "content-type": "application/json; charset=utf-8",
        "content-length": hit.length,
        "cache-control": "no-store",
      });
      return res.end(hit);
    }
    return json(res, {});
  }

  // claude.ai 上的托管设置/policy 端点（同 api.anthropic.com 的 mock，schema 照解包校验器）
  if (MODE !== "passthrough" && /^\/api\/claude_code\/settings/.test(url.pathname)) {
    const body = JSON.stringify({ uuid: ORG.uuid, settings: {}, content: { entries: {} }, checksum: "local-1" });
    res.writeHead(200, {
      "content-type": "application/json; charset=utf-8",
      "content-length": Buffer.byteLength(body),
      etag: '"local-1"',
      "cache-control": "no-store",
    });
    return res.end(body);
  }
  if (MODE !== "passthrough" && /^\/api\/claude_code\/policy_limits/.test(url.pathname)) {
    return json(res, POLICY_LIMITS);
  }
  if (MODE !== "passthrough" && /^\/api\/claude_cli\/bootstrap/.test(url.pathname)) {
    return json(res, { client_data: {}, settings: {}, config: {}, enabled: true, environments: [], sessions: [], plugins: [], items: [], data: [] });
  }
  if (MODE !== "passthrough" && /^\/api\/claude_code\//.test(url.pathname)) {
    const body = JSON.stringify({ uuid: ORG.uuid, settings: {}, content: { entries: {} }, checksum: "local-1" });
    res.writeHead(200, { "content-type": "application/json; charset=utf-8", "content-length": Buffer.byteLength(body), etag: '"local-1"', "cache-control": "no-store" });
    return res.end(body);
  }

  // 登录页外壳：直接回放录制到的 HTML（200，而不是上游的 302）。
  // 仅 mock 模式；demo 模式的 / 走上面的演示页。
  // / 和 /login 直接跳 /new：回登出态壳会让 app 跑登录/onboarding 流程（join/org-discovery）
  if (MODE === "mock" && ["/", "/login", "/app-unavailable-in-region"].includes(url.pathname)) {
    res.writeHead(302, { location: "/new", "content-length": 0 });
    return res.end();
  }
  // 不看 Accept：Claude 加载主界面 /epitaxy 时不带 text/html，按 isDocNav 判断会漏掉、落到线上兜底。
  if (
    MODE === "mock" && TEMPLATE_SHELL && isMainClaudeHost &&
    req.method === "GET" &&
    !path.extname(url.pathname) &&
    !/^\/(?:api|edge-api|v1|claudeai-rpc)(?:\/|$)/.test(url.pathname)
  ) {
    const shell = addExtensions(TEMPLATE_SHELL_HTML);
    res.writeHead(200, {
      "content-type": "text/html; charset=utf-8",
      "content-length": Buffer.byteLength(shell),
      "cache-control": "no-store",
      ...(url.pathname === "/new" ? { "set-cookie": activeOrgCookies() } : {}),
    });
    return res.end(shell);
  }
  if (MODE === "mock" && url.pathname === "/new") {
    const key = crypto.createHash("sha1").update("claude.ai/login").digest("hex");
    const file = path.join(READ_CACHE, key);
    if (fs.existsSync(file)) {
      const body = fs.readFileSync(file);
      res.writeHead(200, {
        "content-type": "text/html; charset=utf-8",
        "content-length": body.length,
        "set-cookie": activeOrgCookies(),
      });
      return res.end(body);
    }
  }

  // ── claudeai-rpc：ConversationService 全部走 conversation-service.mjs ──
  if (url.pathname.startsWith("/claudeai-rpc/")) {
    const method = url.pathname.split("/").pop();
    const raw = [];
    req.on("data", (c) => raw.push(c));
    req.on("end", () => {
      conversationService
        .handle(method, req, res, Buffer.concat(raw))
        .catch((e) => {
          log(`RPC ${method} error${runtime.managed ? "" : `: ${e.message}`}`);
          try {
            if (!res.headersSent) res.writeHead(500, { "content-type": "text/plain" });
            res.end(`rpc error: ${e.message}\n`);
          } catch {}
        });
    });
    return;
  }

  const isApi = url.pathname.startsWith("/api/") || url.pathname.startsWith("/v1/");
  if (isApi) {
    if (MODE === "demo" || MODE === "mock") return mockApi(req, res, url);
  }
  if (MODE === "demo" && (url.pathname === "/" || url.pathname === "/login")) {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    return res.end(demoHtml);
  }
  if (url.pathname === "/manifest.json") {
    return json(res, { name: "Claude", short_name: "Claude", start_url: "/", display: "standalone", icons: [] });
  }

  // mock 模式：静态资源优先走本地缓存，避免被上游按地区 302
  if (MODE !== "passthrough" && !dataManaged && req.method === "GET") {
    const key = `${host}${url.pathname}${url.search}`;
    const cp = cachePathFor(key);
    const docNav = isDocNav(req, url);
    if (fs.existsSync(cp) && fs.existsSync(`${cp}.json`)) {
      const meta = JSON.parse(fs.readFileSync(`${cp}.json`, "utf8"));
      const cached = fs.readFileSync(cp);
      // 文档导航只允许真外壳通过；桩体/重定向（登出落地页）改走外壳兜底
      if (!docNav || (meta.status === 200 && cached.length >= 4096)) {
        const body = docNav && !meta.headers?.["content-encoding"] ? addExtensions(cached) : cached;
        res.writeHead(meta.status && meta.status < 400 ? 200 : meta.status, {
          ...meta.headers,
          "content-length": body.length,
          "cache-control": "no-store",
        });
        return res.end(body);
      }
    }
    if (docNav) return serveDocShell(req, res, url);
  }

  // mock 模式：接口路径回 {}，HTML 路由回 SPA 外壳
  if (MODE === "mock" && !path.extname(url.pathname)) {
    if (url.pathname.startsWith("/api/") || url.pathname.startsWith("/v1/")) return json(res, {});
    return serveDocShell(req, res, url);
  }
  if (MODE === "passthrough" || MODE === "mock") return proxyUpstream(req, res, url);
  res.writeHead(404, { "content-type": "text/plain" });
  res.end("not found (demo mode)\n");
}

// 内层 HTTP server：处理解密后的请求
const inner = http.createServer((req, res) => handle(req, res, req.headers.host));

let activeDictationWsConnections = 0;

function rejectUpgrade(socket, status, reason) {
  if (socket.destroyed) return;
  const body = Buffer.from(`${reason}\n`);
  socket.end(
    `HTTP/1.1 ${status}\r\nConnection: close\r\nContent-Type: text/plain; charset=utf-8\r\nContent-Length: ${body.length}\r\n\r\n${body.toString("utf8")}`,
  );
}

function isClaudeHostname(value) {
  if (typeof value !== "string") return false;
  let parsed;
  try {
    parsed = new URL(`https://${value}`);
  } catch {
    return false;
  }
  return !parsed.username && !parsed.password &&
    (!parsed.port || parsed.port === "443") &&
    DICTATION_ALLOWED_HOSTS.has(parsed.hostname.toLowerCase());
}

function dictationLanguage(requestUrl) {
  let parsed;
  try {
    parsed = new URL(requestUrl, "https://claude.ai");
  } catch {
    return null;
  }
  if (parsed.pathname !== DICTATION_WS_PATH || parsed.search.length > 2048) return null;
  const values = parsed.searchParams.getAll("language");
  if (values.length > 1) return null;
  const raw = (values[0] || "auto").trim().toLowerCase();
  const language = raw.split(/[-_]/, 1)[0];
  return ["auto", "zh", "en", "yue", "ja", "ko"].includes(language) ? language : null;
}

function readDictationReceipt() {
  const receiptPath = path.join(APP_STATE_DIR, "dictation-helper.json");
  try {
    if (!isPrivateFile(fs.lstatSync(receiptPath))) return null;
    const receipt = JSON.parse(fs.readFileSync(receiptPath, "utf8"));
    if (
      !Number.isInteger(receipt.port) || receipt.port < 1 || receipt.port > 65535 ||
      typeof receipt.token !== "string" ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(receipt.token)
    ) return null;
    return receipt;
  } catch {
    return null;
  }
}

function expectedWebSocketAccept(key) {
  return crypto.createHash("sha1")
    .update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
    .digest("base64");
}

function validWebSocketKey(key) {
  if (typeof key !== "string") return false;
  const decoded = Buffer.from(key, "base64");
  return decoded.length === 16 && decoded.toString("base64") === key;
}

function responseUpgradeHeaders(response) {
  let raw = `HTTP/${response.httpVersion} ${response.statusCode} ${response.statusMessage || ""}\r\n`;
  for (let index = 0; index < response.rawHeaders.length; index += 2) {
    raw += `${response.rawHeaders[index]}: ${response.rawHeaders[index + 1]}\r\n`;
  }
  return `${raw}\r\n`;
}

function handleDictationUpgrade(req, clientSocket, head) {
  const language = dictationLanguage(req.url || "");
  if (language === null) return rejectUpgrade(clientSocket, "404 Not Found", "not found");
  if (MODE !== "mock" || !runtime.voiceInput) return rejectUpgrade(clientSocket, "503 Service Unavailable", "local dictation is unavailable");
  noteClient();
  if (!isClaudeHostname(req.headers.host)) return rejectUpgrade(clientSocket, "403 Forbidden", "forbidden");
  if (req.headers.origin) {
    let origin;
    try {
      origin = new URL(req.headers.origin);
    } catch {
      return rejectUpgrade(clientSocket, "403 Forbidden", "forbidden");
    }
    if (
      origin.protocol !== "https:" ||
      origin.username ||
      origin.password ||
      origin.pathname !== "/" ||
      origin.search ||
      origin.hash ||
      !DESKTOP_WEB_ORIGINS.has(origin.origin)
    ) {
      return rejectUpgrade(clientSocket, "403 Forbidden", "forbidden");
    }
  }
  const connection = String(req.headers.connection || "").toLowerCase().split(",").map((part) => part.trim());
  const key = req.headers["sec-websocket-key"];
  if (
    req.method !== "GET" ||
    String(req.headers.upgrade || "").toLowerCase() !== "websocket" ||
    !connection.includes("upgrade") ||
    req.headers["sec-websocket-version"] !== "13" ||
    !validWebSocketKey(key) ||
    head.length > 64 * 1024
  ) return rejectUpgrade(clientSocket, "400 Bad Request", "invalid websocket request");
  if (activeDictationWsConnections >= MAX_DICTATION_WS_CONNECTIONS) {
    return rejectUpgrade(clientSocket, "503 Service Unavailable", "local dictation is busy");
  }
  const receipt = readDictationReceipt();
  if (!receipt) return rejectUpgrade(clientSocket, "503 Service Unavailable", "local dictation is unavailable");

  activeDictationWsConnections += 1;
  let finished = false;
  let transferredBytes = head.length;
  let idleTimer;
  let durationTimer;
  const finish = () => {
    if (finished) return;
    finished = true;
    clearTimeout(idleTimer);
    clearTimeout(durationTimer);
    activeDictationWsConnections = Math.max(0, activeDictationWsConnections - 1);
  };
  const request = http.request({
    hostname: "127.0.0.1",
    port: receipt.port,
    method: "GET",
    path: `${DICTATION_HELPER_PATH}?language=${encodeURIComponent(language)}`,
    agent: false,
    headers: {
      host: `127.0.0.1:${receipt.port}`,
      connection: "Upgrade",
      upgrade: "websocket",
      "sec-websocket-key": key,
      "sec-websocket-version": "13",
      "x-codex-plus-dictation-token": receipt.token,
    },
  });
  clientSocket.pause();
  clientSocket.once("close", () => {
    finish();
    request.destroy();
  });
  const fail = () => {
    finish();
    if (!clientSocket.destroyed) rejectUpgrade(clientSocket, "503 Service Unavailable", "local dictation is unavailable");
  };
  request.setTimeout(10000, () => request.destroy());
  request.on("upgrade", (response, helperSocket, helperHead) => {
    request.setTimeout(0);
    if (
      response.statusCode !== 101 ||
      String(response.headers.upgrade || "").toLowerCase() !== "websocket" ||
      response.headers["sec-websocket-accept"] !== expectedWebSocketAccept(key)
    ) {
      helperSocket.destroy();
      return fail();
    }
    const closeNow = () => {
      finish();
      if (!clientSocket.destroyed) clientSocket.destroy();
      if (!helperSocket.destroyed) helperSocket.destroy();
    };
    const resetIdleTimer = () => {
      clearTimeout(idleTimer);
      idleTimer = setTimeout(closeNow, MAX_DICTATION_WS_IDLE_MS);
    };
    const accountBytes = (chunk) => {
      transferredBytes += chunk.length;
      if (transferredBytes > MAX_DICTATION_WS_BYTES) {
        closeNow();
        return;
      }
      resetIdleTimer();
    };
    transferredBytes += helperHead.length;
    if (transferredBytes > MAX_DICTATION_WS_BYTES) return closeNow();
    durationTimer = setTimeout(closeNow, MAX_DICTATION_WS_DURATION_MS);
    resetIdleTimer();
    clientSocket.on("error", closeNow);
    helperSocket.on("error", closeNow);
    clientSocket.once("close", () => {
      finish();
      helperSocket.destroy();
    });
    clientSocket.once("finish", () => {
      finish();
      helperSocket.destroy();
    });
    helperSocket.once("close", () => {
      if (!helperSocket.readableEnded) return closeNow();
      if (!clientSocket.destroyed && !clientSocket.writableEnded) clientSocket.end();
    });
    clientSocket.on("data", accountBytes);
    helperSocket.on("data", accountBytes);
    clientSocket.write(responseUpgradeHeaders(response));
    if (helperHead.length) clientSocket.write(helperHead);
    if (head.length) helperSocket.write(head);
    clientSocket.pipe(helperSocket);
    helperSocket.pipe(clientSocket);
    clientSocket.resume();
  });
  request.on("response", (response) => {
    response.resume();
    fail();
  });
  request.on("error", fail);
  request.end();
}

inner.on("upgrade", handleDictationUpgrade);

// 外层 HTTP server：CONNECT 做 TLS 终止；普通 HTTP（桌面 CLI 的 ANTHROPIC_BASE_URL 流量）
// 剥掉桌面端多发、上游网关不认的字段后转给本地 magpie。
const outer = http.createServer((req, res) => {
  const u = new URL(req.url, `http://${req.headers.host || "127.0.0.1"}`);
  // 连接器登录的回调是浏览器直接打开的，带不了本地凭据：凭的是登录开始时发出去的随机 state。
  if (req.method === "GET" && u.pathname === CONNECTOR_SIGN_IN_PATH) return connectorSignInCallback(res, u);
  if (runtime.managed && req.headers.origin !== undefined) return json(res, { error: "Browser origins are not allowed" }, 403);
  if (req.method === "GET" && u.pathname === "/__codex_claude_local/health") return json(res, health());
  if (runtime.managed) {
    const bearer = typeof req.headers.authorization === "string" && req.headers.authorization.startsWith("Bearer ")
      ? req.headers.authorization.slice(7) : "";
    const supplied = typeof req.headers["x-api-key"] === "string" ? req.headers["x-api-key"] : bearer;
    const actual = Buffer.from(supplied);
    const expected = Buffer.from(runtime.key);
    if (actual.length !== expected.length || !crypto.timingSafeEqual(actual, expected)) {
      return json(res, { error: "Local gateway authorization required" }, 403);
    }
  }
  noteClient();
  // Artifacts：CLI/Code 也会直连本机端口取 artifact 工具与 frame 数据（外层已过 Bearer 鉴权）。
  if (req.method === "POST" && u.pathname === "/api/artifacts/mcp") return serveArtifactsMcp(req, res, u, (u.hostname || "127.0.0.1").toLowerCase());
  if ((req.method === "GET" || req.method === "HEAD") && u.pathname.startsWith("/__claude_local/artifacts")) {
    if (artifactService.handleLocalApi(req.method, u, req, res)) return;
  }
  if (artifactService.handleFrameApi(req.method, u, req, res)) return;
  const fwd = (body) => forwardGateway(req, res, u.pathname + u.search, body);
  if (req.method === "GET" && u.pathname === "/v1/models") return json(res, modelList(runtime));
  if (req.method === "POST" && u.pathname === "/v1/messages") {
    return readBody(req, fwd);
  }
  // 会话 apiHost=127.0.0.1:8899 时，托管设置/policy 也会打到这里：本地 mock，别转 magpie
  if (/^\/api\/claude_cli\/bootstrap/.test(u.pathname)) {
    return json(res, { client_data: {}, settings: {}, config: {}, enabled: true, environments: [], sessions: [], plugins: [], items: [], data: [] });
  }
  if (u.pathname === "/api/directory/plugins" || /^\/api\/organizations\/[^/]+\/directory\/plugins$/.test(u.pathname)) {
    return json(res, EMPTY_PLUGIN_DIRECTORY);
  }
  if (/\/dxt\/(?:extensions|installable_extensions)$/.test(u.pathname)) {
    return json(res, { entries: [], total: 0 });
  }
  if (/^\/api\/claude_code\/policy_limits/.test(u.pathname)) {
    return json(res, POLICY_LIMITS);
  }
  if (/^\/api\/claude_code\//.test(u.pathname)) {
    const body = JSON.stringify({ uuid: ORG.uuid, settings: {}, content: { entries: {} }, checksum: "local-1" });
    res.writeHead(200, { "content-type": "application/json; charset=utf-8", "content-length": Buffer.byteLength(body), etag: '"local-1"', "cache-control": "no-store" });
    return res.end(body);
  }
  if (req.method === "POST" && u.pathname === "/v1/messages/count_tokens") {
    return readBody(req, (raw) => json(res, { input_tokens: Math.max(1, Math.ceil(raw.length / 4)), context_management: null }));
  }
  // 其余 HTTP 请求（GET/POST 等）原样转发 magpie
  return readBody(req, fwd);
});

// claudeusercontent.com（含 <uuid>.claudeusercontent.com 内容子域）必须终止 TLS：
// handle() 里有该域的 frame 运行时路由，服务证书 SAN 也覆盖它。漏掉的话 CONNECT 直通，
// 内容 iframe 的 TLS 握手打到真实互联网（受限环境会被重置），作品永远 "Couldn't load artifact"。
const MITM_HOSTS = runtime.managed
  ? /(^|\.)(claude\.ai|claude\.com|anthropic\.com|claudeusercontent\.com)$/i
  : /(^|\.)(claude\.ai|claude\.com|anthropic\.com|ccbobi\.com|claudeusercontent\.com)$/i;

const PASS_THROUGH_CONNECT_TIMEOUT_MS = 15_000;

// 非 claude 域名的 TCP 隧道。Claude 被 --proxy-server 指到本代理后，这些域名（统计、错误上报、
// 第三方 CDN 等）也都经过这里：
// - Claude 一侧关闭（含 RST）或任一侧出错：两侧立即一起关。只看上游出错会把上游连接一直留着。
// - 上游正常关闭：交给 pipe 把剩余数据写完再关 Claude 一侧，不截断。
// - 连不上的目标限时放弃；Claude 先放弃时同时取消还没连上的连接，不在后台继续连。
// - 配了出站代理时经它 CONNECT：系统代理对 Claude 已失效，直连在受限网络里连不上，越积越多。
function passThrough(clientSocket, host, port, head) {
  let upstream = null;
  let pending = null;
  let open = false;
  let done = false;
  const teardown = () => {
    if (done) return;
    done = true;
    clearTimeout(timer);
    pending?.destroy();
    upstream?.destroy();
    clientSocket.destroy();
  };
  const timer = setTimeout(teardown, PASS_THROUGH_CONNECT_TIMEOUT_MS);
  clientSocket.once("close", teardown);
  // CONNECT 交过来的 socket 没人读，Claude 断开时这里收不到 FIN/RST。隧道建好前先读着：
  // 早到的数据暂存，建好后补发；Claude 在这期间关掉就立刻取消。
  const early = [];
  const onEarlyData = (chunk) => early.push(chunk);
  const onEarlyEnd = () => teardown();
  clientSocket.on("data", onEarlyData);
  clientSocket.once("end", onEarlyEnd);
  const attach = (socket) => {
    upstream = socket;
    socket.on("error", teardown);
    socket.once("close", (hadError) => {
      if (hadError || !open) teardown();
    });
  };
  const established = (upstreamHead) => {
    if (done) return;
    open = true;
    clearTimeout(timer);
    clientSocket.off("data", onEarlyData);
    clientSocket.off("end", onEarlyEnd);
    clientSocket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
    if (upstreamHead?.length) clientSocket.write(upstreamHead);
    if (head?.length) upstream.write(head);
    for (const chunk of early) upstream.write(chunk);
    upstream.pipe(clientSocket);
    clientSocket.pipe(upstream);
  };

  if (UPSTREAM_PROXY && !isLoopbackHost(host)) {
    const authority = `${host}:${port}`;
    pending = http.request({
      host: UPSTREAM_PROXY.hostname,
      port: Number(UPSTREAM_PROXY.port || 80),
      method: "CONNECT",
      path: authority,
      headers: { host: authority, ...upstreamProxyAuth() },
    });
    pending.once("connect", (response, socket, upstreamHead) => {
      pending = null;
      attach(socket);
      if (response.statusCode !== 200) return teardown();
      established(upstreamHead);
    });
    pending.once("error", teardown);
    pending.end();
    return;
  }
  attach(net.connect(Number(port), host, () => established()));
}

outer.on("connect", (req, clientSocket, head) => {
  noteClient();
  clientSocket.on("error", () => {});
  const [host, port = "443"] = req.url.split(":");
  // 非 claude 域名：TCP 直通，不终止 TLS（保证 CDN / 其他服务不受影响）
  if (!MITM_HOSTS.test(host)) {
    log(`PASS-THROUGH CONNECT ${host}:${port}`);
    return passThrough(clientSocket, host, port, head);
  }
  clientSocket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
  const tlsSocket = new tls.TLSSocket(clientSocket, {
    isServer: true,
    secureContext: ctx,
    requestCert: false,
  });
  tlsSocket.on("error", () => {});
  if (head?.length) tlsSocket.unshift(head);
  inner.emit("connection", tlsSocket);
});

outer.listen(PORT, "127.0.0.1", () => {
  listeningPort = outer.address().port;
  writeReady();
  console.log(`claude-local proxy: 127.0.0.1:${listeningPort}  mode=${MODE}`);
});

const clientSockets = new Set();
outer.on("connection", (socket) => {
  clientSockets.add(socket);
  socket.once("close", () => clientSockets.delete(socket));
});
let stopping = false;
function shutdown() {
  if (stopping) return;
  stopping = true;
  clearTimeout(readyWriteTimer);
  stateStore.flush();
  outer.close(() => process.exit(0));
  for (const socket of clientSockets) socket.destroy();
  setTimeout(() => process.exit(0), 1000).unref();
}
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
if (runtime.managed) {
  process.stdin.on("end", shutdown);
  process.stdin.resume();
}
