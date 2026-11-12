#!/usr/bin/env node
// 本地构建并重启 ClaudeMom（macOS）。
//
//   node scripts/relaunch-local.mjs              # 构建前端 + release，打包 .app，结束旧实例，启动新实例
//   node scripts/relaunch-local.mjs --skip-build # 不构建，直接重启现有 .app
//
// 启动时剥掉会话里的 CLAUDE_CODE_* / ANTHROPIC_* / 代理变量：open 会把调用方的环境带给应用，
// 漏进去会让内置 Claude Code 绕过本地服务直连官方（401）。
import { execFileSync, spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const appDir = path.join(root, "apps", "claude-mom");
const bundle = path.join(root, "target", "release", "bundle", "macos", "ClaudeMom.app");
const skipBuild = process.argv.includes("--skip-build");

const run = (command, args, options = {}) => {
  console.log(`$ ${command} ${args.join(" ")}`);
  execFileSync(command, args, { stdio: "inherit", ...options });
};

if (!skipBuild) {
  // 自动更新包要用更新签名私钥：本机有（~/.tauri/claude-mom-updater.key）就用，没有就不出更新包。
  const keyFile = path.join(process.env.HOME ?? "", ".tauri", "claude-mom-updater.key");
  const passwordFile = `${keyFile.replace(/\.key$/, "")}.password`;
  const signing = existsSync(keyFile)
    ? {
        TAURI_SIGNING_PRIVATE_KEY: readFileSync(keyFile, "utf8"),
        TAURI_SIGNING_PRIVATE_KEY_PASSWORD: existsSync(passwordFile) ? readFileSync(passwordFile, "utf8").trim() : "",
      }
    : null;
  const args = ["tauri", "build", "--bundles", "app"];
  if (!signing) args.push("--config", JSON.stringify({ bundle: { createUpdaterArtifacts: false } }));
  run("npx", args, {
    cwd: appDir,
    env: { ...process.env, ...(signing ?? {}), PATH: `${process.env.HOME}/.cargo/bin:${process.env.PATH}` },
  });
}
if (!existsSync(bundle)) {
  console.error(`找不到 ${bundle}，先去掉 --skip-build 构建一次。`);
  process.exit(1);
}

// 只结束这个 bundle 里的主程序（关掉它会顺带停止本地服务；Claude 会在下次启动时重新接上）。
try {
  execFileSync("pkill", ["-f", `${bundle}/Contents/MacOS/claude-mom`]);
  execFileSync("sleep", ["1"]);
} catch {
  // 没有在跑
}

const env = Object.fromEntries(
  Object.entries(process.env).filter(([name]) => !/^(CLAUDE_CODE_|CLAUDECODE$|ANTHROPIC_|(HTTPS?|ALL|NO)_PROXY$)/i.test(name)),
);
spawn("open", ["-n", bundle], { detached: true, stdio: "ignore", env }).unref();
console.log(`已启动：${bundle}`);
