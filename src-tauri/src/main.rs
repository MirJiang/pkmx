// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    let args: Vec<String> = std::env::args().collect();
    let vault_arg = || {
        args.iter()
            .position(|a| a == "--vault")
            .and_then(|i| args.get(i + 1))
            .cloned()
    };
    // pkmx --mcp [--vault <dir>]：作为 MCP stdio 服务器运行，不打开窗口
    if args.iter().any(|a| a == "--mcp") {
        std::process::exit(pkmx_lib::run_mcp(vault_arg()));
    }
    // pkmx --vault <dir>：GUI 模式直接打开指定仓库
    pkmx_lib::run(vault_arg())
}
