mod commands;
mod menu;
mod settings;

use commands::PendingFile;
use tauri::Manager;

pub fn run() {
    tauri::Builder::default()
        // single-instance must be the first plugin: a second launch of the app
        // (e.g. double-clicking another .md) is routed to the running window.
        .plugin(tauri_plugin_single_instance::init(|app, argv, _cwd| {
            if let Some(path) = commands::find_markdown_arg(&argv) {
                menu::open_file_in_app(app, path);
            } else if let Some(window) = app.get_webview_window("main") {
                let _ = window.show();
                let _ = window.unminimize();
                let _ = window.set_focus();
            }
        }))
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .manage(PendingFile(Default::default()))
        .setup(|app| {
            let handle = app.handle().clone();
            menu::refresh(&handle)?;
            handle.on_menu_event(|app, event| menu::handle_event(app, &event.id().0));

            let args: Vec<String> = std::env::args().collect();
            if let Some(path) = commands::find_markdown_arg(&args) {
                app.state::<PendingFile>()
                    .0
                    .lock()
                    .unwrap()
                    .replace(path);
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::read_markdown_file,
            commands::write_markdown_file,
            commands::get_recent_files,
            commands::push_recent_file,
            commands::clear_recent_files,
            commands::get_settings,
            commands::set_language,
            commands::take_pending_file
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|_app, _event| {
            #[cfg(target_os = "macos")]
            if let tauri::RunEvent::Opened { urls } = _event {
                for url in urls {
                    if let Ok(path) = url.to_file_path() {
                        menu::open_file_in_app(_app, path.to_string_lossy().into_owned());
                    }
                }
            }
        });
}
