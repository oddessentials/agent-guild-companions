#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod manager;

use std::{
    sync::{
        atomic::{AtomicBool, Ordering},
        Mutex,
    },
    time::Duration,
};
use tauri::{
    menu::{CheckMenuItem, Menu, MenuItem, Submenu},
    image::Image,
    tray::TrayIconBuilder,
    AppHandle, Emitter, Manager, PhysicalPosition, PhysicalSize, WindowEvent, Wry,
};

static FOLLOWING: AtomicBool = AtomicBool::new(false);

const CURSOR_POLL: Duration = Duration::from_millis(100);

static BOUNDS: Mutex<(PhysicalPosition<i32>, PhysicalSize<u32>)> =
    Mutex::new((PhysicalPosition { x: 0, y: 0 }, PhysicalSize { width: 0, height: 0 }));

async fn follow_cursor(app: AppHandle) {
    let mut inside = false;
    while app.get_webview_window("main").is_some() {
        tokio::time::sleep(CURSOR_POLL).await;
        let Ok(cursor) = app.cursor_position() else { continue };
        let (at, size) = *BOUNDS.lock().unwrap();
        let x = cursor.x.floor() as i32 - at.x;
        let y = cursor.y.floor() as i32 - at.y;
        let over = x >= 0 && y >= 0 && x < size.width as i32 && y < size.height as i32;
        if over {
            let _ = app.emit("cursor", Some(PhysicalPosition::new(x, y)));
        } else if inside {
            let _ = app.emit("cursor", None::<PhysicalPosition<i32>>);
        }
        inside = over;
    }
}

/// In model order: spirit_0 to spirit_5.
const SPIRITS: [&str; 6] = ["Fox", "Moss deer", "Water spirit", "Bird", "Lantern", "Hermit crab"];

struct Spirits(Vec<CheckMenuItem<Wry>>);

/// The page calls this once it is listening, so it does not miss the manager's first message.
#[tauri::command]
fn connect_manager(app: AppHandle) {
    if !FOLLOWING.swap(true, Ordering::SeqCst) {
        tauri::async_runtime::spawn(manager::follow(app));
    }
}

#[tauri::command]
fn spirit_shown(spirits: tauri::State<Spirits>, n: usize) {
    for (i, item) in spirits.0.iter().enumerate() {
        let _ = item.set_enabled(true);
        let _ = item.set_checked(i == n);
    }
}

#[tauri::command]
fn report(message: String) {
    eprintln!("{message}");
}

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|_, _, _| {}))
        .invoke_handler(tauri::generate_handler![connect_manager, spirit_shown, report])
        .on_window_event(|_, event| match event {
            WindowEvent::Moved(at) => BOUNDS.lock().unwrap().0 = *at,
            WindowEvent::Resized(size) => BOUNDS.lock().unwrap().1 = *size,
            _ => {}
        })
        .setup(|app| {
            // A desktop companion, not an app to switch to: no Dock icon.
            #[cfg(target_os = "macos")]
            app.set_activation_policy(tauri::ActivationPolicy::Accessory);

            let window = app.get_webview_window("main").expect("the main window is in tauri.conf.json");
            if let Some(monitor) = window.primary_monitor()? {
                let area = monitor.work_area();
                let size = window.outer_size()?;
                window.set_position(PhysicalPosition::new(
                    area.position.x + area.size.width as i32 - size.width as i32 - 24,
                    area.position.y + area.size.height as i32 - size.height as i32,
                ))?;
            }
            *BOUNDS.lock().unwrap() = (window.outer_position()?, window.outer_size()?);
            tauri::async_runtime::spawn(follow_cursor(app.handle().clone()));

            let spirits = SPIRITS
                .iter()
                .enumerate()
                .map(|(n, name)| CheckMenuItem::with_id(app, format!("spirit-{n}"), *name, false, false, None::<&str>))
                .collect::<tauri::Result<Vec<_>>>()?;
            let spirit_menu = Submenu::with_id(app, "spirit", "Spirit", true)?;
            for item in &spirits {
                spirit_menu.append(item)?;
            }
            app.manage(Spirits(spirits));

            let menu = Menu::new(app)?;
            menu.append(&spirit_menu)?;
            menu.append(&MenuItem::with_id(app, "quit", "Quit", true, None::<&str>)?)?;
            TrayIconBuilder::new()
                .icon(Image::from_bytes(include_bytes!("../icons/tray.png"))?)
                .tooltip("Grove Companion")
                .menu(&menu)
                .on_menu_event(|app, event| {
                    let id = event.id().as_ref();
                    if id == "quit" {
                        app.exit(0);
                    } else if let Some(n) = id.strip_prefix("spirit-").and_then(|n| n.parse::<usize>().ok()) {
                        let _ = app.emit("spirit", n);
                    }
                })
                .build(app)?;
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("the companion could not start");
}
