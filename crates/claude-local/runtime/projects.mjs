// 项目（Projects）：Claude 账号侧的项目后端，由本地服务顶上。
//
// 登录官方账号时，项目、项目知识和项目里的对话都记在 Anthropic 那边；对话时服务端把项目指令和知识拼进提示词。
// 本地没有账号，这里自己记项目，知识正文和上传的文件放在状态文件旁边的目录里（没有状态文件时只在内存里），
// 发给上游时把指令和知识放进 system，图片和 PDF 放在第一条用户消息前面。
//
// 不做的：知识检索（RAG，客户端按上下文窗口自己算容量）、Google Drive / GitHub 同步、多人共享。

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";

// 客户端自己也拦 30 MB（31457280）以上的文件。
const MAX_UPLOAD_BYTES = 31457280;
const MAX_DOC_CHARS = 8 * 1024 * 1024;
const MAX_UNZIPPED_BYTES = 64 * 1024 * 1024;
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const isUuid = (value) => typeof value === "string" && uuidPattern.test(value);
const isRecord = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const isText = (value, max) => typeof value === "string" && value.length <= max;
const isDate = (value) => typeof value === "string" && value.length <= 64 && Number.isFinite(Date.parse(value));
const now = () => new Date().toISOString();

const PERMISSIONS = [
  "chat_project:view", "chat_project:chat:view", "chat_project:chat:create",
  "chat_project:knowledge:view", "chat_project:knowledge:edit", "chat_project:settings:edit",
  "chat_project:members:manage", "chat_project:owner:manage", "chat_project:delete",
];

/** 状态文件里的一个项目是否完整。知识正文和文件内容不在这里，在文件目录里。 */
export function validProject(project) {
  return isRecord(project) && isUuid(project.uuid) && isText(project.name, 1024) &&
    isText(project.description, 65536) && isText(project.prompt_template, 1024 * 1024) &&
    typeof project.is_private === "boolean" && typeof project.is_starred === "boolean" &&
    isDate(project.created_at) && isDate(project.updated_at) &&
    (project.archived_at === null || isDate(project.archived_at)) &&
    isRecord(project.settings) &&
    Array.isArray(project.docs) && project.docs.length <= 5000 && project.docs.every((doc) =>
      isRecord(doc) && isUuid(doc.uuid) && isText(doc.file_name, 1024) &&
      Number.isSafeInteger(doc.content_length) && isDate(doc.created_at)) &&
    Array.isArray(project.files) && project.files.length <= 5000 && project.files.every((file) =>
      isRecord(file) && isUuid(file.file_uuid) && isText(file.file_name, 1024) &&
      ["image", "document"].includes(file.file_kind) && isText(file.mime, 256) &&
      Number.isSafeInteger(file.size) && isDate(file.created_at));
}

/** 知识正文和上传文件的存放处：有目录就落盘，没有就在内存里。 */
export function createBlobStore(dir) {
  const memory = new Map();
  const file = (id) => {
    if (!isUuid(id)) throw new Error("Invalid blob id");
    return path.join(dir, id);
  };
  return {
    put(id, data) {
      if (!dir) return void memory.set(id, Buffer.from(data));
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
      const temporary = `${file(id)}.${process.pid}.tmp`;
      fs.writeFileSync(temporary, data, { mode: 0o600 });
      fs.renameSync(temporary, file(id));
    },
    get(id) {
      if (!dir) return memory.get(id) ?? null;
      try { return fs.readFileSync(file(id)); } catch { return null; }
    },
    remove(id) {
      if (!dir) return void memory.delete(id);
      try { fs.rmSync(file(id), { force: true }); } catch {}
    },
  };
}

// ── 文件解析 ─────────────────────────────────────────────────

/** multipart/form-data 里名为 `field` 的那一项：{ filename, type, data }。 */
function multipartFile(contentType, raw, field = "file") {
  const match = /boundary=(?:"([^"]+)"|([^;\s]+))/i.exec(contentType || "");
  if (!match) return null;
  const boundary = Buffer.from(`--${match[1] || match[2]}`);
  let at = raw.indexOf(boundary);
  while (at >= 0) {
    const start = at + boundary.length;
    if (raw.toString("latin1", start, start + 2) === "--") return null;
    const headEnd = raw.indexOf("\r\n\r\n", start);
    if (headEnd < 0) return null;
    const next = raw.indexOf(boundary, headEnd + 4);
    if (next < 0) return null;
    const head = raw.toString("utf8", start, headEnd);
    const name = /content-disposition:[^\r\n]*;\s*name="([^"]*)"/i.exec(head)?.[1];
    if (name === field) {
      const encoded = /filename\*=(?:UTF-8|utf-8)''([^;\r\n]+)/.exec(head)?.[1];
      let filename = /filename="([^"]*)"/i.exec(head)?.[1] ?? "file";
      if (encoded) {
        try { filename = decodeURIComponent(encoded); } catch {}
      }
      const type = /content-type:\s*([^\r\n;]+)/i.exec(head)?.[1]?.trim().toLowerCase() || "application/octet-stream";
      return { filename: path.basename(filename.replace(/\\/g, "/")) || "file", type, data: raw.subarray(headEnd + 4, next - 2) };
    }
    at = next;
  }
  return null;
}

/** zip 里的条目：名字 → 解压后的内容（只认存储和 deflate）。 */
function zipEntries(zip) {
  const END = 0x06054b50, CENTRAL = 0x02014b50, LOCAL = 0x04034b50;
  let end = -1;
  for (let at = zip.length - 22; at >= Math.max(0, zip.length - 22 - 0xffff); at--) {
    if (zip.readUInt32LE(at) === END) { end = at; break; }
  }
  if (end < 0) throw new Error("not a zip archive");
  const entries = new Map();
  let total = 0;
  let at = zip.readUInt32LE(end + 16);
  for (let index = 0; index < zip.readUInt16LE(end + 10); index++) {
    if (at + 46 > zip.length || zip.readUInt32LE(at) !== CENTRAL) throw new Error("zip central directory is damaged");
    const method = zip.readUInt16LE(at + 10);
    const compressedSize = zip.readUInt32LE(at + 20);
    const size = zip.readUInt32LE(at + 24);
    const nameLength = zip.readUInt16LE(at + 28);
    const localAt = zip.readUInt32LE(at + 42);
    const name = zip.toString("utf8", at + 46, at + 46 + nameLength);
    at += 46 + nameLength + zip.readUInt16LE(at + 30) + zip.readUInt16LE(at + 32);
    if (localAt + 30 > zip.length || zip.readUInt32LE(localAt) !== LOCAL) throw new Error("zip entry is damaged");
    const dataAt = localAt + 30 + zip.readUInt16LE(localAt + 26) + zip.readUInt16LE(localAt + 28);
    const data = zip.subarray(dataAt, dataAt + compressedSize);
    total += size;
    if (total > MAX_UNZIPPED_BYTES) throw new Error("zip is too large");
    if (method === 0) entries.set(name, data);
    else if (method === 8) entries.set(name, zlib.inflateRawSync(data, { maxOutputLength: size + 1024 }));
  }
  return entries;
}

const xmlText = (value) => value
  .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'")
  .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)))
  .replace(/&#x([0-9a-f]+);/gi, (_, code) => String.fromCodePoint(parseInt(code, 16)))
  .replace(/&amp;/g, "&");

function docxText(entries) {
  const xml = entries.get("word/document.xml")?.toString("utf8");
  if (!xml) return "";
  return xmlText(xml
    .replace(/<w:tab\/>/g, "\t")
    .replace(/<w:br\/>|<\/w:p>/g, "\n")
    .replace(/<[^>]+>/g, ""))
    .replace(/\n{3,}/g, "\n\n").trim();
}

function pptxText(entries) {
  const slides = [...entries.keys()]
    .filter((name) => /^ppt\/slides\/slide\d+\.xml$/.test(name))
    .sort((a, b) => Number(/\d+/.exec(a.slice(10))[0]) - Number(/\d+/.exec(b.slice(10))[0]));
  return slides.map((name, index) => {
    const xml = entries.get(name).toString("utf8");
    const paragraphs = xml.split(/<\/a:p>/).map((part) =>
      [...part.matchAll(/<a:t>([^<]*)<\/a:t>/g)].map((m) => xmlText(m[1])).join("")).filter(Boolean);
    return `## Slide ${index + 1}\n${paragraphs.join("\n")}`;
  }).join("\n\n").trim();
}

function xlsxText(entries) {
  const shared = [...(entries.get("xl/sharedStrings.xml")?.toString("utf8") ?? "").matchAll(/<si>([\s\S]*?)<\/si>/g)]
    .map((m) => xmlText([...m[1].matchAll(/<t[^>]*>([^<]*)<\/t>/g)].map((t) => t[1]).join("")));
  const sheets = [...entries.keys()]
    .filter((name) => /^xl\/worksheets\/sheet\d+\.xml$/.test(name))
    .sort((a, b) => Number(/(\d+)\.xml$/.exec(a)[1]) - Number(/(\d+)\.xml$/.exec(b)[1]));
  return sheets.map((name, index) => {
    const xml = entries.get(name).toString("utf8");
    const rows = [...xml.matchAll(/<row[^>]*>([\s\S]*?)<\/row>/g)].map((row) =>
      [...row[1].matchAll(/<c([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)].map((cell) => {
        const type = /\st="([^"]+)"/.exec(cell[1])?.[1];
        const body = cell[2] ?? "";
        if (type === "inlineStr") return xmlText([...body.matchAll(/<t[^>]*>([^<]*)<\/t>/g)].map((t) => t[1]).join(""));
        const value = /<v>([^<]*)<\/v>/.exec(body)?.[1] ?? "";
        return type === "s" ? shared[Number(value)] ?? "" : xmlText(value);
      }).join("\t"));
    return `## Sheet ${index + 1}\n${rows.join("\n")}`;
  }).join("\n\n").trim();
}

/** 能当文本读的文件：UTF-8 解得开、没有 NUL。 */
function plainText(data) {
  const text = data.toString("utf8");
  if (text.includes("\u0000") || (text.match(/\uFFFD/g)?.length ?? 0) > text.length / 100) return null;
  return text.replace(/^\uFEFF/, "");
}

/** 文档转文本（convert_document 用）。认不出的返回 null。 */
function extractText(filename, data) {
  const extension = path.extname(filename).toLowerCase();
  try {
    if (extension === ".docx") return docxText(zipEntries(data));
    if (extension === ".pptx") return pptxText(zipEntries(data));
    if (extension === ".xlsx") return xlsxText(zipEntries(data));
  } catch {
    return null;
  }
  if (extension === ".pdf" || data.subarray(0, 5).toString("latin1") === "%PDF-") return null;
  return plainText(data);
}

/** 上传文件的种类（按文件头认）：图片或 PDF，别的返回 null。 */
function uploadKind(data) {
  const head = data.subarray(0, 12);
  if (head.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return { kind: "image", mime: "image/png" };
  if (head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff) return { kind: "image", mime: "image/jpeg" };
  if (head.toString("latin1", 0, 6) === "GIF87a" || head.toString("latin1", 0, 6) === "GIF89a") return { kind: "image", mime: "image/gif" };
  if (head.toString("latin1", 0, 4) === "RIFF" && head.toString("latin1", 8, 12) === "WEBP") return { kind: "image", mime: "image/webp" };
  if (head.toString("latin1", 0, 5) === "%PDF-") return { kind: "document", mime: "application/pdf" };
  return null;
}

/** 图片的宽高（PNG / JPEG / GIF / WebP），读不出返回 null。 */
function imageSize(data) {
  try {
    if (data.readUInt32BE(0) === 0x89504e47) return { width: data.readUInt32BE(16), height: data.readUInt32BE(20) };
    if (data.toString("latin1", 0, 3) === "GIF") return { width: data.readUInt16LE(6), height: data.readUInt16LE(8) };
    if (data.toString("latin1", 0, 4) === "RIFF") {
      const chunk = data.toString("latin1", 12, 16);
      if (chunk === "VP8X") return { width: 1 + data.readUIntLE(24, 3), height: 1 + data.readUIntLE(27, 3) };
      if (chunk === "VP8 ") return { width: data.readUInt16LE(26) & 0x3fff, height: data.readUInt16LE(28) & 0x3fff };
      if (chunk === "VP8L") {
        const bits = data.readUInt32LE(21);
        return { width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1 };
      }
    }
    if (data[0] === 0xff && data[1] === 0xd8) {
      let at = 2;
      while (at + 9 < data.length) {
        if (data[at] !== 0xff) return null;
        const marker = data[at + 1];
        const length = data.readUInt16BE(at + 2);
        if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) {
          return { width: data.readUInt16BE(at + 7), height: data.readUInt16BE(at + 5) };
        }
        at += 2 + length;
      }
    }
  } catch {}
  return null;
}

const pdfPages = (data) => Math.max(1, data.toString("latin1").match(/\/Type\s*\/Page(?![s\w])/g)?.length ?? 0);

// ── 拼进提示词 ───────────────────────────────────────────────

const escapeXml = (value) => value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/**
 * 把项目上下文放进一次 /v1/messages 请求：指令和文本知识进 system（带缓存标记，知识大时省钱），
 * 图片和 PDF 放在第一条用户消息的前面。没有项目上下文时原样返回。
 */
export function withProjectContext(payload, context) {
  if (!context) return payload;
  const next = { ...payload };
  if (context.system) next.system = [{ type: "text", text: context.system, cache_control: { type: "ephemeral" } }];
  if (context.blocks.length && next.messages?.length && next.messages[0].role === "user") {
    const [first, ...rest] = next.messages;
    const content = typeof first.content === "string" ? [{ type: "text", text: first.content }] : first.content;
    next.messages = [{ ...first, content: [...context.blocks, ...content] }, ...rest];
  }
  return next;
}

// ── 确认框文案 ───────────────────────────────────────────────

// 删除、归档项目的确认框正文是服务端按账号下发的 gated 文案（bootstrap.gated_messages，键是 `secret:<id>`）；
// 没有时确认按钮一直是灰的。录制模板里没有这几条，这里补上自己写的。
const PROJECT_MESSAGES = {
  "zh-Hans": {
    "secret:1lztl35": "项目会被永久删除，连同它的知识和里面的所有对话。此操作无法撤销。",
    "secret:1rdcf6l": "这 {count} 个项目会被永久删除，连同它们的知识和里面的所有对话。此操作无法撤销。",
    "secret:nwsiqa": "归档后项目不再出现在项目列表里，可以在<link>已归档的项目</link>里找到并恢复。",
    "secret:1q9omgc": "归档后这 {count} 个项目不再出现在项目列表里，可以在<link>已归档的项目</link>里找到并恢复。",
  },
  "en-US": {
    "secret:1lztl35": "This permanently deletes the project, its knowledge and all of its chats. This can’t be undone.",
    "secret:1rdcf6l": "This permanently deletes {count} projects, their knowledge and all of their chats. This can’t be undone.",
    "secret:nwsiqa": "Archived projects are hidden from your project list. You can find and restore them in <link>archived projects</link>.",
    "secret:1q9omgc": "These {count} projects will be hidden from your project list. You can find and restore them in <link>archived projects</link>.",
  },
};

/** 给 bootstrap 的 gated_messages 补上项目确认框的文案（已有的不动；打包格式的不动）。 */
export function withProjectMessages(gated) {
  if (!isRecord(gated) || gated.packed || !isRecord(gated.messages)) return gated;
  const extra = PROJECT_MESSAGES[gated.locale === "zh-Hans" ? "zh-Hans" : "en-US"];
  return { ...gated, messages: { ...extra, ...gated.messages } };
}

// ── 接口 ─────────────────────────────────────────────────────

/**
 * `projects`：uuid → 项目，由调用方持久化（改动后调 `changed`）。
 * `blobs`：createBlobStore 的结果。`account`：{ uuid, name, email }。
 * `conversations()`：全部本地会话（带 project_uuid）；`conversationRecord(conv)`：会话的 REST 形状；
 * `removeConversation(uuid)`：删掉一个会话。
 * `json` / `readBody` / `decodeJsonBody`：proxy 的响应和读请求体的工具。
 */
export function createProjectApi({ projects, blobs, account, changed, conversations, conversationRecord, removeConversation, json, readBody, decodeJsonBody }) {
  const creator = () => ({ uuid: account.uuid, full_name: account.name, email_address: account.email });

  function docRecord(doc, { content = false } = {}) {
    return {
      uuid: doc.uuid,
      file_name: doc.file_name,
      content_length: doc.content_length,
      estimated_token_count: Math.ceil(doc.content_length / 4),
      created_at: doc.created_at,
      ...(content ? { content: blobs.get(doc.uuid)?.toString("utf8") ?? "" } : {}),
    };
  }

  function fileRecord(org, file) {
    const base = `/api/${org}/files/${file.file_uuid}`;
    const record = {
      file_uuid: file.file_uuid,
      uuid: file.file_uuid,
      file_name: file.file_name,
      file_kind: file.file_kind,
      created_at: file.created_at,
      size_bytes: file.size,
      success: true,
    };
    if (file.file_kind === "image") {
      const asset = (variant) => ({
        url: `${base}/${variant}`, file_variant: variant, primary_color: "ffffff",
        image_width: file.width ?? 0, image_height: file.height ?? 0,
      });
      return {
        ...record, thumbnail_url: `${base}/thumbnail`, preview_url: `${base}/preview`,
        thumbnail_asset: asset("thumbnail"), preview_asset: asset("preview"),
      };
    }
    return {
      ...record,
      document_asset: { url: `${base}/document`, file_variant: "document", page_count: file.page_count ?? 1 },
    };
  }

  function projectRecord(project) {
    return {
      uuid: project.uuid,
      name: project.name,
      description: project.description,
      prompt_template: project.prompt_template,
      is_private: project.is_private,
      is_starred: project.is_starred,
      is_starter_project: false,
      is_harmony_project: false,
      type: project.type ?? null,
      subtype: project.subtype ?? null,
      creator: creator(),
      created_at: project.created_at,
      updated_at: project.updated_at,
      archived_at: project.archived_at,
      archiver: project.archived_at ? creator() : null,
      settings: project.settings,
      permissions: PERMISSIONS,
      has_sync_sources: false,
      memory_general_enabled: project.memory_general_enabled ?? true,
      docs_count: project.docs.length,
      files_count: project.files.length,
    };
  }

  const lastActivity = (project) => conversations()
    .filter((conv) => conv.project_uuid === project.uuid)
    .reduce((latest, conv) => (conv.updated_at > latest ? conv.updated_at : latest), project.updated_at);

  /** 按列表接口的查询参数筛选、排序、分页。 */
  function listed(params) {
    let rows = [...projects.values()];
    const uuids = params.getAll("uuids");
    if (uuids.length) rows = rows.filter((project) => uuids.includes(project.uuid));
    const archived = params.get("is_archived");
    if (archived === "true") rows = rows.filter((project) => project.archived_at);
    else if (!uuids.length) rows = rows.filter((project) => !project.archived_at);
    if (params.get("starred") === "true") rows = rows.filter((project) => project.is_starred);
    if (params.get("starred") === "false") rows = rows.filter((project) => !project.is_starred);
    const type = params.get("type");
    if (type) rows = rows.filter((project) => (project.type ?? "") === type);
    // 只有自己一个人：「别人分享给我」「组织共享」这些都是空的。
    const filter = params.get("filter") ?? params.get("creator_filter");
    if (filter && /shared_with_me|not_creator|shared_with_org/.test(filter)) rows = [];
    const query = (params.get("searchQuery") ?? params.get("search") ?? "").trim().toLowerCase();
    if (query) rows = rows.filter((project) => `${project.name}\n${project.description}`.toLowerCase().includes(query));
    const order = params.get("order_by") ?? "latest_activity";
    const key = order === "created_at" ? (project) => project.created_at
      : order === "name" ? null : lastActivity;
    rows.sort(key ? (a, b) => key(b).localeCompare(key(a)) : (a, b) => a.name.localeCompare(b.name));
    const total = rows.length;
    const offset = Math.max(0, Number.parseInt(params.get("offset") ?? "0", 10) || 0);
    const limit = Math.min(1000, Math.max(1, Number.parseInt(params.get("limit") ?? "1000", 10) || 1000));
    const page = rows.slice(offset, offset + limit).map(projectRecord);
    return { page, total, offset, limit, has_more: offset + limit < total };
  }

  // 和 validProject 的上限一致：超了的话下次启动整份状态会被当成损坏。
  function update(project, body) {
    if (typeof body.name === "string" && body.name.trim()) project.name = body.name.trim().slice(0, 1024);
    if (typeof body.description === "string") project.description = body.description.slice(0, 65536);
    if (typeof body.prompt_template === "string") project.prompt_template = body.prompt_template.slice(0, 1024 * 1024);
    for (const key of ["is_private", "is_starred", "memory_general_enabled"]) {
      if (typeof body[key] === "boolean") project[key] = body[key];
    }
    if (typeof body.is_archived === "boolean") project.archived_at = body.is_archived ? now() : null;
    if (body.archived_at === null) project.archived_at = null;
    if (isRecord(body.settings)) project.settings = { ...project.settings, ...body.settings };
    project.updated_at = now();
  }

  function addDoc(project, fileName, content) {
    const doc = {
      uuid: crypto.randomUUID(),
      file_name: String(fileName || "untitled.txt").slice(0, 1024),
      content_length: content.length,
      created_at: now(),
    };
    blobs.put(doc.uuid, Buffer.from(content, "utf8"));
    project.docs.unshift(doc);
    project.updated_at = now();
    return doc;
  }

  function removeKnowledge(project, ids) {
    const gone = new Set(ids);
    for (const doc of project.docs) if (gone.has(doc.uuid)) blobs.remove(doc.uuid);
    for (const file of project.files) if (gone.has(file.file_uuid)) blobs.remove(file.file_uuid);
    project.docs = project.docs.filter((doc) => !gone.has(doc.uuid));
    project.files = project.files.filter((file) => !gone.has(file.file_uuid));
    project.updated_at = now();
  }

  function deleteProject(project) {
    removeKnowledge(project, [...project.docs.map((doc) => doc.uuid), ...project.files.map((file) => file.file_uuid)]);
    for (const conv of conversations()) {
      if (conv.project_uuid === project.uuid) removeConversation(conv.uuid);
    }
    projects.delete(project.uuid);
  }

  const notFound = (res) => json(res, {
    type: "error", error: { type: "not_found_error", message: "Project not found", details: { error_code: "project_not_found" } },
  }, 404);

  const idsFrom = (body) => [body.doc_uuids, body.file_uuids, body.uuids, body.document_uuids]
    .find(Array.isArray)?.filter((id) => typeof id === "string") ?? [];

  /** 读上传的文件，超过上限就回 413。 */
  function readUpload(req, res, done) {
    const chunks = [];
    let size = 0;
    let refused = false;
    req.on("data", (chunk) => {
      if (refused) return;
      size += chunk.length;
      if (size > MAX_UPLOAD_BYTES + 64 * 1024) {
        refused = true;
        json(res, { type: "error", error: { type: "invalid_request_error", message: "File too large", details: { error_code: "file_too_large" } } }, 413);
        req.resume();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      if (refused) return;
      const file = multipartFile(req.headers["content-type"], Buffer.concat(chunks));
      if (!file) return json(res, { type: "error", error: { type: "invalid_request_error", message: "No file in the upload" } }, 400);
      done(file);
    });
  }

  const unsupported = (res) => json(res, {
    type: "error",
    error: { type: "invalid_request_error", message: "Could not extract text from this file", details: { error_code: "extraction_failed" } },
  }, 422);

  /** 处理了返回 true。`p` 是去掉末尾斜杠的路径。 */
  function handle(req, res, url, p) {
    const method = req.method;
    const orgRoute = /^\/api\/organizations\/([^/]+)\/(.+)$/.exec(p);
    const fileRoute = /^\/api\/([^/]+)\/files\/([0-9a-f-]{36})\/(preview|thumbnail|document)$/.exec(p);

    // 项目文件的内容（知识面板的缩略图、预览）。
    if (fileRoute && method === "GET") {
      for (const project of projects.values()) {
        const file = project.files.find((entry) => entry.file_uuid === fileRoute[2]);
        if (!file) continue;
        const data = blobs.get(file.file_uuid);
        if (!data) break;
        res.writeHead(200, { "content-type": file.mime, "content-length": data.length, "cache-control": "private, max-age=3600" });
        res.end(data);
        return true;
      }
      notFound(res);
      return true;
    }
    if (!orgRoute) return false;
    const [, org, route] = orgRoute;

    if (method === "POST" && route === "convert_document") {
      readUpload(req, res, (file) => {
        const text = extractText(file.filename, file.data);
        if (!text) return unsupported(res);
        json(res, { file_name: file.filename, file_size: file.data.length, file_type: file.type, extracted_content: text.slice(0, MAX_DOC_CHARS) });
      });
      return true;
    }

    // 把会话移进 / 移出项目。
    if (method === "POST" && route === "chat_conversations/move_many") {
      readBody(req, (raw) => {
        const body = decodeJsonBody(req, raw);
        const target = body.project_uuid ?? null;
        if (target !== null && !projects.has(target)) return notFound(res);
        const ids = new Set(Array.isArray(body.conversation_uuids) ? body.conversation_uuids : []);
        const moved = [];
        for (const conv of conversations()) {
          if (!ids.has(conv.uuid)) continue;
          conv.project_uuid = target;
          moved.push(conv.uuid);
        }
        changed();
        json(res, { moved, failed: [...ids].filter((id) => !moved.includes(id)).map((uuid) => ({ uuid, reason: "not_found" })) });
      });
      return true;
    }

    if (route === "projects/count" && method === "GET") {
      json(res, { count: [...projects.values()].filter((project) => !project.archived_at).length });
      return true;
    }
    if (route === "projects" || route === "projects_v2") {
      if (method === "POST" && route === "projects") {
        readBody(req, (raw) => {
          const body = decodeJsonBody(req, raw);
          const name = typeof body.name === "string" ? body.name.trim().slice(0, 1024) : "";
          if (!name) {
            return json(res, { type: "error", error: { type: "invalid_request_error", message: "Project name is required" } }, 400);
          }
          const at = now();
          const project = {
            uuid: crypto.randomUUID(),
            name,
            description: "",
            prompt_template: "",
            is_private: body.is_private !== false,
            is_starred: body.is_starred === true,
            type: typeof body.type === "string" ? body.type.slice(0, 64) : null,
            subtype: typeof body.subtype === "string" ? body.subtype.slice(0, 64) : null,
            created_at: at,
            updated_at: at,
            archived_at: null,
            settings: {},
            docs: [],
            files: [],
          };
          update(project, { description: body.description, prompt_template: body.prompt_template });
          projects.set(project.uuid, project);
          changed();
          json(res, projectRecord(project), 201);
        });
        return true;
      }
      if (method !== "GET") return false;
      const list = listed(url.searchParams);
      if (route === "projects_v2") {
        json(res, {
          data: list.page,
          pagination: { has_more: list.has_more, limit: list.limit, offset: list.offset, total: list.total },
          has_archived: [...projects.values()].some((project) => project.archived_at),
        });
      } else if (url.searchParams.get("with_own_projects") === "true") {
        json(res, { starred: list.page.filter((project) => project.is_starred), own: list.page });
      } else {
        json(res, list.page);
      }
      return true;
    }

    const match = /^projects\/([^/]+)(?:\/(.+))?$/.exec(route);
    if (!match) return false;
    const project = projects.get(match[1]);
    const sub = match[2] ?? "";
    if (!project) {
      // 不认识的项目：列表类回空页，别的回 404。
      if (method === "GET" && /^conversations(_v2)?$/.test(sub)) {
        json(res, sub === "conversations" ? [] : { data: [], pagination: { has_more: false, limit: 30, offset: 0, total: 0 } });
      } else {
        notFound(res);
      }
      return true;
    }

    if (sub === "") {
      if (method === "GET") return json(res, projectRecord(project)), true;
      if (method === "PUT" || method === "PATCH") {
        readBody(req, (raw) => {
          update(project, decodeJsonBody(req, raw));
          changed();
          json(res, projectRecord(project));
        });
        return true;
      }
      if (method === "DELETE") {
        deleteProject(project);
        changed();
        res.writeHead(204, { "content-length": 0 });
        res.end();
        return true;
      }
      return false;
    }

    if (sub === "conversations" || sub === "conversations_v2") {
      const rows = conversations()
        .filter((conv) => conv.project_uuid === project.uuid)
        .sort((a, b) => String(b.updated_at).localeCompare(String(a.updated_at)))
        .map(conversationRecord);
      if (sub === "conversations") return json(res, rows), true;
      const offset = Math.max(0, Number.parseInt(url.searchParams.get("offset") ?? "0", 10) || 0);
      const limit = Math.max(1, Number.parseInt(url.searchParams.get("limit") ?? "30", 10) || 30);
      json(res, {
        data: rows.slice(offset, offset + limit),
        pagination: { has_more: offset + limit < rows.length, limit, offset, total: rows.length },
      });
      return true;
    }

    if (sub === "docs") {
      if (method === "GET") {
        const compact = url.searchParams.get("compact") === "true";
        return json(res, project.docs.map((doc) => docRecord(doc, { content: !compact }))), true;
      }
      if (method === "POST") {
        readBody(req, (raw) => {
          const body = decodeJsonBody(req, raw);
          if (typeof body.content !== "string" || body.content.length > MAX_DOC_CHARS) {
            return json(res, { type: "error", error: { type: "invalid_request_error", message: "Document content is required" } }, 400);
          }
          const doc = addDoc(project, body.file_name, body.content);
          changed();
          json(res, docRecord(doc, { content: true }), 201);
        });
        return true;
      }
      return false;
    }
    if ((sub === "docs/delete_many" || sub === "files/delete_many") && method === "POST") {
      readBody(req, (raw) => {
        const ids = idsFrom(decodeJsonBody(req, raw));
        removeKnowledge(project, ids);
        changed();
        json(res, { deleted: ids, failed: [] });
      });
      return true;
    }
    const docMatch = /^docs\/([0-9a-f-]{36})$/.exec(sub);
    if (docMatch) {
      const doc = project.docs.find((entry) => entry.uuid === docMatch[1]);
      if (!doc) return notFound(res), true;
      if (method === "GET") return json(res, docRecord(doc, { content: true })), true;
      if (method === "DELETE") {
        removeKnowledge(project, [doc.uuid]);
        changed();
        res.writeHead(204, { "content-length": 0 });
        res.end();
        return true;
      }
      if (method === "PUT" || method === "PATCH") {
        readBody(req, (raw) => {
          const body = decodeJsonBody(req, raw);
          if (typeof body.file_name === "string" && body.file_name.trim()) doc.file_name = body.file_name.trim().slice(0, 1024);
          if (typeof body.content === "string" && body.content.length <= MAX_DOC_CHARS) {
            blobs.put(doc.uuid, Buffer.from(body.content, "utf8"));
            doc.content_length = body.content.length;
          }
          project.updated_at = now();
          changed();
          json(res, docRecord(doc, { content: true }));
        });
        return true;
      }
      return false;
    }

    if (sub === "files" && method === "GET") return json(res, project.files.map((file) => fileRecord(org, file))), true;
    const fileMatch = /^files\/([0-9a-f-]{36})$/.exec(sub);
    if (fileMatch) {
      const file = project.files.find((entry) => entry.file_uuid === fileMatch[1]);
      if (!file) return notFound(res), true;
      if (method === "GET") return json(res, fileRecord(org, file)), true;
      if (method === "DELETE") {
        removeKnowledge(project, [file.file_uuid]);
        changed();
        res.writeHead(204, { "content-length": 0 });
        res.end();
        return true;
      }
      return false;
    }
    if (sub === "upload" && method === "POST") {
      readUpload(req, res, (upload) => {
        // 客户端只把图片和 PDF 传到这里：Office 文档走 convert_document，纯文本自己读了按文档提交。
        const kind = uploadKind(upload.data);
        if (!kind) {
          return json(res, {
            type: "error", error: { type: "invalid_request_error", message: "Only images and PDF files can be uploaded", details: { error_code: "invalid_file_type" } },
          }, 400);
        }
        const file = {
          file_uuid: crypto.randomUUID(),
          file_name: upload.filename.slice(0, 1024),
          file_kind: kind.kind,
          mime: kind.mime,
          size: upload.data.length,
          created_at: now(),
          ...(kind.kind === "image" ? imageSize(upload.data) ?? {} : { page_count: pdfPages(upload.data) }),
        };
        blobs.put(file.file_uuid, upload.data);
        project.files.unshift(file);
        project.updated_at = now();
        changed();
        json(res, fileRecord(org, file));
      });
      return true;
    }

    if (method === "GET" && (sub === "syncs" || sub === "sync")) return json(res, []), true;
    if (method === "POST" && sub === "sync") return json(res, { type: "error", error: { type: "invalid_request_error", message: "本地模式不支持同步来源" } }, 400), true;
    if (method === "GET" && sub === "kb/stats") {
      const size = project.docs.reduce((sum, doc) => sum + doc.content_length, 0);
      return json(res, { knowledge_size: size, use_project_knowledge_search: false }), true;
    }
    if (sub === "settings") {
      if (method === "GET") return json(res, project.settings), true;
      readBody(req, (raw) => {
        const body = decodeJsonBody(req, raw);
        if (isRecord(body)) project.settings = { ...project.settings, ...body };
        project.updated_at = now();
        changed();
        json(res, project.settings);
      });
      return true;
    }
    // 只有自己一个人：成员就是自己，权限全开。
    if (method === "GET" && sub === "accounts") {
      return json(res, [{ account: creator(), role: "owner", created_at: project.created_at }]), true;
    }
    if (method === "GET" && sub === "permissions") return json(res, { permissions: PERMISSIONS }), true;
    if (method === "GET" && sub === "roles") {
      return json(res, { account_assignments: [], group_assignments: [], org_role_assignments: {}, org_assignment: null }), true;
    }
    if (method === "GET" && sub === "activity_v2") {
      return json(res, { data: [], pagination: { has_more: false, limit: 30, offset: 0, total: 0 } }), true;
    }
    return false;
  }

  /**
   * 一个项目要带给模型的上下文：{ system, blocks }。项目不存在、什么都没有时返回 null。
   * 文本知识按添加顺序（最早的在前）拼成 documents，指令放在最后。
   */
  function context(projectUuid) {
    const project = projectUuid ? projects.get(projectUuid) : null;
    if (!project) return null;
    const parts = [];
    const docs = [...project.docs].reverse()
      .map((doc) => ({ doc, content: blobs.get(doc.uuid)?.toString("utf8") }))
      .filter((entry) => entry.content);
    if (docs.length) {
      parts.push(
        "The user has added the following documents to the project knowledge. Use them when they are relevant.",
        `<documents>\n${docs.map(({ doc, content }, index) =>
          `<document index="${index + 1}">\n<source>${escapeXml(doc.file_name)}</source>\n<document_content>\n${content}\n</document_content>\n</document>`).join("\n")}\n</documents>`,
      );
    }
    if (project.prompt_template.trim()) {
      parts.push(`The user has set the following instructions for this project. Follow them.\n<project_instructions>\n${project.prompt_template.trim()}\n</project_instructions>`);
    }
    const blocks = [];
    for (const file of [...project.files].reverse()) {
      const data = blobs.get(file.file_uuid);
      if (!data) continue;
      const source = { type: "base64", media_type: file.mime, data: data.toString("base64") };
      blocks.push(file.file_kind === "image"
        ? { type: "image", source }
        : { type: "document", source, title: file.file_name });
    }
    if (!parts.length && !blocks.length) return null;
    return { system: parts.length ? `Project: ${project.name}\n\n${parts.join("\n\n")}` : "", blocks };
  }

  // remove 即 deleteProject：channelsApi（Code 面板的 DELETE）也必须走这套语义，
  // 只删 Map 会残留知识 blob、留下悬空的 project_uuid。
  return { handle, context, has: (uuid) => projects.has(uuid), remove: deleteProject };
}
