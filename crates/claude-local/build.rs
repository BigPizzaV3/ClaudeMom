//! 把 runtime/mock-templates/ 下每个录制版本（<build>/bootstrap.json、shell.html、api/*.json）
//! 生成成内嵌资源清单，安装到 `<state>/claude-local/mock/<build>/`。
//! 加一个版本只要放一个目录，不用改代码。

use std::fs;
use std::path::{Path, PathBuf};

fn collect(base: &Path, dir: &Path, files: &mut Vec<(String, PathBuf)>) {
    let mut entries: Vec<_> = fs::read_dir(dir)
        .unwrap_or_else(|error| panic!("读不了 {}: {error}", dir.display()))
        .filter_map(Result::ok)
        .map(|entry| entry.path())
        .collect();
    entries.sort();
    for path in entries {
        let name = path.file_name().and_then(|name| name.to_str()).unwrap_or_default();
        if name.starts_with('.') {
            continue;
        }
        if path.is_dir() {
            collect(base, &path, files);
        } else {
            let relative = path
                .strip_prefix(base)
                .expect("模板文件在模板目录里")
                .components()
                .map(|part| part.as_os_str().to_string_lossy().into_owned())
                .collect::<Vec<_>>()
                .join("/");
            files.push((relative, path));
        }
    }
}

fn main() {
    let manifest = PathBuf::from(std::env::var("CARGO_MANIFEST_DIR").expect("CARGO_MANIFEST_DIR"));
    let root = manifest.join("runtime/mock-templates");
    println!("cargo:rerun-if-changed={}", root.display());
    let mut versions: Vec<PathBuf> = fs::read_dir(&root)
        .unwrap_or_else(|error| panic!("读不了 {}: {error}", root.display()))
        .filter_map(Result::ok)
        .map(|entry| entry.path())
        .filter(|path| path.is_dir())
        .collect();
    versions.sort();
    let mut out = String::from("/// 由 build.rs 从 runtime/mock-templates/ 生成：每个录制版本一组（安装路径，内容）。\n");
    out.push_str("pub(crate) const TEMPLATE_ASSETS: &[(&str, &[u8])] = &[\n");
    for version in &versions {
        let build = version.file_name().and_then(|name| name.to_str()).expect("版本目录名");
        assert!(
            build.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_'),
            "模板目录名只能是前端 build id：{build}"
        );
        for required in ["bootstrap.json", "shell.html"] {
            assert!(version.join(required).is_file(), "模板 {build} 缺 {required}");
        }
        let mut files = Vec::new();
        collect(version, version, &mut files);
        for (relative, path) in files {
            out.push_str(&format!(
                "    ({:?}, include_bytes!({:?})),\n",
                format!("mock/{build}/{relative}"),
                path.to_string_lossy()
            ));
        }
    }
    out.push_str("];\n");
    let target = PathBuf::from(std::env::var("OUT_DIR").expect("OUT_DIR")).join("templates.rs");
    fs::write(target, out).expect("写 templates.rs");
}
