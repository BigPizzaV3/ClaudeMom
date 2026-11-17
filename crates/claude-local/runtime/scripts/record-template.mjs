#!/usr/bin/env node
/**
 * 录一份新的模板原始数据（维护者用自己的 claude.ai 账号录，录完再用 sanitize-mock.mjs 脱敏）。
 *
 * 1. 用单独的临时 profile 开 Chrome，带远程调试端口，在里面登录 claude.ai：
 *      open -na "Google Chrome" --args --user-data-dir=<临时目录> --remote-debugging-port=9447 https://claude.ai/login
 * 2. 登录完成、看到主页后运行：
 *      node scripts/record-template.mjs --cdp http://127.0.0.1:9447 --out <输出目录>
 *    脚本依次打开几个页面，把 claude.ai 与 assets-proxy.anthropic.com 的响应录下来：
 *      <out>/.cache/      页面外壳与前端资源（键与 proxy.mjs 的缓存一致：sha1(host+path+search)）；
 *                         前端资源不随程序打包，用户使用时从 Anthropic 的 CDN 下载，这里只是供 sanitize 找外壳
 *      <out>/mock/        bootstrap.json 与 api/*.json（sanitize-mock.mjs 的输入）
 *      <out>/raw/         其余接口的原样响应，对照用
 * 3. node sanitize-mock.mjs <out>/mock               # 脱敏，写到 mock-templates/<build>/（含 shell.html）
 *    一个版本一个目录，旧版本保留，用户在 ClaudeMom 的设置里选；太旧的版本直接删目录即可。
 *
 * 输出含账号数据和登录态派生的密钥，只放在本机私有目录，不要提交；临时 Chrome profile 用完删掉。
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const args = process.argv.slice(2);
const arg = (name, fallback) => {
  const index = args.indexOf(`--${name}`);
  return index === -1 ? fallback : args[index + 1] ?? fallback;
};
const CDP = arg("cdp", "http://127.0.0.1:9447");
const OUT = path.resolve(arg("out", ""));
if (!arg("out", "")) {
  console.error("用法：node record-template.mjs --cdp http://127.0.0.1:9447 --out <输出目录>");
  process.exit(2);
}
const ROUTES = arg("routes", "/new,/recents,/projects,/artifacts,/settings/general,/new").split(",");
const WAIT_MS = Number(arg("wait", "12000"));
const HOSTS = new Set(["claude.ai", "assets-proxy.anthropic.com"]);

// mock/api/<slug>.json ← 接口路径（与 proxy.mjs 的 apiMap 一一对应）
const API_SLUGS = [
  [/\/reflections\/settings$/, "reflections_settings"],
  [/\/user_settings$/, "claude_code_user_settings"],
  [/\/mcp\/remote_servers_with_connection$/, "mcp_servers"],
  [/\/memory\/settings$/, "memory_settings"],
  [/^\/api\/account_profile$/, "account_profile"],
  [/\/trial_status$/, "trial_status"],
  [/\/skills\/list-skills$/, "skills"],
  [/\/experiences\/claude_web$/, "experiences"],
  [/\/chat_conversations_v2$/, "conversations"],
];

for (const dir of [".cache", "mock/api", "raw"]) fs.mkdirSync(path.join(OUT, dir), { recursive: true, mode: 0o700 });
fs.chmodSync(OUT, 0o700);
const writePrivate = (file, data) => fs.writeFileSync(file, data, { mode: 0o600 });

const targets = await (await fetch(`${CDP}/json/list`)).json();
const page = targets.find((target) => target.type === "page" && /claude\.ai/.test(target.url));
if (!page) {
  console.error("没找到 claude.ai 页面：先在这个 Chrome 里打开并登录 https://claude.ai/");
  process.exit(1);
}

const ws = new WebSocket(page.webSocketDebuggerUrl);
let nextId = 0;
const waiters = new Map();
const pending = new Map();
const queue = [];
ws.onmessage = (event) => {
  const message = JSON.parse(event.data);
  if (message.id && waiters.has(message.id)) {
    waiters.get(message.id)(message);
    waiters.delete(message.id);
    return;
  }
  if (message.method === "Network.responseReceived") {
    const { requestId, response, type } = message.params;
    let url;
    try { url = new URL(response.url); } catch { return; }
    if (HOSTS.has(url.host)) pending.set(requestId, { response, type });
  } else if (message.method === "Network.requestWillBeSent") {
    const entry = pending.get(message.params.requestId);
    if (entry) entry.method = message.params.request.method;
  } else if (message.method === "Network.loadingFinished") {
    const entry = pending.get(message.params.requestId);
    if (entry) {
      pending.delete(message.params.requestId);
      queue.push({ requestId: message.params.requestId, ...entry });
    }
  }
};
await new Promise((resolve) => { ws.onopen = resolve; });
const send = (method, params = {}) => new Promise((resolve) => {
  const id = ++nextId;
  waiters.set(id, resolve);
  ws.send(JSON.stringify({ id, method, params }));
});

let assets = 0;
let apis = 0;
const bootstraps = [];
const apiBodies = new Map();
async function drain() {
  while (queue.length) {
    const { requestId, response } = queue.shift();
    const result = (await send("Network.getResponseBody", { requestId })).result;
    if (!result || result.body == null) continue;
    const body = result.base64Encoded ? Buffer.from(result.body, "base64") : Buffer.from(result.body, "utf8");
    const url = new URL(response.url);
    const key = `${url.host}${url.pathname}${url.search}`;
    // CDP 给的是解压后的正文：去掉 content-encoding、按实际长度写 content-length，回放时才对得上。
    const headers = Object.fromEntries(Object.entries(response.headers).map(([name, value]) => [name.toLowerCase(), value]));
    delete headers["content-encoding"];
    delete headers["transfer-encoding"];
    delete headers["set-cookie"];
    headers["content-length"] = String(body.length);
    const isApi = /^\/(?:api|edge-api)\//.test(url.pathname);
    if (isApi) {
      apis++;
      const name = `${url.pathname.replace(/[0-9a-f]{8}-[0-9a-f-]{27}/gi, "_id_").replace(/[^\w.-]+/g, "_")}.json`;
      writePrivate(path.join(OUT, "raw", name), body);
      if (/\/bootstrap(?:\/[^/]+\/app_start)?$/.test(url.pathname) && response.status === 200) bootstraps.push({ url: url.pathname, body });
      for (const [pattern, slug] of API_SLUGS) if (pattern.test(url.pathname) && response.status === 200) apiBodies.set(slug, body);
      continue;
    }
    const file = path.join(OUT, ".cache", crypto.createHash("sha1").update(key).digest("hex"));
    writePrivate(file, body);
    writePrivate(`${file}.json`, JSON.stringify({ status: response.status, headers, url: key }));
    assets++;
  }
}

await send("Network.enable", { maxTotalBufferSize: 512 * 1024 * 1024, maxResourceBufferSize: 64 * 1024 * 1024 });
await send("Network.setCacheDisabled", { cacheDisabled: true });
await send("Page.enable");
for (const route of ROUTES) {
  console.log(`打开 ${route} …`);
  await send("Page.navigate", { url: `https://claude.ai${route}` });
  const deadline = Date.now() + WAIT_MS;
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 400));
    await drain();
  }
}
await drain();
ws.close();

// 启动数据：优先带组织的 app_start（内容最全），其次 /edge-api/bootstrap。
const chosen = bootstraps.find((item) => /app_start$/.test(item.url)) ?? bootstraps.at(-1);
if (!chosen) {
  console.error("没录到启动数据（/edge-api/bootstrap）。确认已登录、主页能正常打开后重试。");
  process.exit(1);
}
writePrivate(path.join(OUT, "mock", "bootstrap.json"), chosen.body);
for (const [slug, body] of apiBodies) writePrivate(path.join(OUT, "mock", "api", `${slug}.json`), body);
const build = JSON.parse(chosen.body.toString("utf8")).gated_imports_build_id;
console.log(`\n完成：前端资源 ${assets} 个，接口 ${apis} 个；启动数据取自 ${chosen.url}（build ${build}）`);
console.log(`接口模板：${[...apiBodies.keys()].sort().join(", ") || "无"}`);
const missing = API_SLUGS.map(([, slug]) => slug).filter((slug) => !apiBodies.has(slug));
if (missing.length) console.log(`没录到：${missing.join(", ")}（沿用旧模板里的同名文件即可）`);
