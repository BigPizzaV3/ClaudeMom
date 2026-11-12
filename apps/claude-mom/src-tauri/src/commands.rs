//! ClaudeMom 的命令：Claude 状态 / 启动 / 设置（转给 claude-local），上游管理与导入，听写模型。

use std::sync::Mutex;

use crate::upstreams::{self as claude_mom, UpstreamBook, UpstreamModel, UpstreamProfile};
use serde::Serialize;

use serde_json::{Value, json};

/// 命令统一返回 `{status, message, ...payload}`（payload 平铺到顶层，前端按这个形状读）。
#[derive(Debug, Serialize)]
pub struct CommandResult<T: Serialize> {
    pub status: String,
    pub message: String,
    #[serde(flatten)]
    pub payload: T,
}

pub fn ok<T: Serialize>(message: &str, payload: T) -> CommandResult<T> {
    CommandResult { status: "ok".into(), message: message.into(), payload }
}

pub fn failed<T: Serialize>(message: &str, payload: T) -> CommandResult<T> {
    CommandResult { status: "failed".into(), message: message.into(), payload }
}

/// 读-改-写上游列表时串行，避免两次保存互相覆盖。
static BOOK_LOCK: Mutex<()> = Mutex::new(());

/// payload 必须是结构体：`CommandResult` 会把它 flatten 到顶层，数组没法 flatten。
#[derive(Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BookPayload {
    profiles: Vec<UpstreamProfile>,
    active_id: Option<String>,
}

impl From<UpstreamBook> for BookPayload {
    fn from(book: UpstreamBook) -> Self {
        Self { profiles: book.profiles, active_id: book.active_id }
    }
}

#[derive(Debug, Default, Serialize)]
pub struct ModelsPayload {
    models: Vec<UpstreamModel>,
}

fn load() -> anyhow::Result<UpstreamBook> {
    claude_mom::load_book(&claude_mom::default_book_path())
}

/// 改上游列表并存盘，然后把选中的那组交给 Claude 本地服务。
fn mutate<T>(change: impl FnOnce(&mut UpstreamBook) -> anyhow::Result<T>) -> anyhow::Result<(UpstreamBook, T)> {
    let _guard = BOOK_LOCK.lock().unwrap_or_else(|error| error.into_inner());
    let mut book = load()?;
    let value = change(&mut book)?;
    claude_mom::save_book(&claude_mom::default_book_path(), &book)?;
    Ok((book, value))
}

fn respond<T>(result: anyhow::Result<(UpstreamBook, T)>, message: impl FnOnce(T) -> String, failure: &str) -> CommandResult<BookPayload> {
    match result {
        Ok((book, value)) => ok(&message(value), book.into()),
        Err(error) => failed(&format!("{failure}：{error:#}"), load().unwrap_or_default().into()),
    }
}



#[tauri::command]
pub fn claude_mom_load() -> CommandResult<BookPayload> {
    match load() {
        Ok(book) => ok("已读取上游。", book.into()),
        Err(error) => failed(&format!("{error:#}"), BookPayload::default()),
    }
}

/// 新增（id 为空）或更新一组；`activate` 为真时同时设为当前。
#[tauri::command]
pub fn claude_mom_save_profile(profile: UpstreamProfile, activate: Option<bool>) -> CommandResult<BookPayload> {
    let result = mutate(|book| {
        let id = book.upsert(profile);
        if activate.unwrap_or(false) {
            book.active_id = Some(id.clone());
        }
        Ok(book.profiles.iter().find(|item| item.id == id).map(|item| item.name.clone()).unwrap_or_default())
    });
    respond(result, |name| format!("已保存「{name}」。"), "保存上游失败")
}

#[tauri::command]
pub fn claude_mom_delete_profile(id: String) -> CommandResult<BookPayload> {
    let result = mutate(|book| {
        let name = book.profiles.iter().find(|item| item.id == id).map(|item| item.name.clone()).unwrap_or_default();
        book.remove(&id);
        Ok(name)
    });
    respond(result, |name| format!("已删除「{name}」。"), "删除上游失败")
}

#[tauri::command]
pub fn claude_mom_set_active(id: String) -> CommandResult<BookPayload> {
    let result = mutate(|book| {
        let name = book
            .profiles
            .iter()
            .find(|item| item.id == id)
            .map(|item| item.name.clone())
            .ok_or_else(|| anyhow::anyhow!("这组上游已经不在了"))?;
        book.active_id = Some(id.clone());
        Ok(name)
    });
    respond(result, |name| format!("已切换到「{name}」，重新启动 Claude 后生效。"), "切换上游失败")
}

/// 从其他工具导入：`ccswitch` / `magpie` / `codexpp`。网关类来源（Magpie、Codex++）没有模型时顺手拉一次。
#[tauri::command]
pub async fn claude_mom_import(source: String) -> CommandResult<BookPayload> {
    let imported = match source.as_str() {
        claude_mom::SOURCE_CC_SWITCH => claude_mom::cc_switch_profiles(&claude_mom::default_cc_switch_db()),
        claude_mom::SOURCE_MAGPIE => Ok(vec![claude_mom::magpie_profile(
            &claude_mom::default_magpie_dir(),
            std::env::var("MAGPIE_ADDR").ok().as_deref(),
        )]),
        claude_mom::SOURCE_CODEX_PLUS_PLUS => {
            claude_mom::codex_plus_plus_profile(&claude_mom::codex_plus_plus_state_dir()).map(|profile| vec![profile])
        }
        other => Err(anyhow::anyhow!("未知的导入来源：{other}")),
    };
    let mut imported = match imported {
        Ok(imported) => imported,
        Err(error) => return failed(&format!("{error:#}"), load().unwrap_or_default().into()),
    };
    if imported.is_empty() {
        return failed("没有找到可导入的 Claude 供应商（只导入 Anthropic 格式的）。", load().unwrap_or_default().into());
    }
    let mut unreachable = Vec::new();
    for profile in imported.iter_mut().filter(|profile| profile.models.is_empty()) {
        match claude_mom::fetch_models(&profile.base_url, &profile.api_key).await {
            Ok(models) => {
                profile.models = models.iter().map(|model| model.id.clone()).collect();
                profile.model_names = models
                    .iter()
                    .filter_map(|model| Some((model.id.clone(), model.display_name.clone()?)))
                    .collect();
                if profile.model.is_empty() {
                    profile.model = profile.models.first().cloned().unwrap_or_default();
                }
                profile.context_window = models
                    .iter()
                    .find(|model| model.id == profile.model)
                    .and_then(|model| model.context_window);
            }
            Err(_) => unreachable.push(profile.name.clone()),
        }
    }
    let result = tauri::async_runtime::spawn_blocking(move || mutate(|book| Ok(book.merge_imported(imported))))
        .await
        .unwrap_or_else(|error| Err(anyhow::anyhow!("{error}")));
    respond(
        result,
        |(added, updated)| {
            let mut message = format!("已导入：新增 {added} 组，更新 {updated} 组。");
            if !unreachable.is_empty() {
                message.push_str(&format!("{} 暂时连不上，模型列表稍后再拉。", unreachable.join("、")));
            }
            message
        },
        "导入失败",
    )
}

#[tauri::command]
pub async fn claude_mom_fetch_models(base_url: String, api_key: String) -> CommandResult<ModelsPayload> {
    match claude_mom::fetch_models(&base_url, &api_key).await {
        Ok(models) => ok(&format!("拉到 {} 个模型。", models.len()), ModelsPayload { models }),
        Err(error) => failed(&format!("{error:#}"), ModelsPayload::default()),
    }
}

/// 原生听写开关：只改 Claude 的「原生听写」，转写用本机 SenseVoice。返回最新的 Claude 状态。
#[tauri::command]
pub async fn claude_mom_set_voice(enabled: bool) -> CommandResult<Value> {
    let result = tauri::async_runtime::spawn_blocking(move || {
        let mut config = claude_local::status()?.config;
        config.voice_input = enabled;
        claude_local::configure(config)
    })
    .await
    .unwrap_or_else(|error| Err(anyhow::anyhow!("{error}")));
    match result {
        Ok(status) => ok(
            if enabled { "原生听写已打开，重新启动 Claude 后在输入框里能看到麦克风。" } else { "原生听写已关闭。" },
            serde_json::to_value(status).unwrap_or_default(),
        ),
        Err(error) => failed(&format!("{error:#}"), json!({})),
    }
}

// ── Claude 本身：状态、设置、动作（转给 claude-local） ─────────────────────────

#[tauri::command]
pub async fn claude_local_status() -> CommandResult<Value> {
    match tauri::async_runtime::spawn_blocking(claude_local::status).await {
        Ok(Ok(status)) => ok("Claude 状态已读取。", serde_json::to_value(status).unwrap_or_default()),
        Ok(Err(error)) => failed(&format!("{error:#}"), json!({})),
        Err(error) => failed(&format!("Claude 状态读取失败：{error}"), json!({})),
    }
}

#[tauri::command]
pub async fn claude_local_configure(config: claude_local::ClaudeLocalSettings) -> CommandResult<Value> {
    match tauri::async_runtime::spawn_blocking(move || claude_local::configure(config)).await {
        Ok(Ok(status)) => ok("设置已保存。", serde_json::to_value(status).unwrap_or_default()),
        Ok(Err(error)) => failed(&format!("{error:#}"), json!({})),
        Err(error) => failed(&format!("保存设置失败：{error}"), json!({})),
    }
}

#[tauri::command]
pub async fn claude_local_action(action: String) -> CommandResult<Value> {
    match tauri::async_runtime::spawn_blocking(move || claude_local::perform(&action)).await {
        Ok(Ok(result)) => ok(&result.message, serde_json::to_value(result.status).unwrap_or_default()),
        Ok(Err(error)) => {
            let status = claude_local::status().ok().and_then(|status| serde_json::to_value(status).ok());
            failed(&format!("{error:#}"), status.unwrap_or_else(|| json!({})))
        }
        Err(error) => failed(&format!("操作失败：{error}"), json!({})),
    }
}

// ── 本地听写模型 ─────────────────────────────────────────────────────────

#[tauri::command]
pub fn dictation_local_model_status() -> Value {
    claude_local::dictation::model_status()
}

#[tauri::command]
pub async fn download_dictation_local_model() -> CommandResult<Value> {
    match claude_local::dictation::prepare_model().await {
        Ok(state) => ok("本地 SenseVoice 模型下载并校验完成。", state),
        Err(error) => failed(&error.message, json!({})),
    }
}
