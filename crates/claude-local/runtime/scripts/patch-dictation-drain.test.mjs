import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  applyPatch,
  extractElectronCacheAsset,
  patchDictationBundle,
  restorePatch,
} from "./patch-dictation-drain.mjs";

const assetUrl = "https://assets-proxy.anthropic.com/claude-ai/v2/assets/v1/c342ae4ef-ROR3Yba4.js";
const assetKey = assetUrl.replace(/^https:\/\//, "");

function fixtureBundle() {
  return Buffer.from([
    'import{ph as e}from"./preload-helper-test.js";',
    'var D=2e3,A=6e4;',
    'function closeGracefully(){let c=this.thinkAloud,l=1,u=setTimeout(f,c?A:D+l);',
    'this.ws.send(JSON.stringify({type:"CloseStream"}))}',
    'i==="TranscriptEndpoint"',
  ].join(""));
}

function fixtureElectronEntry(body) {
  return Buffer.concat([
    Buffer.from(`1/0/${assetUrl}`, "ascii"),
    body,
    Buffer.from(`\0HTTP/1.1 200 OK\0content-length: ${body.length}\0`, "ascii"),
  ]);
}

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "claude-local-dictation-"));
}

test("patch changes only the normal drain timeout and preserves thinkAloud timeout logic", () => {
  const original = fixtureBundle();
  const patched = patchDictationBundle(original);
  assert.equal(patched.length, original.length + 2);
  assert.match(patched.toString(), /D=125e3,A=6e4/);
  assert.match(patched.toString(), /c\?A:D\+l/);
  assert.equal(patchDictationBundle(patched).equals(patched), true);
  const previousPatch = Buffer.from(original.toString().replace("D=2e3", "D=3e4"));
  assert.match(patchDictationBundle(previousPatch).toString(), /D=125e3,A=6e4/);
});

test("patch refuses an unknown bundle or ambiguous timeout", () => {
  assert.throws(() => patchDictationBundle(Buffer.from("D=2e3")), /does not match/);
  const duplicate = Buffer.concat([fixtureBundle(), Buffer.from("D=2e3")]);
  assert.throws(() => patchDictationBundle(duplicate), /unexpected drain timeout/);
});

test("Electron cache extraction validates URL and HTTP body length", () => {
  const body = fixtureBundle();
  assert.deepEqual(extractElectronCacheAsset(fixtureElectronEntry(body)), body);
  assert.throws(() => extractElectronCacheAsset(fixtureElectronEntry(body), `${assetUrl}?different=1`), /exactly one/);
  assert.throws(() => extractElectronCacheAsset(Buffer.from(`1/0/${assetUrl}short\0HTTP/1.1 200 OK\0content-length: 9999\0`)), /bounds/);
});

test("local asset patch is idempotent and reversible", async () => {
  const root = tempDir();
  try {
    const cacheDir = path.join(root, "proxy-cache");
    const electronCacheDir = path.join(root, "electron-cache");
    fs.mkdirSync(electronCacheDir);
    fs.writeFileSync(path.join(electronCacheDir, "entry_0"), fixtureElectronEntry(fixtureBundle()));

    assert.equal(await applyPatch({ cacheDir, electronCacheDir }), "patched");
    assert.equal(await applyPatch({ cacheDir, electronCacheDir }), "already-patched");
    const assetName = crypto.createHash("sha1").update(assetKey).digest("hex");
    const assetPath = path.join(cacheDir, assetName);
    const patched = fs.readFileSync(assetPath);
    assert.match(patched.toString(), /D=125e3,A=6e4/);
    assert.equal(restorePatch({ cacheDir }), "restored");
    assert.deepEqual(fs.readFileSync(assetPath), fixtureBundle());
    assert.equal(await applyPatch({ cacheDir, electronCacheDir }), "patched");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("missing Electron cache asset downloads, validates, patches, and retains a reversible original", async () => {
  const root = tempDir();
  try {
    const cacheDir = path.join(root, "proxy-cache");
    const electronCacheDir = path.join(root, "electron-cache");
    let requestedUrl = "";
    const original = fixtureBundle();
    const fetchAsset = async (url) => {
      requestedUrl = url;
      return new Response(original, {
        status: 200,
        headers: { "content-type": "text/javascript; charset=utf-8" },
      });
    };

    assert.equal(await applyPatch({ cacheDir, electronCacheDir, fetchAsset }), "patched");
    assert.equal(requestedUrl, assetUrl);
    const assetName = crypto.createHash("sha1").update(assetKey).digest("hex");
    const assetPath = path.join(cacheDir, assetName);
    const backupPath = path.join(cacheDir, ".dictation-drain-backup", assetName);
    assert.match(fs.readFileSync(assetPath, "utf8"), /D=125e3,A=6e4/);
    assert.deepEqual(fs.readFileSync(backupPath), original);
    assert.equal(restorePatch({ cacheDir }), "restored");
    assert.deepEqual(fs.readFileSync(assetPath), original);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("an unsupported downloaded drain asset is refused without writing cache files", async () => {
  const root = tempDir();
  try {
    const cacheDir = path.join(root, "proxy-cache");
    const fetchAsset = async () => new Response("unsupported asset", {
      status: 200,
      headers: { "content-type": "text/javascript; charset=utf-8" },
    });
    await assert.rejects(
      applyPatch({ cacheDir, electronCacheDir: path.join(root, "missing-electron-cache"), fetchAsset }),
      /does not match/,
    );
    assert.equal(fs.existsSync(cacheDir), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("local asset cache upgrades the previous 30-second patch without replacing its backup", async () => {
  const root = tempDir();
  try {
    const cacheDir = path.join(root, "proxy-cache");
    fs.mkdirSync(cacheDir);
    const assetName = crypto.createHash("sha1").update(assetKey).digest("hex");
    const assetPath = path.join(cacheDir, assetName);
    const previousPatch = Buffer.from(fixtureBundle().toString().replace("D=2e3", "D=3e4"));
    const metadata = {
      status: 200,
      headers: { "content-type": "text/javascript; charset=utf-8" },
      url: assetKey,
    };
    fs.writeFileSync(assetPath, previousPatch);
    fs.writeFileSync(`${assetPath}.json`, JSON.stringify(metadata));

    assert.equal(await applyPatch({ cacheDir, electronCacheDir: path.join(root, "unused") }), "updated");
    assert.match(fs.readFileSync(assetPath, "utf8"), /D=125e3,A=6e4/);
    assert.equal(restorePatch({ cacheDir }), "restored");
    assert.deepEqual(fs.readFileSync(assetPath), fixtureBundle());
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
