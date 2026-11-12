//! ClaudeMom 给 claude-local 的宿主实现：状态目录、设置文件、上游（选中的那组 Base URL + Key）、听写服务。

use std::path::PathBuf;
use std::sync::{Arc, Mutex};

use anyhow::{Context, Result, bail};
use claude_local::dictation::EngineError;
use claude_local::{ClaudeLocalSettings, Host, Upstream};
use serde_json::{Map, Value};

/// 状态目录：`CLAUDE_MOM_STATE_DIR` 覆盖，否则 `~/.claude-mom`。
pub fn state_dir() -> PathBuf {
    if let Some(dir) = std::env::var_os("CLAUDE_MOM_STATE_DIR")
        .map(PathBuf::from)
        .filter(|dir| dir.is_absolute())
    {
        return dir;
    }
    directories::BaseDirs::new()
        .map(|dirs| dirs.home_dir().join(".claude-mom"))
        .unwrap_or_else(|| PathBuf::from(".claude-mom"))
}

fn settings_path() -> PathBuf {
    state_dir().join("settings.json")
}

/// 设置文件里 Claude 那份放在 `claudeDesktopLocal` 下（与 Codex++ 同名同形状）；其它键原样保留。
const SETTINGS_KEY: &str = "claudeDesktopLocal";

static SETTINGS_LOCK: Mutex<()> = Mutex::new(());

fn read_settings_map() -> Result<Map<String, Value>> {
    match std::fs::read(settings_path()) {
        Ok(bytes) => match serde_json::from_slice::<Value>(&bytes)
            .with_context(|| format!("设置文件损坏：{}", settings_path().display()))?
        {
            Value::Object(map) => Ok(map),
            _ => bail!("设置文件格式不对：{}", settings_path().display()),
        },
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(Map::new()),
        Err(error) => Err(error).with_context(|| format!("读取设置失败：{}", settings_path().display())),
    }
}

pub struct ClaudeMomHost;

impl ClaudeMomHost {
    pub fn install() {
        claude_local::install_host(Arc::new(ClaudeMomHost));
    }

    fn active_upstream(&self) -> Result<Upstream> {
        let book = crate::upstreams::load_book(&crate::upstreams::default_book_path())?;
        let profile = book
            .active()
            .context("还没有上游：先添加一组 Base URL 和 Key，或从 cc-switch / Magpie / Codex++ 导入")?;
        let upstream = profile.to_upstream();
        if upstream.root.is_empty() {
            bail!("当前上游「{}」没有填 Base URL", profile.name);
        }
        if upstream.default_model.is_empty() {
            bail!("当前上游「{}」还没选默认模型", profile.name);
        }
        Ok(upstream)
    }
}

impl Host for ClaudeMomHost {
    fn state_dir(&self) -> PathBuf {
        state_dir()
    }

    fn ca_name(&self) -> &str {
        "ClaudeMom Local CA"
    }

    fn load_config(&self) -> Result<ClaudeLocalSettings> {
        let map = read_settings_map()?;
        let stored = map.get(SETTINGS_KEY).cloned();
        let mut config: ClaudeLocalSettings = stored
            .clone()
            .map(serde_json::from_value)
            .transpose()?
            .unwrap_or_default();
        // ClaudeMom 只有完整功能模式。
        config.enabled = true;
        // 会话同步默认开：平时在普通 Claude / 3p 模式建的会话记录在 ~/.claude，完整功能模式用独立目录，
        // 不同步的话左侧列表里的会话全显示「在磁盘上未找到会话」。用户关掉过就尊重。
        if stored.as_ref().and_then(|value| value.get("sessionSync")).is_none() {
            config.session_sync = true;
        }
        // Code 页签默认和命令行共用 ~/.claude（填上实际生效的值，界面才显示得对）。
        if config.code_share_home.is_none() {
            config.code_share_home = Some(self.default_code_share_home());
        }
        Ok(config)
    }

    fn save_config(&self, config: &ClaudeLocalSettings) -> Result<()> {
        let _guard = SETTINGS_LOCK.lock().unwrap_or_else(|error| error.into_inner());
        let mut map = read_settings_map()?;
        let mut config = config.clone();
        config.enabled = true;
        map.insert(SETTINGS_KEY.into(), serde_json::to_value(config)?);
        claude_local::fsutil::atomic_write(&settings_path(), &serde_json::to_vec_pretty(&Value::Object(map))?)
    }

    fn preview_upstream(&self, _config: &ClaudeLocalSettings) -> Result<Upstream> {
        self.active_upstream()
    }

    fn prepare_upstream(&self, _config: &ClaudeLocalSettings) -> Result<Upstream> {
        self.active_upstream()
    }

    fn default_code_share_home(&self) -> bool {
        true
    }

    fn dictation_ready(&self, config: &ClaudeLocalSettings) -> bool {
        config.voice_input && claude_local::dictation::model_ready()
    }

    fn prepare_dictation_service(&self) -> Result<()> {
        let availability: claude_local::dictation::server::Availability = Arc::new(|| {
            let config = ClaudeMomHost.load_config().map_err(|error| EngineError::new(500, format!("{error:#}")))?;
            if !config.voice_input {
                return Err(EngineError::new(403, "原生听写未开启"));
            }
            if !claude_local::dictation::model_ready() {
                return Err(EngineError::new(503, "本地 SenseVoice 模型未就绪"));
            }
            Ok(())
        });
        claude_local::dictation::server::ensure_running(&state_dir(), availability).map(|_| ())
    }

    fn diagnostic(&self, event: &str, detail: Value) {
        crate::log::append(event, detail);
    }
}
