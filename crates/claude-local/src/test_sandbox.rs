//! 测试进程的家目录沙箱：测试不许碰用户的真实目录。
//!
//! 很多代码走默认路径（`~/.claude/settings.json`、`~/.claude-mom`、`~/.claude-desktop-local`、
//! Claude Desktop 的 profile 等），测试里只要有一处忘了换成临时目录，就会改到用户正在用的配置
//! （出过事：Claude 的配置被改成测试数据，正在用 Claude 的会话直接断了）。
//!
//! 所以每个测试程序在 `main` 之前（`#[ctor]`，此时还是单线程）调用 [`enter`]：
//! 把 `HOME` 等指向这个进程自己的临时目录，清掉直接指定配置目录的变量（`CLAUDE_CONFIG_DIR`、
//! `CLAUDE_MOM_STATE_DIR`……），默认路径于是全落在沙箱里。测试自己再设这些变量照常有效。
//!
//! 新增测试程序（`src` 下的单元测试根、`tests/*.rs`）都要接上，本文件里的契约测试会查。
//! 和 Codex++ 的 `codex_plus_core::test_sandbox` 是同一套做法。
//! Windows 上 `directories` 走系统的已知文件夹接口、不看环境变量：所以代码里的用户目录统一走
//! [`crate::user_dirs`]，它看到 [`active_home`] 就改按沙箱推导（契约测试也查没有绕过它的）。

use std::path::{Path, PathBuf};
use std::sync::OnceLock;

static SANDBOX: OnceLock<PathBuf> = OnceLock::new();

/// 沙箱根目录，传给子进程：子进程看到它（且 HOME 在里面）就知道自己已经在沙箱里。
const MARKER: &str = "CLAUDE_MOM_TEST_SANDBOX";

/// 直接指定某个配置 / 状态目录的变量：清掉，让它们按沙箱里的 HOME 推导。
const CLEARED: &[&str] = &[
    "CLAUDE_CONFIG_DIR",
    "CLAUDE_USER_DATA_DIR",
    "CLAUDE_MOM_STATE_DIR",
    "CODEX_HOME",
    "CODEX_PLUS_STATE_DIR",
    "XDG_CONFIG_HOME",
    "XDG_DATA_HOME",
    "XDG_STATE_HOME",
    "XDG_CACHE_HOME",
];

/// 进入沙箱（幂等）。只该在测试程序的 `#[ctor]` 里调用：改环境变量要求此时没有别的线程。
pub fn enter() -> &'static Path {
    SANDBOX.get_or_init(|| {
        // 测试把自己再起一遍当子进程（带上专门设的 CODEX_PLUS_STATE_DIR 等）时，父进程已经在沙箱里了：
        // 原样继承，不再清变量，否则父进程给子进程设的目录会被清掉。
        if let Some(inherited) = std::env::var_os(MARKER).map(PathBuf::from)
            && std::env::var_os("HOME").is_some_and(|home| Path::new(&home).starts_with(&inherited))
        {
            return inherited;
        }
        let root = std::env::temp_dir().join(format!("claude-mom-test-home-{}", std::process::id()));
        let home = root.join("home");
        let _ = std::fs::create_dir_all(&home);
        // SAFETY: 只在 main 之前的 #[ctor] 里调用，进程里还没有其他线程读写环境变量。
        unsafe {
            // 子进程（cargo、rustup 代理）还要找到真实的工具链：没显式设过就按真实家目录先钉住。
            if let Some(real) = std::env::var_os("HOME").or_else(|| std::env::var_os("USERPROFILE")) {
                let real = PathBuf::from(real);
                if std::env::var_os("RUSTUP_HOME").is_none() {
                    std::env::set_var("RUSTUP_HOME", real.join(".rustup"));
                }
                if std::env::var_os("CARGO_HOME").is_none() {
                    std::env::set_var("CARGO_HOME", real.join(".cargo"));
                }
            }
            for name in CLEARED {
                std::env::remove_var(name);
            }
            std::env::set_var("HOME", &home);
            std::env::set_var(MARKER, &root);
            if cfg!(windows) {
                std::env::set_var("USERPROFILE", &home);
                std::env::set_var("APPDATA", home.join("AppData").join("Roaming"));
                std::env::set_var("LOCALAPPDATA", home.join("AppData").join("Local"));
            }
        }
        root
    })
}

/// 沙箱里的家目录：本进程（或起它的测试进程）进了沙箱、家目录也还在沙箱根下时返回，否则 None。
///
/// 按环境变量判断而不是只看本进程有没有调过 [`enter`]：测试起的子进程也要落在沙箱里。
/// 正式运行时没有这个标记，开销只是读一次环境变量。
pub fn active_home() -> Option<PathBuf> {
    let root = PathBuf::from(std::env::var_os(MARKER)?);
    let home = std::env::var_os("HOME")
        .or_else(|| std::env::var_os("USERPROFILE"))
        .map(PathBuf::from)?;
    home.starts_with(&root).then_some(home)
}

/// 当前进程的沙箱根目录（没进沙箱时为 None）。
pub fn root() -> Option<&'static Path> {
    SANDBOX.get().map(PathBuf::as_path)
}

#[cfg(test)]
mod tests {
    use std::path::{Path, PathBuf};

    #[test]
    fn this_process_runs_inside_the_home_sandbox() {
        let root = super::root().expect("测试程序没有进家目录沙箱");
        let home = PathBuf::from(std::env::var_os("HOME").expect("HOME"));
        assert!(home.starts_with(root), "HOME 没有指到沙箱：{}", home.display());
        // 用户目录统一走 user_dirs：沙箱里按沙箱推导（Windows 上 directories 不看环境变量，只能靠这里挡住）。
        let dirs = crate::user_dirs::BaseDirs::new().expect("user_dirs");
        for path in [dirs.home_dir(), dirs.config_dir(), dirs.data_dir(), dirs.data_local_dir()] {
            assert!(path.starts_with(root), "用户目录没落在沙箱里：{}", path.display());
        }
    }

    fn rust_files(dir: &Path, out: &mut Vec<PathBuf>) {
        let Ok(entries) = std::fs::read_dir(dir) else { return };
        for entry in entries.flatten() {
            let path = entry.path();
            if path.is_dir() {
                rust_files(&path, out);
            } else if path.extension().is_some_and(|ext| ext == "rs") {
                out.push(path);
            }
        }
    }

    /// Windows 上 `directories` / 已知文件夹接口不看环境变量，沙箱挡不住：代码里的用户目录只能经 `user_dirs` 取。
    #[test]
    fn nothing_bypasses_user_dirs() {
        let workspace = Path::new(env!("CARGO_MANIFEST_DIR")).join("../..");
        let mut files = Vec::new();
        for member in ["crates/claude-local", "apps/claude-mom/src-tauri"] {
            for sub in ["src", "examples", "tests"] {
                rust_files(&workspace.join(member).join(sub), &mut files);
            }
        }
        assert!(files.len() > 10, "没找到源文件");
        let allowed = |path: &Path| path.ends_with("src/user_dirs.rs") || path.ends_with("src/test_sandbox.rs");
        let offenders: Vec<_> = files
            .iter()
            .filter(|path| !allowed(path))
            .filter(|path| {
                // 注释里提到不算。
                std::fs::read_to_string(path).unwrap_or_default().lines().any(|line| {
                    let code = line.trim_start();
                    !code.starts_with("//") && (code.contains("directories::") || code.contains("SHGetKnownFolderPath("))
                })
            })
            .map(|path| path.strip_prefix(&workspace).unwrap_or(path).display().to_string())
            .collect();
        assert!(
            offenders.is_empty(),
            "这些文件绕过了 claude_local::user_dirs 直接取用户目录，Windows 上测试沙箱挡不住：{offenders:?}"
        );
    }

    /// 每个测试程序的根文件：工作区成员带单元测试的 `src/lib.rs` / `src/main.rs`，以及 `tests/*.rs`、`tests/*/main.rs`。
    #[test]
    fn every_test_binary_enters_the_home_sandbox() {
        let workspace = Path::new(env!("CARGO_MANIFEST_DIR")).join("../..");
        let mut roots = Vec::new();
        for member in ["crates/claude-local", "apps/claude-mom/src-tauri"] {
            let dir = workspace.join(member);
            for name in ["src/lib.rs", "src/main.rs"] {
                let path = dir.join(name);
                if std::fs::read_to_string(&path).is_ok_and(|text| text.contains("#[cfg(test)]") || text.contains("#[test]")) {
                    roots.push(path);
                }
            }
            let Ok(entries) = std::fs::read_dir(dir.join("tests")) else { continue };
            for entry in entries.flatten() {
                let path = entry.path();
                if path.extension().is_some_and(|ext| ext == "rs") {
                    roots.push(path);
                } else if path.join("main.rs").is_file() {
                    roots.push(path.join("main.rs"));
                }
            }
        }
        assert!(!roots.is_empty());
        let missing: Vec<_> = roots
            .iter()
            .filter(|path| !std::fs::read_to_string(path).unwrap_or_default().contains("test_sandbox::enter()"))
            .map(|path| path.strip_prefix(&workspace).unwrap_or(path).display().to_string())
            .collect();
        assert!(
            missing.is_empty(),
            "这些测试程序没进家目录沙箱，可能改到用户真实的 ~/.claude：{missing:?}\n加一个 #[ctor::ctor] 调 test_sandbox::enter()"
        );
    }
}
