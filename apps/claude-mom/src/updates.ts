/**
 * 自动更新：GitHub Release 上的 latest.json（tauri-action 生成，带签名），由 Tauri updater 校验后安装。
 * 启动时静默查一次；有新版本就在状态栏提示，「Claude 设置 → 版本与更新」里可手动检查与安装。
 */
import { getVersion } from "@tauri-apps/api/app";
import { relaunch } from "@tauri-apps/plugin-process";
import { check, type Update } from "@tauri-apps/plugin-updater";

export type UpdateState =
  | { phase: "idle" }
  | { phase: "checking" }
  | { phase: "latest"; version: string }
  | { phase: "available"; version: string; notes: string; update: Update }
  | { phase: "downloading"; version: string; percent: number | null }
  | { phase: "failed"; message: string };

export async function currentVersion(): Promise<string> {
  try {
    return await getVersion();
  } catch {
    return "";
  }
}

export async function checkForUpdate(): Promise<UpdateState> {
  try {
    const update = await check();
    if (!update) return { phase: "latest", version: await currentVersion() };
    return { phase: "available", version: update.version, notes: update.body ?? "", update };
  } catch (cause) {
    return { phase: "failed", message: cause instanceof Error ? cause.message : String(cause) };
  }
}

/** 下载并安装，然后重启。安装前本地服务会随程序退出而停止，Claude 下次启动时重新接上。 */
export async function installUpdate(update: Update, onProgress: (percent: number | null) => void): Promise<void> {
  let total = 0;
  let received = 0;
  await update.downloadAndInstall((event) => {
    if (event.event === "Started") {
      total = event.data.contentLength ?? 0;
      onProgress(total ? 0 : null);
    } else if (event.event === "Progress") {
      received += event.data.chunkLength;
      onProgress(total ? Math.min(100, Math.round((received / total) * 100)) : null);
    }
  });
  await relaunch();
}
