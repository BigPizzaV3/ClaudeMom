//! 找 Node 运行时（本地兼容服务是 Node 脚本）。

use std::path::PathBuf;

/// 第一个候选 Node（不检查版本）；要能跑本地服务的请用 [`node_candidates`] 逐个检查。
pub fn locate_node() -> Option<PathBuf> {
    node_candidates().into_iter().next()
}

/// 所有候选 Node，按优先级排列：
/// `CLAUDE_LOCAL_NODE`（或 `CODEX_PLUS_NODE`） → PATH 与常见安装目录 → 其它 App 自带的 Node。
///
/// 系统 Node 排在其它 App 自带的前面（#17）：借用 ChatGPT / Codex 包里的二进制，
/// 防火墙里看到的是「ChatGPT 在联网」，那个 App 更新或卸载后也会失效。
/// 只有用户没装 Node、或装的版本太旧时，才退回去用它们。
pub fn node_candidates() -> Vec<PathBuf> {
    let configured = std::env::var_os("CLAUDE_LOCAL_NODE")
        .or_else(|| std::env::var_os("CODEX_PLUS_NODE"))
        .map(PathBuf::from)
        .filter(|path| path.is_absolute() && path.is_file());
    let bundled = bundled_nodes().into_iter().filter(|path| path.is_file()).collect();
    ordered_candidates(configured, program_candidates("node"), bundled)
}

fn ordered_candidates(
    configured: Option<PathBuf>,
    system: Vec<PathBuf>,
    bundled: Vec<PathBuf>,
) -> Vec<PathBuf> {
    let mut seen = std::collections::HashSet::new();
    configured
        .into_iter()
        .chain(system)
        .chain(bundled)
        .filter(|path| seen.insert(path.clone()))
        .collect()
}

/// 其它 App 自带的 Node（Codex / ChatGPT 的 cua_node）。
fn bundled_nodes() -> Vec<PathBuf> {
    #[allow(unused_mut)]
    let mut paths = Vec::new();
    #[cfg(target_os = "macos")]
    {
        paths.push(PathBuf::from(
            "/Applications/ChatGPT.app/Contents/Resources/cua_node/bin/node",
        ));
        paths.push(PathBuf::from(
            "/Applications/Codex.app/Contents/Resources/cua_node/bin/node",
        ));
        if let Some(base) = crate::user_dirs::BaseDirs::new() {
            paths.push(
                base.home_dir()
                    .join("Applications/ChatGPT.app/Contents/Resources/cua_node/bin/node"),
            );
        }
    }
    paths
}

/// 在 PATH 与常见安装目录里找程序。访达启动的 App 拿不到 shell 的 PATH，补上常见位置。
pub fn locate_program(name: &str) -> Option<PathBuf> {
    program_candidates(name).into_iter().next()
}

/// PATH 与常见安装目录里所有叫这个名字的程序，按搜索顺序。
fn program_candidates(name: &str) -> Vec<PathBuf> {
    let names: Vec<String> = if cfg!(windows) {
        vec![format!("{name}.exe"), format!("{name}.cmd"), name.to_string()]
    } else {
        vec![name.to_string()]
    };
    let mut dirs: Vec<PathBuf> = std::env::var_os("PATH")
        .map(|path| std::env::split_paths(&path).collect())
        .unwrap_or_default();
    if let Some(base) = crate::user_dirs::BaseDirs::new() {
        for extra in [".local/bin", ".volta/bin", ".npm-global/bin", ".bun/bin"] {
            dirs.push(base.home_dir().join(extra));
        }
    }
    if cfg!(unix) {
        dirs.push(PathBuf::from("/opt/homebrew/bin"));
        dirs.push(PathBuf::from("/usr/local/bin"));
        dirs.push(PathBuf::from("/usr/bin"));
    }
    if cfg!(windows) {
        dirs.extend(windows_install_dirs(|name| std::env::var_os(name)));
    }
    dirs.into_iter()
        .flat_map(|dir| names.iter().map(move |name| dir.join(name)))
        .filter(|path| path.is_file())
        .collect()
}

/// Windows 上常见的 Node 安装目录，排在 PATH 后面。
///
/// 进程的 PATH 是它启动时继承的：本程序（或拉起它的常驻进程）先于 Node 启动时，
/// 安装器后来写进注册表的 PATH 这里看不到，终端里 `node -v` 正常、这里却说没装（Codex++ #3291）。
/// fnm 之类只在 shell 里改 PATH 的版本管理器也一样。
pub fn windows_install_dirs(var: impl Fn(&str) -> Option<std::ffi::OsString>) -> Vec<PathBuf> {
    let dir = |name: &str| var(name).map(PathBuf::from).filter(|path| path.is_absolute());
    let mut dirs = Vec::new();
    // nvm-windows 把当前版本链接到 NVM_SYMLINK（默认就是 Program Files\nodejs）。
    dirs.extend(dir("NVM_SYMLINK"));
    for root in ["ProgramFiles", "ProgramW6432", "ProgramFiles(x86)"] {
        dirs.extend(dir(root).map(|root| root.join("nodejs")));
    }
    if let Some(local) = dir("LOCALAPPDATA") {
        dirs.push(local.join("Volta").join("bin"));
        dirs.push(local.join("Programs").join("nodejs"));
    }
    if let Some(roaming) = dir("APPDATA") {
        dirs.push(roaming.join("fnm").join("aliases").join("default"));
    }
    if let Some(home) = dir("USERPROFILE") {
        dirs.push(home.join("scoop").join("apps").join("nodejs").join("current"));
        dirs.push(home.join("scoop").join("apps").join("nodejs-lts").join("current"));
    }
    dirs
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn system_node_comes_before_nodes_bundled_in_other_apps() {
        let configured = PathBuf::from("/custom/node");
        let system = PathBuf::from("/usr/local/bin/node");
        let bundled = PathBuf::from("/Applications/Codex.app/Contents/Resources/cua_node/bin/node");
        assert_eq!(
            ordered_candidates(None, vec![system.clone()], vec![bundled.clone()]),
            vec![system.clone(), bundled.clone()],
        );
        // 手动指定的永远最先；同一个路径不重复检查。
        assert_eq!(
            ordered_candidates(
                Some(configured.clone()),
                vec![system.clone(), configured.clone()],
                vec![bundled.clone()],
            ),
            vec![configured, system, bundled.clone()],
        );
        // 没装 Node 时才退回其它 App 自带的。
        assert_eq!(ordered_candidates(None, vec![], vec![bundled.clone()]), vec![bundled]);
    }

    #[test]
    fn windows_install_dirs_cover_installers_that_only_update_the_registry_path() {
        // 用 / 开头的路径代替盘符，在非 Windows 上也算绝对路径。
        let env = |name: &str| -> Option<std::ffi::OsString> {
            match name {
                "ProgramFiles" => Some("/pf".into()),
                "LOCALAPPDATA" => Some("/local".into()),
                "APPDATA" => Some("/roaming".into()),
                "USERPROFILE" => Some("relative-is-ignored".into()),
                _ => None,
            }
        };
        let dirs = windows_install_dirs(env);
        assert_eq!(dirs[0], PathBuf::from("/pf").join("nodejs"));
        assert!(dirs.contains(&PathBuf::from("/local").join("Volta").join("bin")));
        assert!(dirs.contains(&PathBuf::from("/roaming").join("fnm").join("aliases").join("default")));
        // 没设置或不是绝对路径的变量不产生候选。
        assert!(!dirs.iter().any(|dir| dir.starts_with("relative-is-ignored")));
        assert_eq!(dirs.len(), 4);
    }
}
