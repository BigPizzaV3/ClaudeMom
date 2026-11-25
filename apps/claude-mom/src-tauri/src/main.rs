#![cfg_attr(windows, windows_subsystem = "windows")]

fn main() {
    claude_mom_lib::run();
}

/// 测试不许碰用户的真实目录：main 之前进家目录沙箱（见 `claude_local::test_sandbox`）。
#[cfg(test)]
#[ctor::ctor]
fn enter_test_sandbox() {
    claude_local::test_sandbox::enter();
}
