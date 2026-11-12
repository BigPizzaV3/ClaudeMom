//! 诊断日志：`<state>/claude-mom.log`，一行一个 JSON。只记事件，不记 Key、音频。

use std::io::Write;

use serde_json::{Value, json};

pub fn append(event: &str, detail: Value) {
    let path = crate::host::state_dir().join("claude-mom.log");
    if let Some(parent) = path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    let line = json!({
        "timestamp_ms": std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|elapsed| elapsed.as_millis() as u64)
            .unwrap_or_default(),
        "pid": std::process::id(),
        "event": event,
        "detail": detail,
    });
    if let Ok(mut file) = std::fs::OpenOptions::new().create(true).append(true).open(&path) {
        let _ = writeln!(file, "{line}");
    }
}
