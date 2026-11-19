import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { StringDecoder } from "node:string_decoder";

const MAX_STATE_BYTES = 32 * 1024 * 1024;
const MAX_TEXT = 1024 * 1024;
// 没声明窗口的模型按 Claude 自己的假定值走；声明了就一律以声明为准。
const DEFAULT_MODEL_WINDOW = 200_000;
const idPattern = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const isRecord = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const isText = (value, max = MAX_TEXT) => typeof value === "string" && value.length <= max;
const isId = (value) => typeof value === "string" && idPattern.test(value);
const isDate = (value) => typeof value === "string" && value.length <= 64 && Number.isFinite(Date.parse(value));

// Claude 前端只认 free / pro / max 和 max 的 5x/20x，没有 Ultra 档：
// Ultra 按最高档 max_20x 发，只是显示名不同。
export const PLANS = {
  free:  { plan: "free", label: "Free",  capabilities: [],                           rateLimitTier: "default_claude_ai",      analytics: "claude_free" },
  pro:   { plan: "pro",  label: "Pro",   capabilities: ["claude_pro"],               rateLimitTier: "default_claude_ai",      analytics: "claude_pro" },
  max:   { plan: "max",  label: "Max",   capabilities: ["claude_pro", "claude_max"], rateLimitTier: "default_claude_max_5x",  analytics: "claude_max" },
  ultra: { plan: "max",  label: "Ultra", capabilities: ["claude_pro", "claude_max"], rateLimitTier: "default_claude_max_20x", analytics: "claude_max" },
};

export function planProfile(plan) {
  return Object.hasOwn(PLANS, plan) ? PLANS[plan] : PLANS.ultra;
}

export function runtimeConfig(env = process.env) {
  const managed = env.CLAUDE_LOCAL_MANAGED === "1";
  const flag = (name) => env[`CLAUDE_LOCAL_${name}`] !== "0";
  if (managed && ["URL", "KEY", "MODEL"].some((name) => !env[`CLAUDE_LOCAL_GATEWAY_${name}`])) {
    throw new Error("Managed Claude requires a configured local gateway and model");
  }
  const gatewayUrl = env.CLAUDE_LOCAL_GATEWAY_URL || "http://127.0.0.1:3425";
  const gateway = new URL(gatewayUrl);
  if (!["http:", "https:"].includes(gateway.protocol) || gateway.username || gateway.password || gateway.search || gateway.hash) {
    throw new Error("Invalid Claude local gateway address");
  }
  const model = env.CLAUDE_LOCAL_GATEWAY_MODEL || "claude-sonnet-4-6";
  const smallModel = env.CLAUDE_LOCAL_GATEWAY_SMALL_MODEL || model;
  const key = env.CLAUDE_LOCAL_GATEWAY_KEY || "magpie";
  if (!isText(model, 512) || !model || !isText(smallModel, 512) || !smallModel ||
    !isText(key, 8192) || /[\r\n]/.test(key)) {
    throw new Error("Invalid Claude local gateway configuration");
  }
  let models = managed ? [model] : ["claude-sonnet-4-6", "claude-opus-4-6"];
  if (env.CLAUDE_LOCAL_GATEWAY_MODELS) {
    try {
      models = JSON.parse(env.CLAUDE_LOCAL_GATEWAY_MODELS);
    } catch {
      throw new Error("Invalid Claude local gateway model list");
    }
    if (!Array.isArray(models) || models.length > 4096 || models.some((id) => !isText(id, 512) || !id || /[\r\n]/.test(id))) {
      throw new Error("Invalid Claude local gateway model list");
    }
  }
  let modelWindows = {};
  if (env.CLAUDE_LOCAL_GATEWAY_MODEL_WINDOWS) {
    try {
      modelWindows = JSON.parse(env.CLAUDE_LOCAL_GATEWAY_MODEL_WINDOWS);
    } catch {
      throw new Error("Invalid Claude local gateway model windows");
    }
    if (!isRecord(modelWindows) || Object.entries(modelWindows).length > 4096 ||
      Object.entries(modelWindows).some(([id, window]) =>
        !isText(id, 512) || !id || !Number.isSafeInteger(window) || window <= 0)) {
      throw new Error("Invalid Claude local gateway model windows");
    }
  }
  // 选择器显示名（id → {name, description}）：坏数据当没给，界面回退 id。
  const modelNames = (() => {
    try {
      const value = JSON.parse(env.CLAUDE_LOCAL_GATEWAY_MODEL_NAMES || "{}");
      if (!isRecord(value)) return {};
      return Object.fromEntries(Object.entries(value).filter(([id, info]) =>
        isText(id, 512) && id && isRecord(info) && isText(info.name, 512) && (info.description === undefined || isText(info.description, 512))));
    } catch { return {}; }
  })();
  // 选中模型没有逐模型窗口时用这个值兜底（网关按 binding 解析出的窗口）。
  // 写坏了就当没给，不让一次启动失败在建环境变量上。
  const defaultWindow = (() => {
    const raw = env.CLAUDE_LOCAL_GATEWAY_DEFAULT_WINDOW;
    if (raw === undefined || raw === "") return DEFAULT_MODEL_WINDOW;
    const value = Number(raw);
    return Number.isSafeInteger(value) && value > 0 ? value : DEFAULT_MODEL_WINDOW;
  })();
  // 完整功能模式的「PoC 数据路径」：CLAUDE_LOCAL_RECORDED_DIR 指向本机一份
  // 录制数据（.cache/ 静态资产 + mock/bootstrap.json + mock/api/* + i18n/），
  // 命中时数据面按非托管 PoC 回放；目录缺失/不完整则保持合成数据。
  const recordedDir = (() => {
    if (!managed || !env.CLAUDE_LOCAL_RECORDED_DIR) return null;
    const resolved = path.resolve(env.CLAUDE_LOCAL_RECORDED_DIR);
    try {
      if (!fs.statSync(resolved).isDirectory()) return null;
      if (!fs.statSync(path.join(resolved, ".cache")).isDirectory()) return null;
      if (!fs.statSync(path.join(resolved, "mock", "bootstrap.json")).isFile()) return null;
    } catch { return null; }
    return resolved;
  })();
  return {
    managed, gateway, model, smallModel, key,
    models: [...new Set([model, smallModel, ...models])],
    modelWindows,
    modelNames,
    defaultWindow,
    recordedDir,
    localization: flag("LOCALIZATION"),
    voiceInput: flag("VOICE_INPUT"),
    computerUse: flag("COMPUTER_USE"),
    backgroundMode: flag("BACKGROUND_MODE"),
    // 无视 Claude 对后台模式的 macOS 版本上限（见 proxy.mjs 的 /api/desktop/features）。
    // 只认显式的 1：没设置时保持 Claude 自己的限制。
    forceBackgroundMode: env.CLAUDE_LOCAL_FORCE_BACKGROUND_MODE === "1",
    // Cowork 总开关（GrowthBook yukon_silver，见 proxy.mjs 的 resolvedBootstrap）；没设置时按开。
    cowork: flag("COWORK"),
    // 实验性：有模板时页面外壳也用本机 Claude 自带的版本（见 proxy.mjs 的 useOfficialShell）。
    // 只认显式的 1：模板数据是配线上页面的，配本机页面目前缺汉化、账号和会话列表。
    hubHome: env.CLAUDE_LOCAL_HUB_HOME === "1",
    template: (env.CLAUDE_LOCAL_TEMPLATE || "").trim(),
    // 录制 bootstrap 里自带的原生模型（Opus / Sonnet / Haiku …）不对应任何供应商，
    // 选了也会被 gatewayModel 换成默认模型；默认从选择器里拿掉，只留供应商池里的。
    hideUnroutedModels: flag("HIDE_UNROUTED_MODELS"),
    displayName: displayName(env.CLAUDE_LOCAL_DISPLAY_NAME),
    email: email(env.CLAUDE_LOCAL_EMAIL),
    plan: Object.hasOwn(PLANS, env.CLAUDE_LOCAL_PLAN ?? "") ? env.CLAUDE_LOCAL_PLAN : "ultra",
  };
}

// 显示名：trim、去控制字符、最多 64 字符；空则按默认。
function displayName(value) {
  const name = String(value ?? "").trim().replace(/[\u0000-\u001F\u007F]/g, "").slice(0, 64).trim();
  return name || "Local User";
}

// 邮箱：trim 后须形如 a@b（最长 254、无空白与控制字符）；空或不合法按默认。
function email(value) {
  const text = String(value ?? "").trim();
  const at = text.lastIndexOf("@");
  const valid = text.length <= 254 && !/[\s\u0000-\u001F\u007F]/.test(text) && at > 0 && at < text.length - 1;
  return valid ? text : "local@claude.local";
}

export function gatewayTarget(config, requestPath) {
  const target = new URL(config.gateway);
  const requested = new URL(requestPath, "http://localhost");
  target.pathname = `${target.pathname.replace(/\/+$/, "")}/${requested.pathname.replace(/^\/+/, "")}`;
  target.search = requested.search;
  return target;
}

const WINDOW_SUFFIX = /\[\d+[km]\]$/i;

function uniqueModelAlias(models, requested) {
  const target = requested.replace(WINDOW_SUFFIX, "");
  if (!target) return;
  const suffix = requested.slice(target.length).toLowerCase();
  let bestRank = 0;
  let match;
  for (const id of models) {
    const name = id.replace(WINDOW_SUFFIX, "");
    const candidateSuffix = id.slice(name.length).toLowerCase();
    if (suffix && candidateSuffix && suffix !== candidateSuffix) continue;
    const fullName = name === target;
    if (!fullName && !name.endsWith(`.${target}`) && !name.endsWith(`/${target}`)) continue;
    const rank = (fullName ? 3 : 1) + Number(suffix !== "" && suffix === candidateSuffix);
    if (rank > bestRank) {
      bestRank = rank;
      match = id;
    } else if (rank === bestRank) {
      match = undefined;
    }
  }
  return match;
}

export function gatewayModel(config, requested) {
  if (typeof requested !== "string" || !requested) return config.model;
  if (config.models.includes(requested)) return requested;
  const matched = uniqueModelAlias(config.models, requested);
  if (matched) return matched;

  if (/^(?:claude-)?haiku(?:-|$)/i.test(requested)) return config.smallModel;
  if (config.managed || /^(?:claude-|sonnet|opus|haiku)/i.test(requested)) return config.model;
  return requested;
}

const GATEWAY_RAW_LIMIT = 1 << 20;

function gatewayErrorText(value) {
  if (!isRecord(value)) return "";
  const error = value.error;
  if (typeof error === "string") return error;
  if (isRecord(error) && typeof error.message === "string") return error.message;
  return typeof value.message === "string" ? value.message : "";
}

function clip(text, limit = 300) {
  const value = String(text).replace(/\s+/g, " ").trim();
  return value.length > limit ? `${value.slice(0, limit)}…` : value;
}

/** 上游 /v1/messages 回了非 2xx 时给用户看的原因：状态码 + 上游自己的错误信息。 */
export function gatewayHttpError(status, body) {
  const raw = Buffer.isBuffer(body) ? body.toString("utf8") : String(body || "");
  let detail = "";
  try { detail = gatewayErrorText(JSON.parse(raw)); } catch {}
  detail = clip(detail || raw);
  return detail ? `上游返回 HTTP ${status}：${detail}` : `上游返回 HTTP ${status}`;
}

/**
 * 解析上游 /v1/messages 的流式响应（只取文本）。
 *
 * 各家网关并不都按规范来：事件之间用 CRLF 分隔、一个事件多行 data、流里带 `type:"error"`、
 * 不发 message_stop 就结束，甚至无视 stream:true 直接回一整段 JSON。以前遇到这些
 * 一律静默结束，Claude 只能显示「连接已中断」；这里统一归结为 text / stop / error 三种回调。
 */
export function createGatewayStreamParser({ text, stop, error }) {
  const decoder = new StringDecoder("utf8");
  let buf = "";
  let pendingCr = false;
  let raw = "";
  let sawEvent = false;
  let sawText = false;
  let finished = false;

  const finish = (fn, ...args) => {
    if (finished) return;
    finished = true;
    fn(...args);
  };
  const dispatch = (block) => {
    const data = block
      .split("\n")
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(line.startsWith("data: ") ? 6 : 5))
      .join("\n")
      .trim();
    if (!data) return;
    sawEvent = true;
    if (data === "[DONE]" || finished) return;
    let event;
    try { event = JSON.parse(data); } catch { return; }
    if (event.type === "content_block_delta" && event.delta?.type === "text_delta" && event.delta.text) {
      sawText = true;
      text(event.delta.text);
    } else if (event.type === "message_stop") {
      finish(stop);
    } else if (event.type === "error" || (event.error && !event.type)) {
      finish(error, `上游返回错误：${clip(gatewayErrorText(event) || data)}`);
    }
  };
  const feed = (chunk) => {
    let next = (pendingCr ? "\r" : "") + chunk;
    pendingCr = next.endsWith("\r");
    if (pendingCr) next = next.slice(0, -1);
    if (!sawEvent && raw.length < GATEWAY_RAW_LIMIT) raw += next;
    buf += next.replace(/\r\n?/g, "\n");
    let index;
    while ((index = buf.indexOf("\n\n")) >= 0) {
      const block = buf.slice(0, index);
      buf = buf.slice(index + 2);
      dispatch(block);
    }
  };
  return {
    write(chunk) {
      feed(typeof chunk === "string" ? chunk : decoder.write(chunk));
    },
    end() {
      feed(decoder.end() + (pendingCr ? "\n" : ""));
      if (buf.trim()) dispatch(buf);
      buf = "";
      if (finished) return;
      if (!sawEvent) {
        // 不是 SSE：可能是网关忽略了 stream:true，回了整段 JSON（正常回复或错误）。
        let value = null;
        try { value = JSON.parse(raw); } catch {}
        const message = gatewayErrorText(value);
        if (value && (value.type === "error" || (value.error && !Array.isArray(value.content)))) {
          return finish(error, `上游返回错误：${clip(message || raw)}`);
        }
        const blocks = Array.isArray(value?.content) ? value.content : [];
        const reply = blocks.filter((block) => block?.type === "text").map((block) => block.text || "").join("");
        if (reply) {
          text(reply);
          return finish(stop);
        }
        return finish(error, raw.trim()
          ? `上游返回的不是流式回复：${clip(raw)}`
          : "上游没有返回任何内容");
      }
      // 有的网关流完不发 message_stop；有文本就当正常结束。
      if (sawText) return finish(stop);
      return finish(error, "上游没有返回任何内容");
    },
  };
}

/**
 * 凭据文件是否只有当前用户能读：普通文件、不是链接、属主是自己、其他人没有权限。
 * Windows 上 lstat 的 mode 恒为 0o666、没有 uid，POSIX 权限位不反映 ACL，
 * 按它校验必然失败（听写一直 503，#16）；那里只检查是普通文件、不是链接，
 * 权限交给所在的用户目录（%APPDATA%）自身的 ACL。
 */
export function isPrivateFile(metadata, { platform = process.platform, uid = process.getuid?.() } = {}) {
  if (!metadata.isFile() || metadata.isSymbolicLink()) return false;
  if (platform === "win32") return true;
  if ((metadata.mode & 0o077) !== 0) return false;
  return uid === undefined || metadata.uid === uid;
}

export function gatewayBody(config, raw) {
  const value = JSON.parse(raw.toString("utf8"));
  if (!isRecord(value)) throw new Error("Invalid model request");
  delete value.diagnostics;
  if (isRecord(value.metadata)) delete value.metadata.diagnostics;
  value.model = gatewayModel(config, value.model);
  return Buffer.from(JSON.stringify(value));
}

/**
 * 从录制 bootstrap 的各份模型清单里删掉供应商池之外的条目（就地修改）。
 *
 * 这些条目是 Claude 官方模型，池里没有对应的路由：选中后请求会被
 * `gatewayModel` 悄悄换成默认模型，名字与实际不符。只动选择器读的几份清单；
 * growthbook 不碰（池模型本来就不在那里，删空了前端怎么兜底说不准）。
 */
export function dropUnroutedModels(bootstrap, config) {
  if (!isRecord(bootstrap) || !config.models.length) return;
  const routable = new Set(config.models);
  const keep = (list, key) => Array.isArray(list)
    ? list.filter((entry) => !isRecord(entry) || routable.has(entry[key]))
    : list;
  const orgs = [
    bootstrap.activeOrganization,
    ...(Array.isArray(bootstrap.account?.memberships) ? bootstrap.account.memberships.map((m) => m?.organization) : []),
  ];
  for (const org of orgs) {
    if (isRecord(org) && Array.isArray(org.claude_ai_bootstrap_models_config)) {
      org.claude_ai_bootstrap_models_config = keep(org.claude_ai_bootstrap_models_config, "model");
    }
  }
  if (isRecord(bootstrap.claude_ai_available_models)) {
    bootstrap.claude_ai_available_models.models = keep(bootstrap.claude_ai_available_models.models, "model_id");
  }
  if (Array.isArray(bootstrap.model_selector_config)) {
    for (const selector of bootstrap.model_selector_config) {
      if (isRecord(selector)) selector.models = keep(selector.models, "id");
    }
  }
}

// 录制模板里第一项通常是被套餐限制的原生模型，带着这组字段：disabled /
// disabled_reason（upgrade_required）/ selection_notice（CTA「升级」）/ badge
// （「Pro、Max 或 Ultra」）。池内模型已经全部可用，这些限制不该跟着模板复制，
// 否则选择器里每个上游模型都显示「升级」，点它只会打开订阅页。
const MODEL_GATE_KEYS = [
  "badge", "disabled", "disabled_reason", "selection_notice",
  "notice", "notice_text", "tooltip", "inactive", "min_claude_code_version",
];

function clearModelGates(entry) {
  for (const key of MODEL_GATE_KEYS) delete entry[key];
  return entry;
}

/**
 * 把网关池模型并入录制 bootstrap 的模型清单（就地修改）。
 *
 * 原生条目先拿来当新条目的模板；模板里的套餐限制先用 `clearModelGates`
 * 摘掉，名称与副标题用池里的友好名。`hideUnroutedModels`（默认开）时
 * 最后把池外条目删掉，选择器里只剩 provider/model 条目。
 */
export function mergePoolModels(bootstrap, config) {
  const ids = config.models;
  if (!isRecord(bootstrap) || !ids.length) return;
  const label = (id) => modelLabel(config, id);
  const cfg = bootstrap.activeOrganization?.claude_ai_bootstrap_models_config;
  if (Array.isArray(cfg)) {
    const seen = new Set(cfg.map((m) => m?.model));
    const tpl = cfg[0] ?? {};
    for (const entry of cfg) {
      if (!isRecord(entry) || !ids.includes(entry.model)) continue;
      clearModelGates(entry);
      entry.hard_limit = modelWindow(config, entry.model);
      entry.context_window = modelWindow(config, entry.model);
    }
    for (const id of ids) {
      if (!seen.has(id)) cfg.push(clearModelGates({
        ...tpl,
        model: id,
        name: label(id).name,
        description: label(id).description || id,
        hard_limit: modelWindow(config, id),
        context_window: modelWindow(config, id),
      }));
    }
  }
  const avail = bootstrap.claude_ai_available_models?.models;
  if (Array.isArray(avail)) {
    const seen = new Set(avail.map((m) => m?.model_id));
    for (const id of ids) {
      if (!seen.has(id)) avail.push({ model_id: id, minimum_tier: "free" });
    }
  }
  if (Array.isArray(bootstrap.model_selector_config)) {
    for (const sel of bootstrap.model_selector_config) {
      if (!Array.isArray(sel?.models)) continue;
      const seen = new Set(sel.models.map((m) => m?.id));
      const tpl = sel.models[0] ?? {};
      for (const entry of sel.models) {
        if (!isRecord(entry) || !ids.includes(entry.id)) continue;
        clearModelGates(entry);
        entry.disabled = false;
        entry.disabled_reason = null;
        entry.hard_limit = modelWindow(config, entry.id);
        entry.context_window = modelWindow(config, entry.id);
        entry.runtime = { max_input_tokens: modelWindow(config, entry.id) };
      }
      for (const id of ids) {
        if (seen.has(id)) continue;
        const entry = clearModelGates({
          ...tpl,
          id,
          name: label(id).name,
          short_name: label(id).name,
          description: label(id).description || id,
          hard_limit: modelWindow(config, id),
          context_window: modelWindow(config, id),
          runtime: { max_input_tokens: modelWindow(config, id) },
        });
        // 清掉模板的限制后再补上明确的「可用」，与 modelSelectors() 生成的条目一致。
        entry.disabled = false;
        entry.disabled_reason = null;
        sel.models.push(entry);
      }
    }
  }
  if (Array.isArray(bootstrap.model_selector_state)) {
    const thinking = { type: "effort", effort: "medium" };
    bootstrap.model_selector_state = bootstrap.model_selector_state.map((s) => s && typeof s === "object"
      ? { ...s, model: config.model, thinking_by_model: ids.map((id) => ({ id, thinking })) }
      : s);
  }
  if (config.hideUnroutedModels) dropUnroutedModels(bootstrap, config);
}

/** 选择器里的名称与副标题：有友好名用友好名（副标题是供应商），否则名称沿用模型 id、副标题为空。 */
export function modelLabel(config, id) {
  const entry = config.modelNames?.[id];
  return { name: entry?.name || id, description: entry?.description || "" };
}

export function modelList(config) {
  return {
    data: config.models.map((id) => ({
      id, type: "model", display_name: config.modelNames?.[id]?.name || id, created_at: "2026-01-01T00:00:00Z",
    })),
    has_more: false,
    first_id: config.models[0] ?? null,
    last_id: config.models.at(-1) ?? null,
  };
}

/**
 * 一个模型在界面上显示多长窗口。
 *
 * 逐模型声明最优先；键可能是 `provider/model`，也可能只是裸模型名（老配置和
 * 手写的 `modelWindows` 都是后者），所以两边都认。选中的那个模型还没声明时，
 * 用网关按 binding 解析出的 `defaultWindow` —— 它就是启动 Claude Code 时
 * 写进 `CLAUDE_CODE_MAX_CONTEXT_TOKENS` 的同一个数，界面和 CLI 不该各说各话。
 * 其余没声明的模型仍按 Claude 自己的假定值。
 */
export function modelWindow(config, model) {
  const windows = config.modelWindows ?? {};
  const id = typeof model === "string" ? model : "";
  if (Object.hasOwn(windows, id)) return windows[id];
  const folded = id.toLowerCase();
  const match = (key) => key.toLowerCase() === folded;
  const declared = Object.entries(windows).find(([key]) => match(key));
  if (declared !== undefined) return declared[1];
  const bareName = (value) => (value.includes("/") ? value.slice(value.lastIndexOf("/") + 1) : value);
  const wanted = bareName(id);
  if (wanted !== "") {
    const bare = Object.entries(windows).find(([key]) => bareName(key).toLowerCase() === wanted.toLowerCase());
    if (bare !== undefined) return bare[1];
  }
  if (id !== "" && id === (config.model ?? "")) return config.defaultWindow ?? DEFAULT_MODEL_WINDOW;
  return DEFAULT_MODEL_WINDOW;
}

export function modelSelectors(config, selected = config.model) {
  const model = gatewayModel(config, selected);
  const thinking = { type: "effort", effort: "medium" };
  // Code / Cowork 等页面的模型选择器读的是这里，不是 /v1/models：名称与副标题同样用友好名。
  const models = config.models.map((id) => ({
    id,
    name: modelLabel(config, id).name,
    short_name: modelLabel(config, id).name,
    description: modelLabel(config, id).description,
    section: "main",
    disabled: false, disabled_reason: null,
    hard_limit: modelWindow(config, id),
    context_window: modelWindow(config, id),
    runtime: { max_input_tokens: modelWindow(config, id) },
    capabilities: { compass: false, gsuite_tools: false, mm_images: false, mm_pdf: false, web_search: false },
    thinking: { type: "effort", effort_options: [{ id: "medium", name: "Medium" }] },
  }));
  const surfaces = ["chat", "code", "cc", "ccr", "ccd", "cowork", "design", "office_agent", "claude_science"];
  return {
    model_selector_state: surfaces.map((id) => ({
      id, model, thinking, thinking_by_model: config.models.map((id) => ({ id, thinking })),
      selection_source: "global_default",
    })),
    model_selector_config: surfaces.map((id) => ({
      id, models, description: "",
      settings_vocabulary: { create_mode: { default: 1 }, effort_level: { medium: 2 }, thinking_mode: { off: 3 } },
    })),
  };
}

function validateTurn(turn) {
  return isRecord(turn) &&
    ["humanId", "asstId", "groupId", "blockId"].every((key) => isId(turn[key])) &&
    (turn.humanParent === undefined || isId(turn.humanParent)) &&
    Number.isSafeInteger(turn.humanIndex) && turn.humanIndex >= 0 &&
    Number.isSafeInteger(turn.asstIndex) && turn.asstIndex >= 0 &&
    isText(turn.prompt) && isText(turn.text) &&
    typeof turn.complete === "boolean" &&
    (turn.model === undefined || isText(turn.model, 512)) &&
    (turn.stopReason === null || isText(turn.stopReason, 128)) &&
    isDate(turn.created);
}

function validateConversation(conv) {
  return isRecord(conv) && isId(conv.uuid) && isText(conv.name, 4096) &&
    (conv.model === undefined || isText(conv.model, 512)) &&
    isDate(conv.created_at) && isDate(conv.updated_at) &&
    Number.isSafeInteger(conv.nextIndex) && conv.nextIndex >= 0 &&
    (conv.leafMessageId === null || isId(conv.leafMessageId)) &&
    Array.isArray(conv.turns) && conv.turns.length <= 10000 && conv.turns.every(validateTurn) &&
    Array.isArray(conv.chat_messages) && conv.chat_messages.length <= 20000 &&
    conv.chat_messages.every((message) => isRecord(message) && isId(message.uuid) &&
      ["human", "assistant"].includes(message.sender) && isText(message.text) &&
      Number.isSafeInteger(message.index) && message.index >= 0 && isDate(message.created_at) &&
      (message.parent_message_uuid === null || isId(message.parent_message_uuid)));
}

function validateNotifications(entry) {
  if (!isRecord(entry) || !isId(entry.org) || !isRecord(entry.value)) return false;
  const state = entry.value;
  if (!isRecord(state.preferences) || !isRecord(state.preferences.feature_preference) ||
    !isRecord(state.effective_preferences) || !isRecord(state.push_reachability)) return false;
  const reachability = state.push_reachability;
  if (typeof reachability.has_active_channel !== "boolean" ||
    !Array.isArray(reachability.platforms) || reachability.platforms.length > 64 ||
    !reachability.platforms.every((platform) => isText(platform, 128)) ||
    !(reachability.most_recent_token_refresh === null || isDate(reachability.most_recent_token_refresh))) return false;
  return [state.preferences.feature_preference, state.effective_preferences].every((features) =>
    Object.entries(features).length <= 512 && Object.entries(features).every(([feature, channels]) =>
      isText(feature, 256) && isRecord(channels) && Object.entries(channels).every(([key, value]) =>
        ["enable_push", "enable_email"].includes(key) ? typeof value === "boolean" :
          ["push_source", "email_source"].includes(key) && isText(value, 64))));
}

export function createStateStore(file, conversations, notifications, warn = () => {}) {
  let timer;
  let disabled = false;
  if (file && fs.existsSync(file)) {
    try {
      if (fs.statSync(file).size > MAX_STATE_BYTES) throw new Error("State exceeds size limit");
      const state = JSON.parse(fs.readFileSync(file, "utf8"));
      if (!isRecord(state) || state.version !== 1 || !Array.isArray(state.conversations) ||
        state.conversations.length > 2000 || !state.conversations.every(validateConversation) ||
        !Array.isArray(state.notifications) || state.notifications.length > 2000 ||
        !state.notifications.every(validateNotifications)) throw new Error("Invalid state contract");
      for (const conv of state.conversations) {
        // 中断的请求不自动重发，避免重启后重复计费或执行。
        for (const turn of conv.turns) {
          if (!turn.complete) {
            turn.complete = true;
            turn.stopReason = "interrupted";
          }
          turn.replyStarted = false;
          turn.created = new Date(turn.created);
        }
        conversations.set(conv.uuid, conv);
      }
      for (const entry of state.notifications) notifications.set(entry.org, entry.value);
    } catch {
      disabled = true;
      warn("Local conversation state is invalid; the original file was preserved");
    }
  }
  const flush = () => {
    clearTimeout(timer);
    timer = undefined;
    if (!file || disabled) return;
    let temporary;
    try {
      const body = Buffer.from(JSON.stringify({
        version: 1,
        conversations: [...conversations.values()],
        notifications: [...notifications].map(([org, value]) => ({ org, value })),
      }));
      if (body.length > MAX_STATE_BYTES) throw new Error("State exceeds size limit");
      fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
      temporary = `${file}.${process.pid}.${crypto.randomUUID()}.tmp`;
      fs.writeFileSync(temporary, body, { mode: 0o600 });
      fs.renameSync(temporary, file);
      fs.chmodSync(file, 0o600);
    } catch {
      warn("Local conversation state could not be saved");
    }
  };
  return {
    flush,
    changed() {
      if (!file || disabled || timer) return;
      timer = setTimeout(flush, 250);
      timer.unref();
    },
  };
}
