#!/usr/bin/env node
// 从本机录制的 mock/ 数据生成可提交的“模板”副本（mock-templates/<build>/，每个前端版本一个目录）：
// 保留 GrowthBook/statsig/模型选择器/计划与能力形状，替换所有个人字段为合成常量。
// 用法：node sanitize-mock.mjs [srcDir=mock] [templatesDir=mock-templates]
//   输出到 <templatesDir>/<gated_imports_build_id>/；同一版本重录会整目录替换，其它版本不动。
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const SRC = process.argv[2] ?? path.join(path.dirname(new URL(import.meta.url).pathname), "mock");
const TEMPLATES = process.argv[3] ?? path.join(path.dirname(new URL(import.meta.url).pathname), "mock-templates");
const SOURCE_BUILD = (() => {
  try { return JSON.parse(fs.readFileSync(path.join(SRC, "bootstrap.json"), "utf8")).gated_imports_build_id; } catch { return undefined; }
})();
const OUT = SOURCE_BUILD && /^[\w-]+$/.test(SOURCE_BUILD) ? path.join(TEMPLATES, SOURCE_BUILD) : null;

const ACCOUNT_UUID = "c46bd1eb-fbbf-4e5a-9bb3-5ebe8521eb54";
const ORG_UUID = "e0e877d3-8475-44a1-a501-4fc431b085ab";
const FIXED_TS = "2026-01-01T00:00:00.000000Z";

// 视为个人字段的键名 → 替换值（按名字段优先，再按键名）。
const PERSONAL_KEYS = {
  email_address: "local@claude.local",
  email: "local@claude.local",
  full_name: "Local User",
  display_name: "Local User",
  first_name: "Local",
  last_name: "User",
  phone_number: null,
  phone: null,
  avatar_url: null,
  profile_picture_url: null,
  intercom_account_hash: null,
  // 录制账号的身份验证待办（KYC），带账号专属的 instance；本地模式用不着。
  hold_notice: null,
  intercom_user_jwt: null,
  sessionKey: null,
  token: null,
  invite_token: null,
  stripe_customer_uuid: null,
  stripe_subscription_id: null,
  billing_name: null,
  billing_email: null,
  location: null,
  ip_address: null,
  user_agent: null,
  locale: undefined, // 保留由调用方决定
};

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function scrub(value, keyPath) {
  if (Array.isArray(value)) return value.map((item) => scrub(item, keyPath));
  if (value === null || typeof value !== "object") {
    return value;
  }
  const out = {};
  for (const [key, val] of Object.entries(value)) {
    const sub = `${keyPath}/${key}`;
    if (key === "locale") { out[key] = val; continue; } // locale 由运行时代码决定
    // uuid 映射：只替换用户/组织归属可判定的字段；membership 自身的 uuid 保留
    // 源值（源数据本身就是合成账号的占位 uuid，换掉会破坏 account↔org 解析）。
    if (/organization_uuid$/.test(key) || key === "parent_organization_uuid") {
      if (typeof val === "string" && UUID_RE.test(val)) { out[key] = ORG_UUID; continue; }
    }
    if (key === "user_uuid" || key === "userId") {
      if (typeof val === "string" && UUID_RE.test(val)) { out[key] = ACCOUNT_UUID; continue; }
    }
    if (key === "uuid" && /^\/account$/.test(keyPath)) {
      if (typeof val === "string" && UUID_RE.test(val)) { out[key] = ACCOUNT_UUID; continue; }
    }
    if (key === "checksum") { out[key] = null; continue; }
    if ((key === "created_at" || key === "updated_at" || key === "lastModified" || key === "last_used_at") && typeof val === "string") {
      out[key] = FIXED_TS;
      continue;
    }
    if (key in PERSONAL_KEYS) { out[key] = PERSONAL_KEYS[key]; continue; }
    if (typeof val === "string" && EMAIL_RE.test(val) && !val.endsWith("@claude.local")) { out[key] = "local@claude.local"; continue; }
    out[key] = scrub(val, sub);
  }
  return out;
}

// 录制账号的真实身份：从原始 bootstrap 里取出来，脱敏后在所有文件里再统一换一遍。
// 只按键名替换会漏：GrowthBook 实验记录（hashValue）里有账号/组织 uuid，组织名里带着邮箱。
// uuid、邮箱是唯一的串，出现在哪都换；名字只换整串相等的值（短名字可能正好是普通单词）。
function recordedIdentity(src) {
  let raw;
  try { raw = JSON.parse(fs.readFileSync(path.join(src, "bootstrap.json"), "utf8")); } catch { return null; }
  const account = raw.account ?? {};
  const uuids = new Map();
  const names = new Map();
  const strings = new Map();
  const keep = (value) => typeof value === "string" && value.trim().length > 0;
  if (keep(account.uuid) && account.uuid !== ACCOUNT_UUID) uuids.set(account.uuid, ACCOUNT_UUID);
  for (const value of [account.full_name, account.display_name]) if (keep(value)) names.set(value, "Local User");
  for (const value of [account.email_address]) if (keep(value) && value.includes("@")) strings.set(value, "local@claude.local");
  for (const membership of account.memberships ?? []) {
    const org = membership.organization ?? {};
    if (keep(org.uuid) && org.uuid !== ORG_UUID) uuids.set(org.uuid, ORG_UUID);
    if (keep(org.name)) names.set(org.name, "Local");
    if (keep(org.billing_email)) strings.set(org.billing_email, "local@claude.local");
  }
  return { uuids, names, strings };
}

function redactIdentity(value, identity) {
  if (!identity) return value;
  if (typeof value === "string") {
    if (identity.names.has(value)) return identity.names.get(value);
    let out = value;
    for (const [from, to] of [...identity.uuids, ...identity.strings]) out = out.split(from).join(to);
    return out;
  }
  if (Array.isArray(value)) return value.map((item) => redactIdentity(item, identity));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [redactIdentity(key, identity), redactIdentity(item, identity)]));
  }
  return value;
}

function sanitizeFile(file, rel, identity = null) {
  const data = redactIdentity(JSON.parse(fs.readFileSync(file, "utf8")), identity);
  let out = scrub(data, rel === "bootstrap.json" ? "" : `api/${rel}`);
  if (rel === "bootstrap.json") {
    // 账号/组织字段直接替换为合成常量
    if (out.account) {
      out.account = { ...out.account, uuid: ACCOUNT_UUID, email_address: "local@claude.local", full_name: "Local User", display_name: "Local User" };
    }
    if (out.activeOrganization) {
      out.activeOrganization = { ...out.activeOrganization, uuid: ORG_UUID, id: ORG_UUID, name: "Local" };
    }
  }
  // 主页问候语里嵌着录制账号的称呼（「晚上好，<名字>」）：句子里的名字也换掉。
  // 只在问候语里做子串替换，别处的名字可能正好是普通单词（比如名字叫 Claude）。
  if (rel === "bootstrap.json" && out.personalized_greeting && identity) {
    const names = [...identity.names.keys()].filter((name) => name.length >= 2);
    const swap = (value) => typeof value === "string"
      ? names.reduce((text, name) => text.split(name).join("Local User"), value)
      : Array.isArray(value) ? value.map(swap)
        : value && typeof value === "object" ? Object.fromEntries(Object.entries(value).map(([key, item]) => [key, swap(item)]))
          : value;
    out.personalized_greeting = swap(out.personalized_greeting);
  }
  // 会话列表只保留结构，条目是用户数据 → 清空
  if (rel === "api/conversations.json" && Array.isArray(out.data)) out.data = [];
  return out;
}

function run() {
  const jobs = ["bootstrap.json"];
  const apiDir = path.join(SRC, "api");
  if (fs.existsSync(apiDir)) {
    for (const f of fs.readdirSync(apiDir).filter((f) => f.endsWith(".json"))) jobs.push(`api/${f}`);
  }
  if (!OUT) throw new Error(`${SRC}/bootstrap.json 里没有 gated_imports_build_id，不知道是哪个前端版本`);
  fs.rmSync(OUT, { recursive: true, force: true });
  const identity = recordedIdentity(SRC);
  for (const rel of jobs) {
    const file = path.join(SRC, rel);
    if (!fs.existsSync(file)) continue;
    const sanitized = sanitizeFile(file, rel, identity);
    const dest = path.join(OUT, rel);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, JSON.stringify(sanitized, null, 2));
  }
  console.log(`sanitized ${jobs.length} files -> ${OUT}`);
  exportShell(identity);
}

// 页面外壳必须和模板数据是同一个前端版本（bootstrap.json 的 gated_imports_build_id），
// 否则新用户会配上线上别的版本，界面错乱。从录制目录的 .cache（与 mock/ 同级）里找同版本的外壳。
function exportShell(identity = null) {
  let buildId;
  try {
    buildId = JSON.parse(fs.readFileSync(path.join(OUT, "bootstrap.json"), "utf8")).gated_imports_build_id;
  } catch {}
  const cacheDir = path.join(path.dirname(SRC), ".cache");
  for (const key of ["claude.ai/login", "claude.ai/epitaxy", "claude.ai/new", "claude.ai/"]) {
    const file = path.join(cacheDir, crypto.createHash("sha1").update(key).digest("hex"));
    let body;
    try { body = fs.readFileSync(file); } catch { continue; }
    const found = body.subarray(0, 4096).toString("utf8").match(/<html\b[^>]*\bdata-build-id="([^"]+)"/i)?.[1];
    if (body.length < 4096 || !found || found !== buildId) continue;
    let html = body.toString("utf8");
    for (const [from, to] of [...(identity?.uuids ?? []), ...(identity?.strings ?? [])]) html = html.split(from).join(to);
    fs.writeFileSync(path.join(OUT, "shell.html"), html);
    console.log(`shell ${key} (build ${found}) -> ${path.join(OUT, "shell.html")}`);
    return;
  }
  console.warn(`! 没在 ${cacheDir} 找到 build ${buildId ?? "（未知）"} 的页面外壳：shell.html 缺失，这个版本不能用（build.rs 会报错）`);
}

if (import.meta.url === `file://${process.argv[1]}`) run();
export { scrub, sanitizeFile, recordedIdentity, redactIdentity, ACCOUNT_UUID, ORG_UUID };
