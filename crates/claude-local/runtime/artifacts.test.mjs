import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createArtifactService, frameShortId } from "./artifacts.mjs";

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "claude-artifacts-"));
  const artifactRoot = path.join(root, "typed-artifacts");
  const frameRoot = path.join(root, "frame-runtime");
  fs.mkdirSync(path.join(frameRoot, "templates"), { recursive: true });
  fs.mkdirSync(path.join(frameRoot, "runtime", "v1"), { recursive: true });
  fs.writeFileSync(path.join(frameRoot, "templates", "design.json"), JSON.stringify({ ver: "v1", files: [] }));
  fs.writeFileSync(path.join(frameRoot, "runtime", "v1", "_files.json"), JSON.stringify({ files: {} }));
  return { root, artifactRoot, frameRoot };
}

function fakeRes() {
  const res = {
    status: 0,
    headers: {},
    body: Buffer.alloc(0),
    writeHead(status, headers) { res.status = status; res.headers = headers; },
    end(body) { res.body = Buffer.isBuffer(body) ? body : Buffer.from(String(body || ""), "utf8"); },
  };
  return res;
}

test("create → publish → list → document", () => {
  const { artifactRoot, frameRoot } = fixture();
  const service = createArtifactService({ artifactRoot, frameRoot, origin: "https://claude.ai" });
  const { id } = service.artifacts.createArtifact("bcd2878f-a88d-4094-a616-8e39d8a5fd8a", "测试作品");
  assert.match(id, /^[0-9a-f-]{36}$/);
  service.artifacts.publishVersion(id, [{ path: "project/index.html", content: "<h1>hi</h1>", content_type: "text/html" }]);
  const rows = service.artifacts.listArtifacts();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].title, "测试作品");
  assert.equal(rows[0].type_title, "Design");
  assert.equal(rows[0].versionCount, 2);
  assert.equal(rows[0].hasFiles, true);
  const doc = service.artifacts.frameDocument(id);
  assert.equal(doc.id, id);
  assert.ok(doc.files.some((file) => file.path === "project/index.html"));
  assert.equal(doc.viewerPath, `/artifact/${frameShortId(id)}`);
});

test("publish merges files and bumps versions", () => {
  const { artifactRoot, frameRoot } = fixture();
  const service = createArtifactService({ artifactRoot, frameRoot });
  const { id } = service.artifacts.createArtifact("design", "T");
  service.artifacts.publishVersion(id, [{ path: "project/a.html", content: "a" }]);
  service.artifacts.publishVersion(id, [{ path: "project/b.html", content: "b" }], { remove: ["project/a.html"] });
  const doc = JSON.parse(fs.readFileSync(path.join(artifactRoot, id, "artifact.json"), "utf8"));
  const latest = doc.versions[doc.versions.length - 1];
  assert.deepEqual(latest.files.map((entry) => entry[0]), ["project/b.html"]);
  assert.equal(doc.versions.length, 3);
});

test("chat tools carry the official MCP names and execute", () => {
  const { artifactRoot, frameRoot } = fixture();
  const service = createArtifactService({ artifactRoot, frameRoot });
  const names = service.chatTools().map((tool) => tool.name);
  assert.ok(names.includes("mcp__claude-artifacts__create_from_type"));
  assert.ok(names.includes("mcp__claude-artifacts__publish_version"));
  const created = service.runChatTool("mcp__claude-artifacts__create_from_type", {
    type_slug: "3e9dc3d6-8a10-4143-ac0b-5af4f2b03a61", title: "Deck",
  });
  assert.equal(created.ok, true);
  assert.ok(created.artifact?.id);
  const published = service.runChatTool("mcp__claude-artifacts__publish_version", {
    slug: created.artifact.id, files: [{ path: "project/deck.json", content: "{}" }],
  });
  assert.equal(published.ok, true);
  const listed = service.runChatTool("mcp__claude-artifacts__list_artifacts", {});
  assert.equal(listed.ok, true);
  assert.match(listed.text, /Deck/);
});

test("frame content host serves the manifest and project files", () => {
  const { artifactRoot, frameRoot } = fixture();
  const service = createArtifactService({ artifactRoot, frameRoot });
  const { id } = service.artifacts.createArtifact("design", "T");
  service.artifacts.publishVersion(id, [{ path: "project/canvas.json", content: "{\"v\":3}", content_type: "application/json" }]);

  const manifestRes = fakeRes();
  service.handleFrameHost({ method: "GET", headers: {} }, manifestRes, new URL(`https://${id}.claudeusercontent.com/_f/v1/_files.json`), `${id}.claudeusercontent.com`);
  assert.equal(manifestRes.status, 200);
  const manifest = JSON.parse(manifestRes.body.toString("utf8"));
  assert.ok(manifest.files["project/canvas.json"]);

  const fileRes = fakeRes();
  service.handleFrameHost({ method: "GET", headers: {} }, fileRes, new URL(`https://${id}.claudeusercontent.com/_f/v1/project/canvas.json`), `${id}.claudeusercontent.com`);
  assert.equal(fileRes.status, 200);
  assert.equal(fileRes.body.toString("utf8"), "{\"v\":3}");
});

test("frame API lists typed artifacts and creates from a type", async () => {  const { artifactRoot, frameRoot } = fixture();
  const service = createArtifactService({ artifactRoot, frameRoot });
  service.artifacts.createArtifact("design", "Existing");
  const listRes = fakeRes();
  assert.equal(service.handleFrameApi("GET", new URL("https://claude.ai/api/frame/artifacts"), {}, listRes), true);
  const list = JSON.parse(listRes.body.toString("utf8"));
  assert.equal(list.artifacts.length, 1);
  assert.equal(list.artifacts[0].title, "Existing");

  const createRes = fakeRes();
  const req = { on(event, fn) { if (event === "data") fn(Buffer.from(JSON.stringify({ title: "New" }))); if (event === "end") fn(); } };
  assert.equal(service.handleFrameApi("POST", new URL("https://claude.ai/api/frame/types/bcd2878f-a88d-4094-a616-8e39d8a5fd8a/create"), req, createRes), true);
  await new Promise((resolve) => setTimeout(resolve, 10));
  const created = JSON.parse(createRes.body.toString("utf8"));
  assert.ok(created.slug);
  assert.equal(service.artifacts.listArtifacts().length, 2);
});

test("panel endpoint, preview HTML and injection", async () => {
  const { artifactRoot, frameRoot } = fixture();
  const service = createArtifactService({ artifactRoot, frameRoot });
  const { id } = service.artifacts.createArtifact("design", "Preview");
  service.artifacts.publishVersion(id, [{ path: "project/index.html", content: "<!doctype html><h1>preview</h1>" }]);

  const rawRes = fakeRes();
  assert.equal(service.handleLocalApi("GET", new URL(`https://claude.ai/__claude_local/artifacts/${id}/raw`), {}, rawRes), true);
  assert.equal(rawRes.status, 200);
  assert.match(rawRes.body.toString("utf8"), /preview/);

  const listRes = fakeRes();
  service.handleLocalApi("GET", new URL("https://claude.ai/__claude_local/artifacts"), {}, listRes);
  assert.equal(JSON.parse(listRes.body.toString("utf8")).artifacts.length, 1);

  const panelRes = fakeRes();
  service.handleLocalApi("GET", new URL("https://claude.ai/__claude_local/artifacts/panel.js"), {}, panelRes);
  assert.match(panelRes.body.toString("utf8"), /claudeLocalArtifacts/);

  const html = service.injectPanel("<html><head><title>x</title></head><body></body></html>");
  assert.match(html, /panel\.js/);
  assert.equal(service.injectPanel(html), html);
});

test("type slugs accept bare names", () => {
  const { artifactRoot, frameRoot } = fixture();
  const service = createArtifactService({ artifactRoot, frameRoot });
  const deck = service.artifacts.createArtifact("slides", "Deck by name");
  const meta = JSON.parse(fs.readFileSync(path.join(artifactRoot, deck.id, "desktop.json"), "utf8"));
  assert.equal(meta.type, "slides");
  const canvas = service.artifacts.createArtifact("bcd2878f-a88d-4094-a616-8e39d8a5fd8a", "Design by slug");
  const meta2 = JSON.parse(fs.readFileSync(path.join(artifactRoot, canvas.id, "desktop.json"), "utf8"));
  assert.equal(meta2.type, "design");
});

// ── 画廊契约（官方 zw/Vw 校验与 rel 语义）────────────────────

test("gallery rows carry the official contract fields", () => {
  const { artifactRoot, frameRoot } = fixture();
  const service = createArtifactService({ artifactRoot, frameRoot, localAccount: { uuid: "acct-1", name: "You", email: "you@local" } });
  const { id } = service.artifacts.createArtifact("design", "Contract");
  service.artifacts.publishVersion(id, [{ path: "project/index.html", content: "<p>x</p>" }]);

  const res = fakeRes();
  assert.equal(service.handleFrameApi("GET", new URL("https://claude.ai/api/frame/artifacts?rel=mine&org=o1"), {}, res), true);
  const page = JSON.parse(res.body.toString("utf8"));
  assert.ok(Array.isArray(page.artifacts));
  assert.equal(page.next_page_token, undefined);
  const row = page.artifacts.find((r) => r.id === id);
  assert.equal(typeof row.id, "string");
  assert.equal(typeof row.title, "string");
  assert.equal(row.rel, "mine");
  assert.equal(row.kind, "page");
  assert.equal(row.soft_deleted, false);
  assert.equal(row.empty, false);
  assert.equal(row.renamable, true);
  assert.equal(row.duplicable, true);
  assert.equal(typeof row.type_slug, "string");
  assert.equal(row.type_title, "Design");
});

test("rel filters: favorited by starred, mine excludes nothing, q matches title", () => {
  const { artifactRoot, frameRoot } = fixture();
  const service = createArtifactService({ artifactRoot, frameRoot });
  const a = service.artifacts.createArtifact("design", "Alpha design");
  const b = service.artifacts.createArtifact("slides", "Beta deck");
  service.artifacts.publishVersion(b.id, [{ path: "project/deck.json", content: "{}" }]);
  assert.equal(service.artifacts.setStarred(b.id, true), true);

  const favRes = fakeRes();
  service.handleFrameApi("GET", new URL("https://claude.ai/api/frame/artifacts?rel=favorited&org=o1"), {}, favRes);
  const fav = JSON.parse(favRes.body.toString("utf8")).artifacts;
  assert.equal(fav.length, 1);
  assert.equal(fav[0].id, b.id);

  const qRes = fakeRes();
  service.handleFrameApi("GET", new URL("https://claude.ai/api/frame/artifacts?rel=all&q=alpha&org=o1"), {}, qRes);
  const qRows = JSON.parse(qRes.body.toString("utf8")).artifacts;
  assert.equal(qRows.length, 1);
  assert.equal(qRows[0].id, a.id);

  const typeRes = fakeRes();
  service.handleFrameApi("GET", new URL(`https://claude.ai/api/frame/artifacts?rel=all&type=${encodeURIComponent("3e9dc3d6-8a10-4143-ac0b-5af4f2b03a61")}&org=o1`), {}, typeRes);
  const typeRows = JSON.parse(typeRes.body.toString("utf8")).artifacts;
  assert.equal(typeRows.length, 1);
  assert.equal(typeRows[0].id, b.id);
});

test("frames endpoint serves viewed rows and probe-safe empty shape", () => {
  const { artifactRoot, frameRoot } = fixture();
  const service = createArtifactService({ artifactRoot, frameRoot });
  const { id } = service.artifacts.createArtifact("design", "Viewed");
  service.artifacts.touchViewed(id);

  const res = fakeRes();
  service.handleFrameApi("GET", new URL("https://claude.ai/api/frame/frames?rel=viewed&empty=exclude&thumb=1&limit=60&org=o1"), {}, res);
  assert.equal(res.status, 200);
  const page = JSON.parse(res.body.toString("utf8"));
  assert.ok(Array.isArray(page.frames));
  assert.equal(page.frames[0].slug, id);

  const emptyRes = fakeRes();
  service.handleFrameApi("GET", new URL("https://claude.ai/api/frame/frames?rel=viewed&type=00000000-0000-0000-0000-000000000000&org=o1"), {}, emptyRes);
  assert.equal(emptyRes.status, 200);
  assert.deepEqual(JSON.parse(emptyRes.body.toString("utf8")).frames, []);
});

test("frames/external feeds the sidebar recents shape", () => {
  const { artifactRoot, frameRoot } = fixture();
  const service = createArtifactService({ artifactRoot, frameRoot });
  service.artifacts.createArtifact("design", "Recent");
  const res = fakeRes();
  service.handleFrameApi("GET", new URL("https://claude.ai/api/frame/frames/external?org=o1"), {}, res);
  const page = JSON.parse(res.body.toString("utf8"));
  assert.ok(Array.isArray(page.frames));
  const row = page.frames[0];
  for (const key of ["id", "title", "icon", "tint", "type_slug", "type_title", "created_at"]) {
    assert.ok(row[key] !== undefined, `missing ${key}`);
  }
});

test("favorite returns 204 and persists; retitle rewrites title", async () => {
  const { artifactRoot, frameRoot } = fixture();
  const service = createArtifactService({ artifactRoot, frameRoot });
  const { id } = service.artifacts.createArtifact("design", "Fav");

  const favRes = fakeRes();
  service.handleFrameApi("POST", new URL(`https://claude.ai/api/frame/favorite/${id}?org=o1`), {}, favRes);
  assert.equal(favRes.status, 204);
  const meta = JSON.parse(fs.readFileSync(path.join(artifactRoot, id, "desktop.json"), "utf8"));
  assert.equal(meta.starred, true);

  const unfavRes = fakeRes();
  service.handleFrameApi("DELETE", new URL(`https://claude.ai/api/frame/favorite/${id}?org=o1`), {}, unfavRes);
  assert.equal(unfavRes.status, 204);

  const retitleReq = { on(event, fn) { if (event === "data") fn(Buffer.from(JSON.stringify({ title: "Renamed" }))); if (event === "end") fn(); } };
  const retitleRes = fakeRes();
  service.handleFrameApi("POST", new URL(`https://claude.ai/api/frame/retitle/${id}?org=o1`), retitleReq, retitleRes);
  await new Promise((resolve) => setTimeout(resolve, 10));
  const doc = JSON.parse(retitleRes.body.toString("utf8"));
  assert.equal(doc.title, "Renamed");
  assert.equal(JSON.parse(fs.readFileSync(path.join(artifactRoot, id, "desktop.json"), "utf8")).title, "Renamed");
});

test("duplicate copies the artifact under a new id", () => {
  const { artifactRoot, frameRoot } = fixture();
  const service = createArtifactService({ artifactRoot, frameRoot });
  const { id } = service.artifacts.createArtifact("design", "Original");
  service.artifacts.publishVersion(id, [{ path: "project/index.html", content: "<p>keep</p>" }]);

  const res = fakeRes();
  service.handleFrameApi("POST", new URL(`https://claude.ai/api/frame/duplicate/${id}?org=o1`), {}, res);
  const doc = JSON.parse(res.body.toString("utf8"));
  assert.notEqual(doc.id, id);
  assert.equal(JSON.parse(fs.readFileSync(path.join(artifactRoot, doc.id, "desktop.json"), "utf8")).title, "Original (copy)");
  assert.equal(service.artifacts.listArtifacts().length, 2);
});

test("self endpoint persists artifact state; track/lookup are silent helpers", async () => {
  const { artifactRoot, frameRoot } = fixture();
  const service = createArtifactService({ artifactRoot, frameRoot });
  const { id } = service.artifacts.createArtifact("design", "State");
  const body = JSON.stringify({ ui: { scroll: 12 }, baseVersion: "v3", token: "t" });

  const selfRes = fakeRes();
  const selfReq = { on(event, fn) { if (event === "data") fn(Buffer.from(body)); if (event === "end") fn(); } };
  assert.equal(service.handleFrameApi("POST", new URL(`https://claude.ai/api/frame/self/${id}?org=o1`), selfReq, selfRes), true);
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(selfRes.status, 200);
  const state = JSON.parse(fs.readFileSync(path.join(artifactRoot, id, "state.json"), "utf8"));
  assert.equal(state.ui.scroll, 12);
  assert.equal(state.baseVersion, undefined);

  const trackRes = fakeRes();
  const trackReq = { on(event, fn) { if (event === "data") fn(Buffer.from("{}")); if (event === "end") fn(); } };
  assert.equal(service.handleFrameApi("POST", new URL("https://claude.ai/api/frame/track?org=o1"), trackReq, trackRes), true);
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(trackRes.status, 200);

  const lookupRes = fakeRes();
  const lookupReq = { on(event, fn) { if (event === "data") fn(Buffer.from(JSON.stringify({ ids: [id] }))); if (event === "end") fn(); } };
  assert.equal(service.handleFrameApi("POST", new URL(`https://claude.ai/api/frame/artifact/lookup/${id}?org=o1`), lookupReq, lookupRes), true);
  await new Promise((resolve) => setTimeout(resolve, 10));
  const hits = JSON.parse(lookupRes.body.toString("utf8"));
  assert.deepEqual(hits.hits.map((h) => h.id), [id]);
  assert.equal(hits.cursor, null);
});

test("management minimal answers: perm/activity/comments/participants/access-requests", () => {
  const { artifactRoot, frameRoot } = fixture();
  const service = createArtifactService({ artifactRoot, frameRoot });

  const permRes = fakeRes();
  service.handleFrameApi("GET", new URL("https://claude.ai/api/frame/perm/abc123?org=o1"), {}, permRes);
  const perm = JSON.parse(permRes.body.toString("utf8"));
  assert.equal(perm.access, "write");
  assert.deepEqual(perm.people, []);

  const activityRes = fakeRes();
  service.handleFrameApi("GET", new URL("https://claude.ai/api/frame/activity/abc123?org=o1"), {}, activityRes);
  const activity = JSON.parse(activityRes.body.toString("utf8"));
  assert.equal(activity.views, 0);
  assert.ok(Array.isArray(activity.weekly));

  const commentsRes = fakeRes();
  service.handleFrameApi("GET", new URL("https://claude.ai/api/frame/comments/abc123?org=o1"), {}, commentsRes);
  assert.deepEqual(JSON.parse(commentsRes.body.toString("utf8")).comments, []);

  const arRes = fakeRes();
  service.handleFrameApi("GET", new URL("https://claude.ai/api/frame/access-requests/abc123?org=o1"), {}, arRes);
  const ar = JSON.parse(arRes.body.toString("utf8"));
  assert.deepEqual(ar.pending, []);
  assert.equal(ar.guest_pending_incomplete, false);
});
