#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod manager;

use serde::Serialize;
use std::sync::atomic::{AtomicBool, Ordering};
use tauri::{
    menu::{CheckMenuItem, Menu, MenuItem, PredefinedMenuItem},
    tray::TrayIconBuilder,
    AppHandle, Emitter, Manager, PhysicalPosition,
};

const SPIRITS: [&str; 6] = ["Fox", "Deer", "Water spirit", "Bird", "Stone lantern", "Hermit crab"];

static FOLLOWING: AtomicBool = AtomicBool::new(false);

#[derive(Serialize)]
struct Startup {
    spirit: Option<u8>,
}

/// COMPANION_SPIRIT picks a spirit for checking the art; otherwise the page uses the one last chosen.
#[tauri::command]
fn startup() -> Startup {
    Startup { spirit: std::env::var("COMPANION_SPIRIT").ok().and_then(|value| value.parse().ok()).filter(|n| *n < 6) }
}

/// The page calls this once it is listening, so it does not miss the manager's first message.
#[tauri::command]
fn connect_manager(app: AppHandle) {
    if !FOLLOWING.swap(true, Ordering::SeqCst) {
        tauri::async_runtime::spawn(manager::follow(app));
    }
}

#[tauri::command]
fn report(message: String) {
    eprintln!("{message}");
}

fn main() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![startup, connect_manager, report])
        .setup(|app| {
            let window = app.get_webview_window("main").expect("the main window is in tauri.conf.json");
            // COMPANION_SIZE=<width>x<height> tries other sizes while judging the art.
            let wanted = std::env::var("COMPANION_SIZE").ok().and_then(|value| {
                let (width, height) = value.split_once('x')?;
                Some((width.parse::<f64>().ok()?, height.parse::<f64>().ok()?))
            });
            if let Some((width, height)) = wanted {
                window.set_size(tauri::LogicalSize::new(width, height))?;
            }
            if let Some(monitor) = window.primary_monitor()? {
                let area = monitor.work_area();
                let size = window.outer_size()?;
                window.set_position(PhysicalPosition::new(
                    area.position.x + area.size.width as i32 - size.width as i32 - 24,
                    area.position.y + area.size.height as i32 - size.height as i32,
                ))?;
            }

            let menu = Menu::new(app)?;
            let mut choices = Vec::new();
            for (n, name) in SPIRITS.iter().enumerate() {
                let item = CheckMenuItem::with_id(app, format!("spirit:{n}"), *name, true, false, None::<&str>)?;
                menu.append(&item)?;
                choices.push(item);
            }
            menu.append(&PredefinedMenuItem::separator(app)?)?;
            menu.append(&MenuItem::with_id(app, "quit", "Quit", true, None::<&str>)?)?;
            TrayIconBuilder::new()
                .icon(app.default_window_icon().expect("tauri.conf.json names the icons").clone())
                .tooltip("Grove Companion")
                .menu(&menu)
                .on_menu_event(move |app, event| match event.id().as_ref() {
                    "quit" => app.exit(0),
                    id => {
                        if let Some(n) = id.strip_prefix("spirit:").and_then(|n| n.parse::<usize>().ok()) {
                            for (each, choice) in choices.iter().enumerate() {
                                let _ = choice.set_checked(each == n);
                            }
                            let _ = app.emit("spirit", n);
                        }
                    }
                })
                .build(app)?;
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("the companion could not start");
}
