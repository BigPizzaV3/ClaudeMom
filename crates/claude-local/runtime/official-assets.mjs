import fs from "node:fs";
import path from "node:path";

const MAX_ARCHIVE_BYTES = 2 * 1024 * 1024 * 1024;
const MAX_HEADER_BYTES = 64 * 1024 * 1024;
const MAX_RESOURCE_BYTES = 64 * 1024 * 1024;
const MAX_UNPACKED_ENTRIES = 100_000;
const PUBLIC_ROOTS = ["assets/", "audio/", "i18n/", "images/"];
const PUBLIC_FILES = new Set([
  "client-shell-v1.html",
  "favicon-internal.ico",
  "favicon-staging.ico",
  "favicon.ico",
  "frame-connect.html",
  "frame-manage.html",
  "frame-shell.html",
  "index.html",
  "robots.txt",
  "scc.json",
  "third-party-notices.txt",
]);
const CONTENT_TYPES = new Map([
  [".css", "text/css; charset=utf-8"],
  [".gif", "image/gif"],
  [".html", "text/html; charset=utf-8"],
  [".ico", "image/x-icon"],
  [".jpeg", "image/jpeg"],
  [".jpg", "image/jpeg"],
  [".js", "text/javascript; charset=utf-8"],
  [".json", "application/json; charset=utf-8"],
  [".m4a", "audio/mp4"],
  [".mp3", "audio/mpeg"],
  [".mp4", "video/mp4"],
  [".ogg", "audio/ogg"],
  [".png", "image/png"],
  [".svg", "image/svg+xml"],
  [".txt", "text/plain; charset=utf-8"],
  [".wasm", "application/wasm"],
  [".wav", "audio/wav"],
  [".webp", "image/webp"],
  [".woff", "font/woff"],
  [".woff2", "font/woff2"],
]);

function readExactly(fd, length, position) {
  const buffer = Buffer.alloc(length);
  let read = 0;
  while (read < length) {
    const count = fs.readSync(fd, buffer, read, length - read, position + read);
    if (count === 0) throw new Error("Unexpected end of Claude Desktop ASAR");
    read += count;
  }
  return buffer;
}

function readAsar(resourcesDir) {
  const realResources = fs.realpathSync(resourcesDir);
  if (!fs.statSync(realResources).isDirectory()) throw new Error("Claude Desktop resources path is not a directory");
  const archivePath = path.join(realResources, "ion-dist.asar");
  const metadata = fs.lstatSync(archivePath);
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size < 24 || metadata.size > MAX_ARCHIVE_BYTES) {
    throw new Error("Claude Desktop ion-dist.asar is not a supported regular file");
  }

  const fd = fs.openSync(archivePath, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.size !== metadata.size) throw new Error("Claude Desktop ion-dist.asar changed while opening");
    const prefix = readExactly(fd, 16, 0);
    const headerSize = prefix.readUInt32LE(4);
    const jsonSize = prefix.readUInt32LE(12);
    const payloadStart = 8 + headerSize;
    if (
      headerSize < 8 ||
      headerSize > MAX_HEADER_BYTES ||
      payloadStart > stat.size ||
      jsonSize < 2 ||
      jsonSize > headerSize - 8 ||
      16 + jsonSize > payloadStart
    ) {
      throw new Error("Claude Desktop ion-dist.asar has an invalid header");
    }

    const header = JSON.parse(readExactly(fd, jsonSize, 16).toString("utf8"));
    if (!header || typeof header !== "object" || !header.files || typeof header.files !== "object") {
      throw new Error("Claude Desktop ion-dist.asar has no file table");
    }

    const entries = new Map();
    const walk = (directory, parent = "") => {
      for (const [name, entry] of Object.entries(directory)) {
        if (!name || name === "." || name === ".." || /[/\\\0]/.test(name) ||
          !entry || typeof entry !== "object" || Array.isArray(entry)) {
          throw new Error("Claude Desktop ion-dist.asar has an invalid path entry");
        }
        const member = parent ? `${parent}/${name}` : name;
        if (entry.files !== undefined) {
          if (!entry.files || typeof entry.files !== "object" || Array.isArray(entry.files)) {
            throw new Error("Claude Desktop ion-dist.asar has an invalid directory entry");
          }
          walk(entry.files, member);
          continue;
        }
        if (entry.link !== undefined || entry.unpacked === true ||
          !Number.isSafeInteger(entry.size) || entry.size < 0 ||
          typeof entry.offset !== "string" || !/^(0|[1-9][0-9]*)$/.test(entry.offset)) {
          throw new Error("Claude Desktop ion-dist.asar has an unsupported file entry");
        }
        const offset = Number(entry.offset);
        if (!Number.isSafeInteger(offset) || offset + entry.size > stat.size - payloadStart) {
          throw new Error("Claude Desktop ion-dist.asar has an out-of-bounds file entry");
        }
        entries.set(member, { offset: payloadStart + offset, size: entry.size });
      }
    };
    walk(header.files);

    const index = entries.get("index.html");
    if (!index || index.size > MAX_RESOURCE_BYTES) throw new Error("Claude Desktop ion-dist.asar has no usable web entry");
    const indexHtml = readExactly(fd, index.size, index.offset).toString("utf8");
    return {
      ...webEntry(entries, indexHtml),
      archivePath,
      readEntry: (entry) => readExactly(fd, entry.size, entry.offset),
      close: () => fs.closeSync(fd),
    };
  } catch (error) {
    fs.closeSync(fd);
    throw error;
  }
}

function webEntry(entries, indexHtml) {
  const buildId = indexHtml.match(/<html\b[^>]*\bdata-build-id="([^"]+)"/i)?.[1];
  if (!buildId || buildId.length > 128) throw new Error("Claude Desktop web entry has no supported build identifier");
  const i18nLocales = [...entries.keys()]
    .map((member) => member.match(/^i18n\/([a-zA-Z]{2,3}(?:-[a-zA-Z0-9]{2,8})*)\.json$/)?.[1])
    .filter(Boolean)
    .sort();
  return { entries, indexHtml, buildId, i18nLocales };
}

// 解包目录里的单个文件：打开前后都得是同一个普通文件（不跟符号链接，打开期间没被换掉）。
function readUnpackedFile(filePath, maxBytes) {
  const before = fs.lstatSync(filePath);
  if (!before.isFile() || before.isSymbolicLink()) throw new Error("Claude Desktop ion-dist entry is not a regular file");
  const fd = fs.openSync(filePath, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.dev !== before.dev || stat.ino !== before.ino) {
      throw new Error("Claude Desktop ion-dist entry changed while opening");
    }
    if (stat.size > maxBytes) throw new Error("Claude Desktop ion-dist entry is too large");
    return stat.size ? readExactly(fd, stat.size, 0) : Buffer.alloc(0);
  } finally {
    fs.closeSync(fd);
  }
}

// 部分 Claude 版本不打 ion-dist.asar，而是把前端解包成 resources/ion-dist/ 目录。
// 只登记白名单内的普通文件；符号链接、Windows 目录联接和其它特殊文件一律跳过。
function readUnpacked(realResources) {
  const rootPath = path.join(realResources, "ion-dist");
  const rootStat = fs.lstatSync(rootPath);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
    throw new Error("Claude Desktop ion-dist is not a supported directory");
  }
  const entries = new Map();
  const walk = (directory, parent) => {
    for (const dirent of fs.readdirSync(directory, { withFileTypes: true })) {
      const name = dirent.name;
      if (!name || name === "." || name === ".." || /[/\\\0]/.test(name)) continue;
      const member = parent ? `${parent}/${name}` : name;
      const full = path.join(directory, name);
      const stat = fs.lstatSync(full);
      if (stat.isSymbolicLink()) continue;
      if (stat.isDirectory()) {
        // 根目录下只进白名单子目录（assets/ audio/ i18n/ images/）。
        if (parent || PUBLIC_ROOTS.includes(`${name}/`)) walk(full, member);
        continue;
      }
      if (!stat.isFile()) continue;
      if (!parent && !PUBLIC_FILES.has(name)) continue;
      if (entries.size >= MAX_UNPACKED_ENTRIES) throw new Error("Claude Desktop ion-dist has too many files");
      entries.set(member, { path: full, size: stat.size });
    }
  };
  walk(rootPath, "");

  const index = entries.get("index.html");
  if (!index || index.size > MAX_RESOURCE_BYTES) throw new Error("Claude Desktop ion-dist has no usable web entry");
  const indexHtml = readUnpackedFile(index.path, MAX_RESOURCE_BYTES).toString("utf8");
  return {
    ...webEntry(entries, indexHtml),
    archivePath: rootPath,
    readEntry: (entry) => readUnpackedFile(entry.path, MAX_RESOURCE_BYTES),
    close: () => {},
  };
}

function openArchive(resourcesDir) {
  const realResources = fs.realpathSync(resourcesDir);
  if (!fs.statSync(realResources).isDirectory()) throw new Error("Claude Desktop resources path is not a directory");
  // 有 asar 用 asar；没有时才退到解包目录（asar 存在但损坏照旧报错，不悄悄换来源）。
  if (fs.existsSync(path.join(realResources, "ion-dist.asar"))) return readAsar(realResources);
  if (fs.existsSync(path.join(realResources, "ion-dist"))) return readUnpacked(realResources);
  throw new Error(`Claude Desktop web resources not found: neither ion-dist.asar nor ion-dist/ in ${realResources}`);
}

function normalizeMember(pathname) {
  if (typeof pathname !== "string" || !pathname.startsWith("/") || pathname.includes("\0")) return null;
  let decoded;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    return null;
  }
  if (decoded !== pathname || decoded.includes("\\") || decoded.includes("\0")) return null;
  const parts = decoded.split("/");
  if (parts[0] !== "" || parts.slice(1).some((part) => !part || part === "." || part === "..")) return null;
  const member = parts.slice(1).join("/");
  if (!PUBLIC_FILES.has(member) && !PUBLIC_ROOTS.some((root) => member.startsWith(root))) return null;
  return member;
}

const COWORK_PROMPT_ANCHOR = Buffer.from("`<application_details>\\nClaude is operating as an agent inside the Claude desktop app.");
const MAX_APP_ARCHIVE_BYTES = 512 * 1024 * 1024;
const MAX_PROMPT_BYTES = 256 * 1024;
const TEMPLATE_ESCAPES = { n: "\n", r: "\r", t: "\t", b: "\b", f: "\f", v: "\v", "\\": "\\", "`": "`", "$": "$", "\n": "", "\r": "", "\r\n": "" };

function decodePromptLiteral(source) {
  const parts = [];
  let position = 0;
  for (const match of source.matchAll(/`|\$\{|\\(?:u\{([\da-fA-F]{1,6})\}|u([\da-fA-F]{4})|x([\da-fA-F]{2})|\r\n|[\s\S])/g)) {
    parts.push(source.slice(position, match.index));
    const [token, braced, fixed, byte] = match;
    if (token === "`") return parts.join("").trim();
    if (token === "${") return "";
    const hex = braced ?? fixed ?? byte;
    if (hex) {
      parts.push(String.fromCodePoint(parseInt(hex, 16)));
    } else {
      const escaped = token.slice(1);
      if (!Object.hasOwn(TEMPLATE_ESCAPES, escaped)) return "";
      parts.push(TEMPLATE_ESCAPES[escaped]);
    }
    position = match.index + token.length;
  }
  return "";
}

/**
 * 官方桌面端在原生 3P bootstrap 里通过 system_prompts.cowork_system_prompt 下发 Cowork
 * 的系统提示词。这里从本机 app.asar 里读出同一份文本，避免在开源仓库里重新分发官方文本。
 * 找不到时返回空串，由调用方决定如何兜底。
 */
export function loadCoworkSystemPrompt(resourcesDir, overrideFile) {
  if (overrideFile) {
    try {
      const prompt = readUnpackedFile(overrideFile, MAX_PROMPT_BYTES).toString("utf8").trim();
      if (prompt) return prompt;
    } catch {}
  }
  if (!resourcesDir) return "";
  try {
    const archivePath = path.join(fs.realpathSync(resourcesDir), "app.asar");
    const metadata = fs.lstatSync(archivePath);
    if (!metadata.isFile() || metadata.size > MAX_APP_ARCHIVE_BYTES) return "";
    const descriptor = fs.openSync(archivePath, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
    try {
      const stat = fs.fstatSync(descriptor);
      if (!stat.isFile() || stat.size !== metadata.size || stat.dev !== metadata.dev || stat.ino !== metadata.ino) return "";
      const chunkSize = 1024 * 1024;
      for (let start = 0; start + COWORK_PROMPT_ANCHOR.length <= stat.size; start += chunkSize - COWORK_PROMPT_ANCHOR.length + 1) {
        const buffer = readExactly(descriptor, Math.min(chunkSize, stat.size - start), start);
        const anchor = buffer.indexOf(COWORK_PROMPT_ANCHOR);
        if (anchor < 0) continue;
        const position = start + anchor + 1;
        return decodePromptLiteral(readExactly(descriptor, Math.min(MAX_PROMPT_BYTES, stat.size - position), position).toString("utf8"));
      }
    } finally {
      fs.closeSync(descriptor);
    }
  } catch {}
  return "";
}

export function createOfficialAssets(resourcesDir) {
  if (!resourcesDir) return null;
  const archive = openArchive(resourcesDir);
  let closed = false;
  return {
    archivePath: archive.archivePath,
    buildId: archive.buildId,
    indexHtml: archive.indexHtml,
    i18nLocales: archive.i18nLocales,
    read(pathname) {
      if (closed) return null;
      const member = normalizeMember(pathname);
      if (!member) return null;
      const entry = archive.entries.get(member);
      if (!entry || entry.size > MAX_RESOURCE_BYTES) return null;
      let body;
      try {
        body = archive.readEntry(entry);
      } catch {
        // 解包目录的文件可能在 Claude 更新时被删或被换：按缺失处理，不让代理崩。
        return null;
      }
      return {
        body,
        contentType: CONTENT_TYPES.get(path.extname(member).toLowerCase()) ?? "application/octet-stream",
        isHtml: member.endsWith(".html"),
        member,
      };
    },
    close() {
      if (closed) return;
      closed = true;
      archive.close();
    },
  };
}
