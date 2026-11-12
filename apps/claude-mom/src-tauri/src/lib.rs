//! ClaudeMom：用原版 Claude Desktop 的完整功能模式，直连自己配置的上游（Base URL + Key）。

mod commands;
mod host;
mod log;
mod upstreams;

use std::sync::atomic::{AtomicBool, Ordering};

use tauri::menu::{Menu, MenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{Manager, WindowEvent};

const MAIN_WINDOW: &str = "main";
const TRAY_SHOW: &str = "tray_show";
const TRAY_QUIT: &str = "tray_quit";
/// 单实例锁端口（与 Codex++ 的 57319 / 57320 错开）。设置 `CLAUDE_MOM_GUARD_PORT` 可覆盖。
const GUARD_PORT: u16 = 57519;

static EXITING: AtomicBool = AtomicBool::new(false);

pub fn run() {
    host::ClaudeMomHost::install();
    log::append("app.start", serde_json::json!({ "version": env!("CARGO_PKG_VERSION") }));
    let guard_port = std::env::var("CLAUDE_MOM_GUARD_PORT")
        .ok()
        .and_then(|value| value.parse::<u16>().ok())
        .unwrap_or(GUARD_PORT);
    // 已经有一个在跑：交给系统把它带到前台（macOS 上 open 同一个 app 即可），自己退出。
    let Ok(_guard) = std::net::TcpListener::bind(("127.0.0.1", guard_port)) else {
        log::append("app.already_running", serde_json::json!({ "port": guard_port }));
        return;
    };
    // 程序重启后，Claude 可能还挂在旧代理端口上：在原端口把本地服务拉起来，它的重试就能连上。
    std::thread::spawn(|| match claude_local::resume_attached_proxy() {
        Ok(Some(port)) => log::append("claude_local.resumed", serde_json::json!({ "port": port })),
        Ok(None) => {}
        Err(error) => log::append("claude_local.resume_failed", serde_json::json!({ "message": format!("{error:#}") })),
    });

    let app = tauri::Builder::default()
        .setup(|app| {
            install_tray(app)?;
            if let Some(window) = app.get_webview_window(MAIN_WINDOW) {
                let hide_target = window.clone();
                window.on_window_event(move |event| {
                    // 关窗只是收起：本地服务要一直在，Claude 才连得上。真正退出走托盘菜单。
                    if let WindowEvent::CloseRequested { api, .. } = event
                        && !EXITING.load(Ordering::SeqCst)
                    {
                        api.prevent_close();
                        let _ = hide_target.hide();
                    }
                });
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::claude_local_status,
            commands::claude_local_configure,
            commands::claude_local_action,
            commands::claude_mom_load,
            commands::claude_mom_save_profile,
            commands::claude_mom_delete_profile,
            commands::claude_mom_set_active,
            commands::claude_mom_import,
            commands::claude_mom_fetch_models,
            commands::claude_mom_set_voice,
            commands::dictation_local_model_status,
            commands::download_dictation_local_model,
        ])
        .build(tauri::generate_context!());
    let app = match app {
        Ok(app) => app,
        Err(error) => {
            log::append("app.build_failed", serde_json::json!({ "message": error.to_string() }));
            return;
        }
    };
    app.run(|app_handle, event| match event {
        tauri::RunEvent::ExitRequested { api, code, .. } => {
            // 窗口全部收起时 Tauri 也会请求退出：没点「退出」就不退。
            if code.is_none() && !EXITING.load(Ordering::SeqCst) {
                api.prevent_exit();
            }
        }
        tauri::RunEvent::Exit => {
            claude_local::stop_backend();
            claude_local::dictation::server::remove_receipt();
            log::append("app.exit", serde_json::json!({}));
        }
        #[cfg(target_os = "macos")]
        tauri::RunEvent::Reopen { .. } => show_main_window(app_handle),
        _ => {
            let _ = app_handle;
        }
    });
}

fn show_main_window<R: tauri::Runtime>(app: &tauri::AppHandle<R>) {
    if let Some(window) = app.get_webview_window(MAIN_WINDOW) {
        let _ = window.unminimize();
        let _ = window.show();
        let _ = window.set_focus();
    }
}

fn install_tray<R: tauri::Runtime>(app: &tauri::App<R>) -> tauri::Result<()> {
    let show = MenuItem::with_id(app, TRAY_SHOW, "显示 ClaudeMom", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, TRAY_QUIT, "退出（同时停止本地服务）", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&show, &quit])?;
    let mut builder = TrayIconBuilder::with_id("claude_mom_tray")
        .menu(&menu)
        .tooltip("ClaudeMom")
        .show_menu_on_left_click(!cfg!(windows))
        .on_menu_event(|app, event| match event.id.as_ref() {
            TRAY_SHOW => show_main_window(app),
            TRAY_QUIT => {
                EXITING.store(true, Ordering::SeqCst);
                app.exit(0);
            }
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click { button: MouseButton::Left, button_state: MouseButtonState::Up, .. } = event
                && cfg!(windows)
            {
                show_main_window(tray.app_handle());
            }
        });
    // macOS 菜单栏用单色模板图标（系统按深浅色着色）；其它平台用彩色应用图标。
    #[cfg(target_os = "macos")]
    {
        builder = builder.icon(tauri::include_image!("icons/tray@2x.png")).icon_as_template(true);
    }
    #[cfg(not(target_os = "macos"))]
    if let Some(icon) = app.default_window_icon().cloned() {
        builder = builder.icon(icon);
    }
    builder.build(app)?;
    Ok(())
}
