// 发布构建不要弹出控制台窗口，这一行不能删。
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    desktop_ai_assistant_lib::run();
}
