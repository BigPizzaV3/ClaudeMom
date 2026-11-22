// Artifacts：本地 typed-artifact 存储、frame 页面/运行时、以及给模型的 artifact 工具。
//
// 官方 Claude Desktop 的 artifact 能力分三层：
//   1. 存储：<Claude>/typed-artifacts/<账号8位>/<组织8位>/<uuid>/{desktop.json,artifact.json,blobs/*}
//   2. 页面：/code/artifact/<uuid>（frame-shell.html）+ <uuid>.claudeusercontent.com/_f/<ver>/*
//   3. 工具：/api/artifacts/mcp 上的 claude-artifacts MCP（create_from_type / publish_version …）
//
// ClaudeMom 直接把这三层做成本地实现：读写同一个存储目录，这样官方 Artifacts 页、
// Code/Cowork 的 frame 查看器和聊天里的 artifact 卡片看到的都是同一批作品。
//
// frame 运行时（_runtime/*.js、templates/*.json）来自本机录制，放在
// <ClaudeMom 状态目录>/frame-runtime/；仓库不分发官方资源。

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

/** 官方内置类型。slug 是类型 UUID，前端用 slug 建实例，不要写成 "design"。 */
const TYPES = {
  design: {
    slug: "bcd2878f-a88d-4094-a616-8e39d8a5fd8a",
    title: "Design",
    icon: "Palette",
    tint: "violet",
    icon_key: "palette",
    favicon: "\u{1F3A8}",
    description: "Design canvas for websites, landing pages, screens, UI mockups, wireframes, posters, visual social posts, visuals, ads, invites and digital media: live artboards laid out on a canvas.",
  },
  slides: {
    slug: "3e9dc3d6-8a10-4143-ac0b-5af4f2b03a61",
    title: "Slides",
    icon: "Slides",
    tint: "yellow",
    icon_key: "slides",
    favicon: "\u{1F4FD}\u{FE0F}",
    description: "Presentation decks: 16:9 or 4:3 slides to present, page through and download.",
  },
  docs: {
    slug: "c8f0b311-af6a-4d22-a07b-61eb818fc35d",
    title: "Docs",
    icon: "File",
    tint: "blue",
    icon_key: "file",
    favicon: "\u{1F4C4}",
    description: "Editable docs — documents, reports, plans, memos, briefs that people and Claude read and edit together.",
  },
};

const TYPE_BY_SLUG = new Map(Object.entries(TYPES).map(([name, type]) => [type.slug, { name, ...type }]));
const DEFAULT_TYPE = "design";

function typeOf(name) {
  return TYPES[name] ? { name, ...TYPES[name] } : { name: DEFAULT_TYPE, ...TYPES[DEFAULT_TYPE] };
}

function typeBySlug(slug, fallback = DEFAULT_TYPE) {
  const key = String(slug || "").trim().toLowerCase();
  if (TYPES[key]) return key;
  const hit = TYPE_BY_SLUG.get(key);
  return hit ? hit.name : fallback;
}

/** 短 id：官方 URL 里 22 位十六进制（uuid 去掉连字符的前 22 位）。 */
export function frameShortId(uuid) {
  return String(uuid).replace(/-/g, "").slice(0, 22);
}

/** 由短 id 找回完整 uuid（前缀匹配，忽略连字符）。 */
function resolveId(names, value) {
  const raw = String(value || "");
  if (names.includes(raw)) return raw;
  const needle = raw.replace(/-/g, "").toLowerCase();
  if (needle.length < 8) return raw;
  return names.find((name) => name.replace(/-/g, "").toLowerCase().startsWith(needle)) || raw;
}

function readJson(file, fallback = null) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return fallback;
  }
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value));
}

function sha256(buffer) {
  return crypto.createHash("sha256").update(buffer).digest("hex");
}

function blankBoardHtml() {
  return '<!doctype html>\n<html>\n<head><meta charset="utf-8"></head>\n<body>\n<x-dc>\n  <helmet><style>html, body { margin: 0; height: 100%; } body { background: #ffffff; }</style></helmet>\n  <section class="stage" style="width:100%;height:100vh"></section>\n</x-dc>\n</body>\n</html>\n';
}

function blankCanvas(title) {
  const board = "Artboard-1.dc.html";
  return {
    v: 3,
    attachments: {},
    boards: { [board]: { h: 600, title: "Artboard 1", w: 800, x: 0, y: 0 } },
    createdOnFiles: { at: new Date().toISOString(), v: 1 },
    designSystems: [],
    launch: {},
    notes: {},
    order: [board],
    pages: [],
    title: title || "Design",
  };
}

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".md": "text/markdown; charset=utf-8",
  ".woff2": "font/woff2",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
};

function mimeOf(file) {
  return MIME[path.extname(file).toLowerCase()] || "application/octet-stream";
}

/**
 * @param {object} options
 * @param {string} options.artifactRoot  typed-artifacts 根（通常 <APPDATA>/Claude/typed-artifacts/<acct8>/<org8>）
 * @param {string} options.frameRoot     录制下来的 frame 运行时根（<state>/frame-runtime）
 * @param {string} options.origin        对外 origin（测试里是 https://claude.ai）
 * @param {object} [options.officialAssets] 只读的 ion-dist.asar（取 frame-shell.html）
 * @param {{uuid?:string, name?:string, email?:string}} [options.localAccount] 本地身份（perm/user-resolve 用）
 * @param {(line: string) => void} [options.log]
 */
export function createArtifactService({ artifactRoot, frameRoot, origin = "https://claude.ai", officialAssets = null, localAccount = null, log = () => {} }) {
  const LOCAL_ACCOUNT = {
    uuid: String(localAccount?.uuid || "00000000-0000-0000-0000-000000000000"),
    name: String(localAccount?.name || "You"),
    email: String(localAccount?.email || "you@local"),
  };
  // ── 存储 ───────────────────────────────────────────────────
  function storeRoot() {
    return artifactRoot;
  }

  function names() {
    try {
      return fs.readdirSync(artifactRoot);
    } catch {
      return [];
    }
  }

  function dirOf(id) {
    return path.join(artifactRoot, id);
  }

  function metaOf(id) {
    return readJson(path.join(dirOf(id), "desktop.json"), {});
  }

  function versionsOf(pathOrId) {
    const doc = readJson(path.isAbsolute(pathOrId) ? pathOrId : path.join(dirOf(pathOrId), "artifact.json"), {});
    return { doc, versions: Array.isArray(doc.versions) ? doc.versions : [] };
  }

  function blobPath(id, hash) {
    return path.join(dirOf(id), "blobs", hash);
  }

  function readBlob(id, entry) {
    try {
      return fs.readFileSync(blobPath(id, entry[1]));
    } catch {
      return null;
    }
  }

  /** 一个作品的最新版本 */
  function latestOf(id) {
    const { doc, versions } = versionsOf(id);
    return { doc, versions, latest: versions[versions.length - 1] || null, first: versions[0] || null };
  }

  /** 官方 GET /api/frame/artifacts 的行形状（zw 校验：id/title 必须 string；
   *  rel/kind/type_slug 等是画廊网格、卡片菜单、favorited lane 的判定字段）。
   *  starred/last_viewed_at 持久化在 desktop.json，跨重启保留。 */
  function rowOf(id) {
    try {
      const meta = metaOf(id);
      const { versions, latest, first } = latestOf(id);
      const type = typeOf(meta.type);
      const createdAt = first?.createdAt || null;
      const updatedAt = latest?.createdAt || createdAt;
      const title = meta.title || type.title;
      const slugSource = String(meta.slug || title || id).toLowerCase();
      const slug = slugSource.replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || id;
      const hasFiles = Array.isArray(latest?.files) && latest.files.length > 0;
      return {
        id,
        uuid: id,
        slug,
        // 官方行字段（前端 Fw/Uw 映射与画廊消费）
        kind: "page",
        rel: "mine",
        owner_account: null,
        role: null,
        label: null,
        description: type.description,
        icon: type.icon,
        tint: type.tint,
        type_slug: type.slug,
        type_title: type.title,
        typeSlug: type.slug,
        created_at: createdAt,
        updated_at: updatedAt,
        createdAt,
        updatedAt,
        thumbnail_url: null,
        thumbnail_dark_url: null,
        thumbnail_dark_urls: false,
        source: "chat",
        audience: "owner",
        starred: meta.starred === true,
        soft_deleted: false,
        empty: !hasFiles,
        renamable: true,
        removable: true,
        duplicable: true,
        duplicate_available: true,
        duplicate_notice: null,
        duplicate_disabled_reason: null,
        duplicate_disabled_type_title: null,
        view_count: 0,
        public_view_count: 0,
        last_edit: null,
        artifact_labels: [],
        artifact_label_defs: [],
        outside_organization: false,
        // 本地扩展（面板脚本/旧 UI 用）
        title,
        favicon: type.favicon,
        icon_key: type.icon_key,
        open_url: `${origin}/code/artifact/${id}`,
        short_id: frameShortId(id),
        audience_: undefined,
        last_viewed_at: meta.last_viewed_at || updatedAt,
        sort_time: meta.last_viewed_at || updatedAt,
        versionCount: versions.length,
        hasFiles,
        can: ["move"],
      };
    } catch {
      return null;
    }
  }

  function listArtifacts() {
    const rows = names().map(rowOf).filter(Boolean);
    rows.sort((a, b) => String(b.sort_time || "").localeCompare(String(a.sort_time || "")));
    return rows;
  }

  /** desktop.json 局部更新（starred / last_viewed_at 等）。 */
  function patchMeta(id, patch) {
    const dir = dirOf(id);
    if (!fs.existsSync(dir)) return null;
    const meta = { ...metaOf(id), ...patch };
    writeJson(path.join(dir, "desktop.json"), meta);
    return meta;
  }

  function setStarred(id, starred) {
    return patchMeta(id, { starred: starred === true }) !== null;
  }

  function touchViewed(id) {
    patchMeta(id, { last_viewed_at: new Date().toISOString() });
  }

  /** 复制作品目录为新 uuid（duplicate）。 */
  function duplicateArtifact(id) {
    const src = dirOf(id);
    if (!fs.existsSync(src)) return null;
    const newId = crypto.randomUUID();
    const dest = dirOf(newId);
    fs.cpSync(src, dest, { recursive: true });
    const meta = metaOf(newId);
    const type = typeOf(meta.type);
    meta.title = `${meta.title || type.title} (copy)`;
    meta.createdTitle = meta.title;
    meta.duplicatedFrom = id;
    writeJson(path.join(dest, "desktop.json"), meta);
    log(`artifact duplicated ${id} -> ${newId}`);
    return { id: newId, url: `${origin}/code/artifact/${newId}` };
  }

  /** 新建一个空作品，返回 uuid。 */
  function createArtifact(typeSlug, title = "") {
    const type = typeBySlug(typeSlug);
    const id = crypto.randomUUID();
    const dir = dirOf(id);
    fs.mkdirSync(dir, { recursive: true });
    writeJson(path.join(dir, "desktop.json"), {
      format: 1,
      type,
      title: String(title || typeOf(type).title),
      createdTitle: String(title || typeOf(type).title),
      createdBySessionId: "",
    });
    writeJson(path.join(dir, "artifact.json"), {
      format: 1,
      versions: [{ ver: "v1", createdAt: new Date().toISOString(), entry: "publish", files: [] }],
    });
    log(`artifact created ${id} type=${type}`);
    return { id, url: `${origin}/code/artifact/${id}` };
  }

  /** 追加一个版本；files: [{path, content, content_type, encoding}] */
  function publishVersion(id, files = [], { title, remove = [] } = {}) {
    const dir = dirOf(id);
    if (!fs.existsSync(dir)) throw new Error(`artifact not found: ${id}`);
    const meta = metaOf(id);
    if (title) {
      meta.title = String(title);
      writeJson(path.join(dir, "desktop.json"), meta);
    }
    fs.mkdirSync(path.join(dir, "blobs"), { recursive: true });
    const entries = [];
    for (const file of files) {
      const filePath = String(file.path || file.name || "").replace(/^\/+/, "");
      if (!filePath || filePath.split("/").some((part) => part === "..")) continue;
      const raw = String(file.content ?? file.text ?? "");
      const buffer = file.encoding === "base64" ? Buffer.from(raw, "base64") : Buffer.from(raw, "utf8");
      const hash = sha256(buffer);
      fs.writeFileSync(blobPath(id, hash), buffer);
      entries.push([filePath, hash, file.content_type || file.contentType || mimeOf(filePath)]);
    }
    const { doc, versions } = versionsOf(id);
    const removed = new Set(remove.map(String));
    const previousFiles = (versions[versions.length - 1]?.files || []).filter((entry) => !removed.has(String(entry[0])));
    const merged = new Map(previousFiles.map((entry) => [entry[0], entry]));
    for (const entry of entries) merged.set(entry[0], entry);
    const ver = `v${versions.length + 1}`;
    versions.push({ ver, createdAt: new Date().toISOString(), entry: "publish", files: [...merged.values()] });
    doc.versions = versions;
    writeJson(path.join(dir, "artifact.json"), doc);
    log(`artifact publish ${id} ${ver} files=${entries.length}`);
    return { id, ver, url: `${origin}/code/artifact/${id}`, files: entries.length };
  }

  function deleteArtifact(id) {
    const dir = dirOf(id);
    if (!fs.existsSync(dir)) return false;
    fs.rmSync(dir, { recursive: true, force: true });
    return true;
  }

  function readFileOf(id, filePath) {
    const { latest } = latestOf(id);
    const entry = (latest?.files || []).find((item) => item[0] === filePath);
    return entry ? readBlob(id, entry) : null;
  }

  // ── 文档 / 模板 ─────────────────────────────────────────────
  function templateFor(typeName) {
    const file = path.join(frameRoot, "templates", `${typeName}.json`);
    return readJson(file, null);
  }

  function runtimeVersion(typeName) {
    const doc = templateFor(typeName);
    return doc?.ver || null;
  }

  function frameManifest(ver, id) {
    const file = path.join(frameRoot, "runtime", ver, "_files.json");
    const manifest = readJson(file, null);
    if (!manifest || typeof manifest !== "object") return null;
    if (!manifest.files || typeof manifest.files !== "object") manifest.files = {};
    for (const key of Object.keys(manifest.files)) {
      if (key.startsWith("project/")) delete manifest.files[key];
    }
    const meta = metaOf(id);
    const { latest } = latestOf(id);
    const project = ((latest?.files) || []).filter((entry) => String(entry[0]).startsWith("project/"));
    for (const entry of project) {
      const buffer = readBlob(id, entry);
      const size = buffer ? buffer.length : 0;
      manifest.files[entry[0]] = {
        sha256: buffer ? sha256(buffer) : "",
        size,
        contentType: entry[2] || mimeOf(entry[0]),
      };
    }
    // 空白 design：官方新建时由类型应用生成画布，这里给一份最小画布，查看器才不是空白。
    if (!project.length && (!meta.type || meta.type === "design")) {
      for (const [name, buffer] of [
        ["project/canvas.json", Buffer.from(JSON.stringify(blankCanvas(meta.title)), "utf8")],
        ["project/Artboard-1.dc.html", Buffer.from(blankBoardHtml(), "utf8")],
      ]) {
        manifest.files[name] = {
          sha256: sha256(buffer),
          size: buffer.length,
          contentType: name.endsWith(".json") ? "application/json" : "text/html",
        };
      }
    }
    return manifest;
  }

  /** 作品文档：模板 + 覆盖标题/类型/文件列表，查看器据此装配 frame。 */
  function frameDocument(id) {
    const meta = metaOf(id);
    const typeName = meta.type === "slides" ? "slides" : meta.type === "docs" ? "docs" : "design";
    const type = typeOf(typeName);
    const doc = templateFor(typeName) || { files: [] };
    const { versions, latest, first } = latestOf(id);
    const projectFiles = ((latest?.files) || []).map((entry) => {
      const buffer = readBlob(id, entry);
      return {
        path: entry[0],
        size: buffer ? buffer.length : 0,
        contentType: entry[2] || mimeOf(entry[0]),
        sha256: buffer ? sha256(buffer) : "",
      };
    });
    doc.title = meta.title || type.title;
    doc.favicon = type.favicon;
    doc.icon = type.icon;
    doc.tint = type.tint;
    doc.typeTitle = type.title;
    doc.typeSlug = type.slug;
    doc.type = { ...(doc.type || {}), slug: type.slug };
    doc.viewerPath = `/artifact/${frameShortId(id)}`;
    doc.id = id;
    doc.files = (doc.files || []).filter((file) => !String(file.path).startsWith("project/")).concat(projectFiles);
    doc.created_at = first?.createdAt || doc.created_at;
    doc.updated_at = latest?.createdAt || doc.updated_at;
    return doc;
  }

  // ── HTTP 小工具 ─────────────────────────────────────────────
  function send(res, status, type, body, extra = {}) {
    const buffer = Buffer.isBuffer(body) ? body : Buffer.from(String(body), "utf8");
    res.writeHead(status, {
      "content-type": type,
      "content-length": buffer.length,
      "cache-control": "no-store",
      ...extra,
    });
    res.end(buffer);
  }

  function json(res, value, status = 200) {
    send(res, status, "application/json; charset=utf-8", JSON.stringify(value));
  }

  function sendFile(res, file) {
    try {
      const body = fs.readFileSync(file);
      send(res, 200, mimeOf(file), body);
      return true;
    } catch {
      return false;
    }
  }

  function corsJson(req, res, value, status = 200) {
    json(res, value, status);
  }

  // ── /api/frame/*：列表、类型、文档、新建、管理面 ─────────────
  /** gallery rel 枚举（官方 QC() 参数）。 */
  const RELS = new Set(["all", "favorited", "mine", "shared", "template"]);

  function meRow(row) {
    // 本人最小行，供 perm/participants/user-resolve 用
    return { uuid: LOCAL_ACCOUNT.uuid, name: LOCAL_ACCOUNT.name, email_address: LOCAL_ACCOUNT.email };
  }

  function metaAccount() {
    // 作品没有独立 owner 概念，本地全部归本人
    return { uuid: LOCAL_ACCOUNT.uuid, ...LOCAL_ACCOUNT };
  }

  /** 返回 true 表示已处理。p 是不带查询串的路径。 */
  function handleFrameApi(method, url, req, res) {
    const p = url.pathname.replace(/\/+$/, "") || "/";
    if (!p.startsWith("/api/frame/")) return false;
    const q = url.searchParams;

    if (method === "GET" && p === "/api/frame/types") {
      json(res, {
        types: Object.entries(TYPES).map(([name, type]) => ({
          slug: type.slug,
          title: type.title,
          favicon: type.favicon,
          icon: type.icon,
          tint: type.tint,
          icon_key: type.icon_key,
          description: type.description,
          show_in_create_menus: true,
          name,
        })),
      });
      return true;
    }
    if (method === "GET" && /^\/api\/frame\/types\/[^/]+\/instances$/.test(p)) {
      const slug = p.split("/")[4];
      const typeName = typeBySlug(slug, null);
      const instances = typeName ? listArtifacts().filter((row) => row.type_slug === slug) : [];
      json(res, { instances, default: null, defaults: null });
      return true;
    }
    if (method === "POST" && /^\/api\/frame\/types\/[^/]+\/create$/.test(p)) {
      const slug = p.split("/")[4];
      readBody(req).then((raw) => {
        let title = "";
        try {
          const parsed = JSON.parse(raw);
          if (parsed && typeof parsed.title === "string") title = parsed.title;
        } catch {}
        const { id } = createArtifact(slug, title);
        json(res, { slug: id, id, url: `${origin}/code/artifact/${id}` });
      });
      return true;
    }
    // 类型默认作品 / pin（P1：内存确认即可，前端只看 2xx）
    if (/^\/api\/frame\/types\/[^/]+\/default\/org$/.test(p)) {
      json(res, { ok: true });
      return true;
    }
    if (/^\/api\/frame\/types\/[^/]+\/pins\/[^/]+$/.test(p)) {
      if (method === "DELETE") json(res, { default_cleared: false });
      else json(res, { ok: true });
      return true;
    }
    if (method === "GET" && p === "/api/frame/folders") {
      const rel = q.get("rel");
      if (rel === "favorited") return json(res, { folders: [] }), true;
      json(res, {
        folders: [],
        limits: { depth: 8, folders: 1000, children: 1000 },
        sharing: rel === "shared" ? undefined : { roles: [], paused: false, general: false, editors_can_share: true, editors_can_organize: true },
        access_update_sent: true,
      });
      return true;
    }
    // ── 画廊列表（zw 校验：artifacts 必须是数组且行有 string id/title）──
    if (method === "GET" && p === "/api/frame/artifacts") {
      const rel = RELS.has(q.get("rel")) ? q.get("rel") : "mine";
      const search = (q.get("q") || "").toLowerCase();
      const type = q.get("type");
      const excludeEmpty = q.get("empty") === "exclude";
      const softDeleted = q.get("soft_deleted");
      let rows = listArtifacts();
      if (rel === "favorited") rows = rows.filter((row) => row.starred);
      else if (rel !== "all") rows = rows.filter((row) => row.rel === rel);
      if (type) {
        const wanted = new Set(type.split(",").map((s) => s.trim().toLowerCase()).filter(Boolean));
        rows = rows.filter((row) => wanted.has(String(row.type_slug).toLowerCase()));
      }
      if (search) rows = rows.filter((row) => String(row.title || "").toLowerCase().includes(search));
      if (excludeEmpty) rows = rows.filter((row) => !row.empty);
      if (softDeleted === "false") rows = rows.filter((row) => !row.soft_deleted);
      // 官方 Vw()：最后一页不带 next_page_token 才算完整，本地一页给全
      json(res, { artifacts: rows, withheld: { kinds: [] } });
      return true;
    }
    // ── 最近查看 lane / 画廊网格快路径（probe 也走这里，要求 200 + frames 数组）──
    if (method === "GET" && p === "/api/frame/frames") {
      const rel = q.get("rel");
      const limit = Number(q.get("limit")) || 60;
      const search = (q.get("q") || "").toLowerCase();
      const type = q.get("type");
      let rows = listArtifacts();
      if (rel === "shared") rows = rows.filter((row) => row.rel === "shared");
      if (type) {
        const wanted = new Set(type.split(",").map((s) => s.trim().toLowerCase()).filter(Boolean));
        rows = rows.filter((row) => wanted.has(String(row.type_slug).toLowerCase()));
      }
      if (search) rows = rows.filter((row) => String(row.title || "").toLowerCase().includes(search));
      rows = rows.slice(0, limit).map((row) => ({ ...row, slug: row.id, thumb: q.get("thumb") === "1" ? undefined : undefined }));
      json(res, { frames: rows });
      return true;
    }
    // 侧边栏 recents：bn() 只读 id/title/icon/tint/type_slug/type_title/created_at
    if (method === "GET" && p === "/api/frame/frames/external") {
      const rows = listArtifacts().slice(0, 40).map((row) => ({
        id: row.id,
        title: row.title,
        icon: row.icon,
        tint: row.tint,
        type_slug: row.type_slug,
        type_title: row.type_title,
        created_at: row.created_at,
        updated_at: row.updated_at,
        rel: row.rel,
      }));
      json(res, { frames: rows });
      return true;
    }
    // ── 管理面：retitle / duplicate / favorite ──
    const retitle = p.match(/^\/api\/frame\/retitle\/([0-9A-Za-z_-]{8,64})$/);
    if (method === "POST" && retitle) {
      const id = resolveId(names(), retitle[1]);
      if (!fs.existsSync(dirOf(id))) return json(res, { error: { type: "not_found_error" } }, 404), true;
      readBody(req).then((raw) => {
        let title = null;
        try { title = JSON.parse(raw)?.title; } catch {}
        if (typeof title === "string" && title) patchMeta(id, { title });
        json(res, frameDocument(id));
      });
      return true;
    }
    const favorite = p.match(/^\/api\/frame\/favorite\/([0-9A-Za-z_-]{8,64})$/);
    if (favorite && (method === "POST" || method === "DELETE")) {
      const id = resolveId(names(), favorite[1]);
      if (!fs.existsSync(dirOf(id))) return json(res, { error: { type: "not_found_error" } }, 404), true;
      setStarred(id, method === "POST");
      // 官方 ru() 检查 status===204
      res.writeHead(204, { "cache-control": "no-store" });
      res.end();
      return true;
    }
    const duplicate = p.match(/^\/api\/frame\/duplicate\/([0-9A-Za-z_-]{8,64})$/);
    if (method === "POST" && duplicate) {
      const id = resolveId(names(), duplicate[1]);
      const created = duplicateArtifact(id);
      if (!created) return json(res, { error: { type: "not_found_error" } }, 404), true;
      json(res, frameDocument(created.id));
      return true;
    }
    // ── 管理面最小应答（分享/评论/用量/访问）──
    const frameId = p.match(/^\/api\/frame\/([0-9A-Za-z_-]{8,64})$/);
    if (frameId) {
      const id = resolveId(names(), frameId[1]);
      const exists = fs.existsSync(dirOf(id));
      if (method === "DELETE") {
        if (!exists) return json(res, { error: { type: "not_found_error" } }, 404), true;
        json(res, { ok: deleteArtifact(id) });
        return true;
      }
      if (method === "GET") {
        if (!exists) return json(res, { error: { type: "not_found_error" } }, 404), true;
        json(res, frameDocument(id));
        return true;
      }
    }
    if (/^\/api\/frame\/perm\/[^/]+\/suggestions$/.test(p)) {
      json(res, { people: [] });
      return true;
    }
    if (/^\/api\/frame\/perm\/[^/]+\/people$/.test(p) && method === "POST") {
      json(res, { ok: true });
      return true;
    }
    if (/^\/api\/frame\/perm\/[^/]+\/compartment$/.test(p) || /^\/api\/frame\/share-key\/[^/]+\/rotate$/.test(p)) {
      json(res, { share_key: crypto.randomUUID() });
      return true;
    }
    if (/^\/api\/frame\/perm\/[^/]+$/.test(p)) {
      if (method === "GET") {
        json(res, {
          owner: metaAccount(),
          access: "write",
          shared: false,
          general_access: "restricted",
          people: [],
          version: crypto.randomUUID(),
        });
      } else {
        json(res, { ok: true, version: crypto.randomUUID() });
      }
      return true;
    }
    if (/^\/api\/frame\/comments\/[^/]+$/.test(p) && method === "GET") {
      json(res, { comments: [] });
      return true;
    }
    if (/^\/api\/frame\/comments\/[^/]+\/(to-claude|reads|people)$/.test(p)) {
      json(res, method === "GET" ? { people: [] } : { ok: true });
      return true;
    }
    if (/^\/api\/frame\/activity\/[^/]+$/.test(p) && method === "GET") {
      json(res, { views: 0, viewers: [], publicViews: 0, weekly: [], since: null, counted: false });
      return true;
    }
    if (/^\/api\/frame\/activity\/[^/]+\/viewers$/.test(p)) {
      json(res, { viewers: [] });
      return true;
    }
    if (/^\/api\/frame\/participants\/[^/]+$/.test(p)) {
      json(res, { people: [] });
      return true;
    }
    if (/^\/api\/frame\/access-requests\/[^/]+$/.test(p)) {
      json(res, { pending: [], guest_pending: [], guest_pending_incomplete: false });
      return true;
    }
    if (/^\/api\/frame\/access\/[^/]+$/.test(p)) {
      json(res, {});
      return true;
    }
    if (/^\/api\/frame\/agent-space/.test(p) || /^\/api\/frame\/quiet-harbor\//.test(p) || /^\/api\/frame\/claim\//.test(p)) {
      if (p.includes("agent-space-resolve")) return json(res, { version: "" }), true;
      if (p.includes("quiet-harbor")) return json(res, { f02: "" }), true;
      json(res, { ok: true });
      return true;
    }
    if (/^\/api\/frame\/user\/resolve\//.test(p) && method === "POST") {
      json(res, { ok: true, accounts: {}, grants: {}, names: {}, viewer: LOCAL_ACCOUNT.uuid, guests: [] });
      return true;
    }
    if (/^\/api\/frame\/user\/mint\//.test(p) && method === "POST") {
      json(res, { ok: true, status: 200, ids: {}, grants: {} });
      return true;
    }
    // iframe broker 面：track 遥测、lookup/search（作品读其他作品）、consent
    if (p === "/api/frame/track" && method === "POST") {
      json(res, {});
      return true;
    }
    const lookup = p.match(/^\/api\/frame\/artifact\/(lookup|search)\/([0-9A-Za-z_-]{8,64})$/);
    if (lookup && method === "POST") {
      readBody(req).then((raw) => {
        let body = {};
        try { body = JSON.parse(raw) || {}; } catch {}
        let rows = listArtifacts();
        if (lookup[1] === "lookup" && Array.isArray(body.ids)) {
          const wanted = new Set(body.ids.map((v) => String(v).toLowerCase()));
          rows = rows.filter((row) => wanted.has(String(row.id).toLowerCase()));
        } else if (lookup[1] === "search") {
          const needle = String(body.q || "").toLowerCase();
          if (needle) rows = rows.filter((row) => String(row.title || "").toLowerCase().includes(needle));
          if (body.type) rows = rows.filter((row) => String(row.type_slug).toLowerCase() === String(body.type).toLowerCase());
        }
        json(res, { hits: rows.slice(0, 50).map((row) => ({ id: row.id, title: row.title, type: row.type_slug })), cursor: null });
      });
      return true;
    }
    if (/^\/api\/frame\/consent\//.test(p) && method === "POST") {
      json(res, { ops: [{ kind: "comments", decision: "granted", seq: 1 }] });
      return true;
    }
    // 作品保存自身状态（iframe broker 的唯一写回通道）
    const self = p.match(/^\/api\/frame\/self\/([0-9A-Za-z_-]{8,64})$/);
    if (self && method === "POST") {
      const id = resolveId(names(), self[1]);
      if (!fs.existsSync(dirOf(id))) return json(res, { error: { type: "not_found_error" } }, 404), true;
      readBody(req).then((raw) => {
        try {
          const parsed = JSON.parse(raw.toString("utf8"));
          if (parsed && typeof parsed === "object") {
            delete parsed.baseVersion;
            delete parsed.token;
            writeJson(path.join(dirOf(id), "state.json"), parsed);
          }
          json(res, { ok: true });
        } catch {
          json(res, { error: { type: "invalid_request_error" } }, 400);
        }
      });
      return true;
    }
    return false;
  }

  function readBody(req) {
    return new Promise((resolve) => {
      const chunks = [];
      req.on("data", (chunk) => chunks.push(chunk));
      req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    });
  }

  // ── <uuid>.claudeusercontent.com / frame 运行时 ─────────────
  /** artifact 内容子域 + 运行时资源。hostName 形如 <uuid>.claudeusercontent.com 或 frame.claudeusercontent.com。 */
  function handleFrameHost(req, res, url, hostName) {
    const p = url.pathname;
    if (p === "/_warmup") return json(res, {}), true;
    if (p === "/_t") {
      if (url.searchParams.get("__frame_renew") === "1") {
        res.writeHead(204, { "cache-control": "no-store" });
        res.end();
        return true;
      }
      const ver = url.searchParams.get("v") || runtimeVersion(DEFAULT_TYPE) || "v1";
      res.writeHead(302, { location: `/_f/${encodeURIComponent(ver)}/`, "cache-control": "no-store", "referrer-policy": "no-referrer" });
      res.end();
      return true;
    }
    const id = resolveId(names(), String(hostName).split(".")[0]);

    if (p.startsWith("/_runtime/") || p.startsWith("/_cas/")) {
      if (sendFile(res, path.join(frameRoot, "shared", p.slice(1)))) return true;
      return json(res, { error: "not_found" }, 404), true;
    }

    const match = /^\/_f\/([^/]+)\/?(.*)$/.exec(p);
    if (match) {
      const ver = match[1];
      const rest = match[2] || "index.html";
      if (p === `/_f/${ver}/_files.json` || rest === "_files.json") {
        const meta = metaOf(id);
        const typeName = meta.type === "slides" ? "slides" : meta.type === "docs" ? "docs" : "design";
        const effective = runtimeVersion(typeName) || ver;
        const manifest = frameManifest(effective, id);
        if (manifest) return json(res, manifest), true;
        if (sendFile(res, path.join(frameRoot, "runtime", effective, "_files.json"))) return true;
        return json(res, { files: [] }), true;
      }
      if (rest.startsWith("project/")) {
        const meta = metaOf(id);
        const typeName = meta.type === "slides" ? "slides" : meta.type === "docs" ? "docs" : "design";
        const buffer = readFileOf(id, rest);
        if (buffer) return send(res, 200, mimeOf(rest), buffer), true;
        const { latest } = latestOf(id);
        const hasProject = ((latest?.files) || []).some((entry) => String(entry[0]).startsWith("project/"));
        if (!hasProject && typeName === "design") {
          if (rest === "project/canvas.json") {
            return send(res, 200, "application/json; charset=utf-8", JSON.stringify(blankCanvas(meta.title))), true;
          }
          if (rest === "project/Artboard-1.dc.html") {
            return send(res, 200, "text/html; charset=utf-8", blankBoardHtml()), true;
          }
        }
        return json(res, { error: "not_found" }, 404), true;
      }
      const meta = metaOf(id);
      const typeName = meta.type === "slides" ? "slides" : meta.type === "docs" ? "docs" : "design";
      const effective = runtimeVersion(typeName) || ver;
      if (sendFile(res, path.join(frameRoot, "runtime", effective, rest))) return true;
      return json(res, { error: "not_found" }, 404), true;
    }
    return json(res, { error: "not_found" }, 404), true;
  }

  // ── 查看器外壳：/code/artifact/<uuid> / /artifact/<short> ───
  /** 官方 serveShellPage 的最小等价实现；html 来自 ion-dist.asar 的 frame-shell.html。 */
  function serveViewerShell(req, res, url) {
    const match = /^\/(?:code\/(?:artifact|frame)|artifact)\/([0-9A-Za-z_-]{8,36})$/.exec(url.pathname);
    if (!match) return false;
    const id = resolveId(names(), match[1]);
    if (!fs.existsSync(dirOf(id))) {
      send(res, 404, "text/html; charset=utf-8", "<!doctype html><meta charset=utf-8><p>Artifact not found</p>");
      return true;
    }
    const resource = officialAssets?.read?.("/frame-shell.html");
    if (!resource || !resource.body) {
      send(res, 503, "text/plain; charset=utf-8", "frame shell unavailable");
      return true;
    }
    const contentHost = `${id}.claudeusercontent.com`;
    const attrs = `data-frame-uuid="${id}" data-frame-uchost="${contentHost}"`;
    const embedded = req.headers["sec-fetch-dest"] === "iframe" && req.headers["sec-fetch-site"] === "same-origin";
    let html = Buffer.isBuffer(resource.body) ? resource.body.toString("utf8") : String(resource.body);
    const inject = (needle, replacement) => {
      const at = html.toLowerCase().indexOf(needle);
      if (at >= 0) html = html.slice(0, at) + replacement + html.slice(at + needle.length);
    };
    inject("<html", `<html ${attrs}${embedded ? " data-embedded" : ""}`);
    inject('<div id="frame-slot"', `<div id="frame-slot" ${attrs}`);
    send(res, 200, "text/html; charset=utf-8", html, { "x-content-type-options": "nosniff" });
    return true;
  }

  // ── 本地 HTTP 接口 ────────────────────────────────────────
  // 同源调试接口：作品列表、预览 HTML。
  /** 预览用 HTML：优先 project/index.html，其次任意 html，再退到空白画板。 */
  function previewHtml(id) {
    const { latest } = latestOf(id);
    const files = latest?.files || [];
    const pick = files.find((entry) => entry[0] === "project/index.html") ||
      files.find((entry) => entry[0] === "index.html") ||
      files.find((entry) => /\.html?$/i.test(entry[0]) && String(entry[0]).startsWith("project/")) ||
      files.find((entry) => /\.html?$/i.test(entry[0]));
    const meta = metaOf(id);
    const raw = pick ? readBlob(id, pick) : null;
    // design/slides 的画板是 x-dc 标记，需要官方 frame 运行时才能渲染：
    // 面板里给一个说明 + 「在 Claude 中打开」按钮，跳到原生查看器。
    if (raw && raw.toString("utf8", 0, Math.min(raw.length, 2000)).includes("<x-dc")) {
      return Buffer.from(previewBridge(id, meta), "utf8");
    }
    if (raw) return raw;
    if (!meta.type || meta.type === "design") return Buffer.from(blankBoardHtml(), "utf8");
    return null;
  }

  function previewBridge(id, meta) {
    const title = escapeHtml(meta.title || "Artifact");
    const url = `/code/artifact/${id}`;
    return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${title}</title><style>
:root{color-scheme:light dark}body{margin:0;min-height:100vh;display:grid;place-items:center;background:#faf9f5;color:#1f1e1d;
font:14px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif}@media(prefers-color-scheme:dark){body{background:#1c1b19;color:#f0ece4}}
.card{max-width:420px;padding:28px 26px;border:1px solid rgba(128,128,128,.25);border-radius:16px;background:color-mix(in srgb,currentColor 4%,transparent);text-align:center}
h1{font-size:16px;margin:0 0 6px}p{margin:0 0 18px;opacity:.75;font-size:13px}
a{display:inline-block;padding:9px 16px;border-radius:10px;background:#b4472e;color:#fff;text-decoration:none;font-weight:600;font-size:13px}
</style></head><body><div class="card"><h1>${title}</h1><p>这是一个 design/slides 画板作品，需要 Claude 的 frame 运行时才能交互预览。</p><a href="${url}" target="_blank" rel="noopener">在 Claude 中打开</a></div></body></html>`;
  }

  function escapeHtml(text) {
    return String(text).replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch]));
  }

  /** 返回 true 表示已处理。`/__claude_local/artifacts*` 只在主站同源下使用。 */
  function handleLocalApi(method, url, req, res) {
    const p = url.pathname.replace(/\/+$/, "") || "/";
    if (method !== "GET" && method !== "HEAD") return false;
    if (p === "/__claude_local/artifacts") {
      json(res, { artifacts: listArtifacts() });
      return true;
    }
    const match = /^\/__claude_local\/artifacts\/([0-9A-Za-z_-]{8,64})\/(raw|meta)$/.exec(p);
    if (match) {
      const id = resolveId(names(), match[1]);
      if (!fs.existsSync(dirOf(id))) return json(res, { error: "not_found" }, 404), true;
      if (match[2] === "meta") return json(res, rowOf(id) || { id }), true;
      const html = previewHtml(id);
      if (!html) return send(res, 404, "text/html; charset=utf-8", "<!doctype html><meta charset=utf-8><p>No preview for this artifact.</p>"), true;
      send(res, 200, "text/html; charset=utf-8", html, {
        "x-content-type-options": "nosniff",
        "cache-control": "no-store",
      });
      return true;
    }
    return false;
  }

  // ── /api/artifacts/mcp：claude-artifacts MCP ────────────────
  // 工具名和入参与官方 CLI 内置的 artifact MCP 一致（见 claude.exe 里的工具表）；
  // 模型侧把它们叫成 mcp__claude-artifacts__<name>。
  const TOOLS = [
    {
      name: "create_from_type",
      description: "Create a new artifact from a type. Pass the type slug (Design or Slides) and a title.",
      inputSchema: {
        type: "object",
        properties: { type_slug: { type: "string" }, title: { type: "string" } },
        required: ["type_slug"],
      },
    },
    {
      name: "create_artifact",
      description: "Create an artifact of a type. Alias of create_from_type kept for older hosts.",
      inputSchema: {
        type: "object",
        properties: { slug: { type: "string" }, title: { type: "string" } },
        required: ["slug"],
      },
    },
    {
      name: "publish_version",
      description: "Publish a new version of an artifact with files. Each file is {path, content, content_type?, encoding?}; text by default, base64 when encoding is 'base64'. Use paths like project/index.html or project/canvas.json.",
      inputSchema: {
        type: "object",
        properties: {
          slug: { type: "string" },
          title: { type: "string" },
          files: {
            type: "array",
            items: {
              type: "object",
              properties: { path: { type: "string" }, content: { type: "string" }, content_type: { type: "string" }, encoding: { type: "string" } },
              required: ["path", "content"],
            },
          },
          remove: { type: "array", items: { type: "string" } },
        },
        required: ["slug", "files"],
      },
    },
    {
      name: "list_artifacts",
      description: "List the user's local artifacts.",
      inputSchema: { type: "object", properties: {} },
    },
    {
      name: "get_artifact",
      description: "Read one artifact's manifest (versions and files).",
      inputSchema: { type: "object", properties: { slug: { type: "string" } }, required: ["slug"] },
    },
    {
      name: "list_types",
      description: "List the artifact types available on this machine.",
      inputSchema: { type: "object", properties: {} },
    },
    {
      name: "list_files",
      description: "List the files of an artifact's latest version.",
      inputSchema: { type: "object", properties: { slug: { type: "string" } }, required: ["slug"] },
    },
    {
      name: "read_file",
      description: "Read one file of an artifact by its path.",
      inputSchema: {
        type: "object",
        properties: { slug: { type: "string" }, path: { type: "string" } },
        required: ["slug", "path"],
      },
    },
    {
      name: "delete_artifact",
      description: "Delete an artifact.",
      inputSchema: { type: "object", properties: { slug: { type: "string" } }, required: ["slug"] },
    },
    {
      name: "guide",
      description: "How to author artifacts here: design/slides artifacts are frame apps. Write project/ files and publish a version; keep each artifact self-contained.",
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
    },
  ];

  function toolResult(value, isError = false) {
    return { content: [{ type: "text", text: typeof value === "string" ? value : JSON.stringify(value) }], ...(isError ? { isError: true } : {}) };
  }

  function callTool(name, args = {}) {
    switch (name) {
      case "create_from_type":
      case "create_artifact": {
        const typeSlug = args.type_slug || args.slug || args.type || "";
        const { id } = createArtifact(typeSlug, args.title || "");
        return toolResult({ slug: id, url: `${origin}/code/artifact/${id}`, type: typeBySlug(typeSlug) });
      }
      case "publish_version":
      case "edit_version":
      case "publish_files": {
        const id = resolveId(names(), args.slug || args.artifact_slug || args.id);
        const result = publishVersion(id, Array.isArray(args.files) ? args.files : [], { title: args.title, remove: args.remove });
        return toolResult(result);
      }
      case "list_artifacts":
        return toolResult(listArtifacts());
      case "list_types":
        return toolResult(Object.entries(TYPES).map(([name, type]) => ({ name, ...type })));
      case "get_artifact": {
        const id = resolveId(names(), args.slug || args.id);
        const { doc } = versionsOf(id);
        return toolResult({ slug: id, ...doc });
      }
      case "list_files": {
        const id = resolveId(names(), args.slug || args.id);
        const { latest } = latestOf(id);
        return toolResult((latest?.files || []).map((entry) => ({ path: entry[0], content_type: entry[2] })));
      }
      case "read_file": {
        const id = resolveId(names(), args.slug || args.id);
        const buffer = readFileOf(id, String(args.path || ""));
        return buffer ? toolResult(buffer.toString("utf8")) : toolResult("file not found", true);
      }
      case "delete_artifact": {
        const id = resolveId(names(), args.slug || args.id);
        return toolResult({ ok: deleteArtifact(id) });
      }
      case "guide":
        return toolResult(
          "Artifacts on this machine are typed frames. create_from_type picks a type (Design/Slides); " +
          "publish_version sends the files of the new version (project/*). Design artifacts read project/canvas.json " +
          "and project/<board>.dc.html; slides read project/deck.json and project/slide-*.html. Keep everything " +
          "self-contained, then tell the user what you built and that it opens in the Artifact panel.",
        );
      default:
        return toolResult(`unknown tool: ${name}`, true);
    }
  }

  /** JSON-RPC over HTTP（MCP streamable HTTP，无 SSE 的简化实现）。 */
  async function handleMcp(req, res) {
    const raw = await readBody(req);
    let msg;
    try {
      msg = JSON.parse(raw);
    } catch {
      return json(res, { jsonrpc: "2.0", id: null, error: { code: -32700, message: "parse error" } }), true;
    }
    const id = msg.id === undefined ? null : msg.id;
    const reply = (result) => json(res, { jsonrpc: "2.0", id, result }, 200);
    if (msg.method === "initialize") {
      reply({ protocolVersion: msg.params?.protocolVersion || "2025-03-26", capabilities: { tools: {} }, serverInfo: { name: "claude-artifacts", version: "local" } });
      return true;
    }
    if (msg.method === "notifications/initialized" || msg.method === "ping") {
      res.writeHead(202, { "content-length": 0 });
      res.end();
      return true;
    }
    if (msg.method === "tools/list") {
      reply({ tools: TOOLS });
      return true;
    }
    if (msg.method === "tools/call") {
      try {
        reply(callTool(String(msg.params?.name || ""), msg.params?.arguments || {}));
      } catch (error) {
        reply(toolResult(String(error?.message || error), true));
      }
      return true;
    }
    json(res, { jsonrpc: "2.0", id, error: { code: -32601, message: "method not found" } });
    return true;
  }

  /**
   * 聊天链路用的工具面：直接给上游模型的 tools 数组。
   * 名字对齐官方 MCP 前缀，前端按 toolName 识别 artifact 卡片。
   */
  function chatTools() {
    return TOOLS.filter((tool) => ["create_from_type", "publish_version", "list_artifacts", "list_types", "get_artifact", "read_file", "delete_artifact"].includes(tool.name)).map((tool) => ({
      name: `mcp__claude-artifacts__${tool.name}`,
      description: tool.description,
      input_schema: tool.inputSchema,
    }));
  }

  /**
   * 执行聊天里模型发起的 artifact 工具调用。
   * 返回 {ok, text, artifact?}；artifact 用于前端把面板切到新作品。
   */
  function runChatTool(name, input) {
    const bare = String(name || "").replace(/^mcp__claude-artifacts__/, "");
    if (bare === name) return { ok: false, text: `unknown tool: ${name}` };
    const result = callTool(bare, input || {});
    const text = result.content?.[0]?.text || "";
    let artifact = null;
    try {
      const value = JSON.parse(text);
      if (value && value.slug && bare !== "list_artifacts" && bare !== "list_types") {
        artifact = { id: value.slug, url: value.url || `${origin}/code/artifact/${value.slug}` };
      }
    } catch {}
    return { ok: !result.isError, text, artifact };
  }

  return {
    artifacts: { listArtifacts, createArtifact, publishVersion, deleteArtifact, duplicateArtifact, frameDocument, setStarred, touchViewed, patchMeta, types: TYPES },
    handleFrameApi,
    handleFrameHost,
    handleLocalApi,
    serveViewerShell,
    handleMcp,
    chatTools,
    runChatTool,
    storeRoot,
  };
}
