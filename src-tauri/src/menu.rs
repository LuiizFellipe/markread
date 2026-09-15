use std::path::Path;

use tauri::menu::{CheckMenuItem, Menu, MenuItem, PredefinedMenuItem, Submenu};
use tauri::{AppHandle, Emitter, Manager, Wry};

use crate::{commands, settings};

const MAIN_WINDOW: &str = "main";

/// Translated menu labels for the three supported UI languages.
struct Labels {
    file: &'static str,
    open: &'static str,
    open_recent: &'static str,
    no_recent: &'static str,
    quit: &'static str,
    view: &'static str,
    theme: &'static str,
    theme_light: &'static str,
    theme_dark: &'static str,
    theme_system: &'static str,
    language: &'static str,
    zoom_in: &'static str,
    zoom_out: &'static str,
    zoom_reset: &'static str,
    find: &'static str,
    toggle_outline: &'static str,
    help: &'static str,
    about: &'static str,
}

fn labels(lang: &str) -> Labels {
    if lang == "pt-BR" {
        Labels {
            file: "Arquivo",
            open: "Abrir…",
            open_recent: "Abrir recente",
            no_recent: "Nenhum arquivo recente",
            quit: "Sair",
            view: "Visualizar",
            theme: "Tema",
            theme_light: "Claro",
            theme_dark: "Escuro",
            theme_system: "Sistema",
            language: "Idioma",
            zoom_in: "Ampliar",
            zoom_out: "Reduzir",
            zoom_reset: "Redefinir zoom",
            find: "Localizar…",
            toggle_outline: "Alternar índice",
            help: "Ajuda",
            about: "Sobre o MarkRead",
        }
    } else if lang == "es" {
        Labels {
            file: "Archivo",
            open: "Abrir…",
            open_recent: "Abrir reciente",
            no_recent: "Sin archivos recientes",
            quit: "Salir",
            view: "Ver",
            theme: "Tema",
            theme_light: "Claro",
            theme_dark: "Oscuro",
            theme_system: "Sistema",
            language: "Idioma",
            zoom_in: "Ampliar",
            zoom_out: "Reducir",
            zoom_reset: "Restablecer zoom",
            find: "Buscar…",
            toggle_outline: "Alternar índice",
            help: "Ayuda",
            about: "Acerca de MarkRead",
        }
    } else {
        Labels {
            file: "File",
            open: "Open…",
            open_recent: "Open Recent",
            no_recent: "No Recent Files",
            quit: "Quit",
            view: "View",
            theme: "Theme",
            theme_light: "Light",
            theme_dark: "Dark",
            theme_system: "System",
            language: "Language",
            zoom_in: "Zoom In",
            zoom_out: "Zoom Out",
            zoom_reset: "Reset Zoom",
            find: "Find…",
            toggle_outline: "Toggle Outline",
            help: "Help",
            about: "About MarkRead",
        }
    }
}

/// (Re)build the application menu from current settings (language, recents).
/// Called at startup and whenever language or recent files change.
pub fn refresh(app: &AppHandle) -> tauri::Result<()> {
    let app_settings = settings::load(app);
    let l = labels(&app_settings.language);

    let open_item =
        MenuItem::with_id(app, "open", l.open, true, Some("CmdOrCtrl+O"))?;

    let recent_menu =
        Submenu::with_id(app, "recent", l.open_recent, true)?;
    let recents: Vec<String> = app_settings
        .recent_files
        .into_iter()
        .filter(|p| Path::new(p).is_file())
        .collect();
    if recents.is_empty() {
        let empty = MenuItem::with_id(app, "recent-empty", l.no_recent, false, None::<&str>)?;
        recent_menu.append(&empty)?;
    } else {
        for (idx, path) in recents.iter().enumerate() {
            let name = Path::new(path)
                .file_name()
                .map(|s| s.to_string_lossy().into_owned())
                .unwrap_or_else(|| path.clone());
            let item = MenuItem::with_id(
                app,
                &format!("recent-{idx}"),
                &name,
                true,
                None::<&str>,
            )?;
            recent_menu.append(&item)?;
        }
    }

    let file_menu = Submenu::with_id(app, "file", l.file, true)?;
    file_menu.append(&open_item)?;
    file_menu.append(&PredefinedMenuItem::separator(app)?)?;
    file_menu.append(&recent_menu)?;
    #[cfg(not(target_os = "macos"))]
    {
        let quit = MenuItem::with_id(app, "quit", l.quit, true, Some("CmdOrCtrl+Q"))?;
        file_menu.append(&PredefinedMenuItem::separator(app)?)?;
        file_menu.append(&quit)?;
    }

    let theme_light = MenuItem::with_id(app, "theme-light", l.theme_light, true, None::<&str>)?;
    let theme_dark = MenuItem::with_id(app, "theme-dark", l.theme_dark, true, None::<&str>)?;
    let theme_system = MenuItem::with_id(app, "theme-system", l.theme_system, true, None::<&str>)?;
    let theme_menu = Submenu::with_id(app, "theme", l.theme, true)?;
    theme_menu.append(&theme_light)?;
    theme_menu.append(&theme_dark)?;
    theme_menu.append(&theme_system)?;

    let en = CheckMenuItem::with_id(app, "lang-en", "English", true, app_settings.language == "en", None::<&str>)?;
    let pt = CheckMenuItem::with_id(app, "lang-pt-BR", "Português (Brasil)", true, app_settings.language == "pt-BR", None::<&str>)?;
    let es = CheckMenuItem::with_id(app, "lang-es", "Español", true, app_settings.language == "es", None::<&str>)?;
    let lang_menu = Submenu::with_id(app, "language", l.language, true)?;
    lang_menu.append(&en)?;
    lang_menu.append(&pt)?;
    lang_menu.append(&es)?;

    let zoom_in = MenuItem::with_id(app, "zoom-in", l.zoom_in, true, Some("CmdOrCtrl+="))?;
    let zoom_out = MenuItem::with_id(app, "zoom-out", l.zoom_out, true, Some("CmdOrCtrl+-"))?;
    let zoom_reset = MenuItem::with_id(app, "zoom-reset", l.zoom_reset, true, Some("CmdOrCtrl+0"))?;
    let find = MenuItem::with_id(app, "find", l.find, true, Some("CmdOrCtrl+F"))?;
    let outline = MenuItem::with_id(
        app,
        "toggle-outline",
        l.toggle_outline,
        true,
        Some("CmdOrCtrl+Shift+O"),
    )?;

    let view_menu = Submenu::with_id(app, "view", l.view, true)?;
    view_menu.append(&theme_menu)?;
    view_menu.append(&lang_menu)?;
    view_menu.append(&PredefinedMenuItem::separator(app)?)?;
    view_menu.append(&zoom_in)?;
    view_menu.append(&zoom_out)?;
    view_menu.append(&zoom_reset)?;
    view_menu.append(&PredefinedMenuItem::separator(app)?)?;
    view_menu.append(&find)?;
    view_menu.append(&outline)?;

    let about = MenuItem::with_id(app, "about", l.about, true, None::<&str>)?;
    let help_menu = Submenu::with_id(app, "help", l.help, true)?;
    help_menu.append(&about)?;

    let menu = Menu::new(app)?;
    menu.append(&file_menu)?;
    menu.append(&view_menu)?;
    menu.append(&help_menu)?;

    #[cfg(target_os = "macos")]
    {
        app.set_menu(Some(menu))?;
    }
    #[cfg(not(target_os = "macos"))]
    {
        if let Some(window) = app.get_webview_window(MAIN_WINDOW) {
            window.set_menu(menu)?;
        }
    }
    Ok(())
}

/// Route menu events; register once at startup.
pub fn handle_event(app: &AppHandle, id: &str) {
    match id {
        "open" => emit_action(app, "open"),
        "about" => commands::show_about(app),
        "quit" => app.exit(0),
        "theme-light" | "theme-dark" | "theme-system" => {
            let _ = app.emit_to(MAIN_WINDOW, "theme-changed", id.trim_start_matches("theme-"));
        }
        "lang-en" | "lang-pt-BR" | "lang-es" => {
            let language = id.trim_start_matches("lang-").to_string();
            let mut app_settings = settings::load(app);
            if app_settings.language != language {
                app_settings.language = language;
                settings::save(app, &app_settings);
                let _ = refresh(app);
                let _ = app.emit_to(MAIN_WINDOW, "language-changed", app_settings.language);
            }
        }
        id if id.starts_with("recent-") => {
            let index: usize = id.trim_start_matches("recent-").parse().unwrap_or(usize::MAX);
            let recents = settings::load(app).recent_files;
            if let Some(path) = recents.into_iter().filter(|p| Path::new(p).is_file()).nth(index) {
                let _ = app.emit_to(MAIN_WINDOW, "open-file", path);
            }
        }
        other => emit_action(app, other),
    }
}

fn emit_action(app: &AppHandle, action: &str) {
    let _ = app.emit_to(MAIN_WINDOW, "menu-action", action.to_string());
}

/// Focus the main window and route a newly opened file to the frontend.
pub fn open_file_in_app(app: &AppHandle<Wry>, path: String) {
    if let Some(window) = app.get_webview_window(MAIN_WINDOW) {
        let _ = window.show();
        let _ = window.unminimize();
        let _ = window.set_focus();
    }
    let _ = app.emit_to(MAIN_WINDOW, "open-file", path);
}
