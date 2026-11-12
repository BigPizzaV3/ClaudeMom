#!/usr/bin/env node
// 发版：node scripts/release.mjs X.Y.Z [--dry-run]
//
// 先在 CHANGELOG.md 顶部写好「## X.Y.Z - YYYY-MM-DD」一节（它就是 Release 说明），然后：
// 改版本号（Cargo workspace、tauri.conf.json、package.json）→ 提交「release: vX.Y.Z」→ 打 tag → 推送。
// 推 tag 后 GitHub Actions（.github/workflows/release.yml）构建 macOS / Windows 并发布。
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const [version] = process.argv.slice(2).filter((arg) => !arg.startsWith("--"));
const dryRun = process.argv.includes("--dry-run");
if (!/^\d+\.\d+\.\d+$/.test(version ?? "")) {
  console.error("用法：node scripts/release.mjs X.Y.Z [--dry-run]");
  process.exit(1);
}
const git = (...args) => execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
if (git("status", "--porcelain", "--untracked-files=no")) {
  console.error("工作区有未提交的改动，先提交或还原。");
  process.exit(1);
}
const changelog = readFileSync(path.join(root, "CHANGELOG.md"), "utf8");
if (!new RegExp(`^## ${version.replaceAll(".", "\\.")} `, "m").test(changelog)) {
  console.error(`CHANGELOG.md 里没有「## ${version} - 日期」这一节。`);
  process.exit(1);
}

const edits = [
  ["Cargo.toml", (text) => text.replace(/(\[workspace\.package\][^[]*?\nversion = ")[^"]+(")/, `$1${version}$2`)],
  ["apps/claude-mom/src-tauri/tauri.conf.json", (text) => text.replace(/("version":\s*")[^"]+(")/, `$1${version}$2`)],
  ["apps/claude-mom/package.json", (text) => text.replace(/("version":\s*")[^"]+(")/, `$1${version}$2`)],
];
for (const [file, edit] of edits) {
  const full = path.join(root, file);
  const before = readFileSync(full, "utf8");
  const after = edit(before);
  if (after === before && !before.includes(`"${version}"`) && !before.includes(`version = "${version}"`)) {
    console.error(`没能在 ${file} 里改到版本号`);
    process.exit(1);
  }
  console.log(`${dryRun ? "[预览] " : ""}${file} → ${version}`);
  if (!dryRun) writeFileSync(full, after);
}
if (dryRun) process.exit(0);
// 同步 Cargo.lock 里本仓库包的版本号。
execFileSync("cargo", ["update", "--workspace", "--offline"], { cwd: root, stdio: "inherit" });
git("add", "Cargo.toml", "Cargo.lock", "apps/claude-mom/src-tauri/tauri.conf.json", "apps/claude-mom/package.json");
git("commit", "-m", `release: v${version}`);
git("tag", `v${version}`);
execFileSync("git", ["push", "--atomic", "origin", "HEAD", `v${version}`], { cwd: root, stdio: "inherit" });
console.log(`已推送 v${version}，GitHub Actions 开始构建：https://github.com/BigPizzaV3/ClaudeMom/actions`);
