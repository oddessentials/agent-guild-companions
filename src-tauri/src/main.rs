#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod characters;
mod manager;

use std::{
    collections::HashSet,
    path::PathBuf,
    sync::{
        atomic::{AtomicBool, Ordering},
        Mutex,
    },
    time::Duration,
};
use serde_json::json;
use tauri::{
    http::{header, Method, Response, StatusCode},
    image::Image,
    menu::{CheckMenuItem, Menu, MenuItem, PredefinedMenuItem, Submenu},
    tray::TrayIconBuilder,
    AppHandle, Emitter, Manager, PhysicalPosition, PhysicalSize, WindowEvent, Wry,
};
use tauri_plugin_dialog::{DialogExt, MessageDialogButtons, MessageDialogKind};
use tokio::sync::oneshot;

static FOLLOWING: AtomicBool = AtomicBool::new(false);

const CURSOR_POLL: Duration = Duration::from_millis(100);
const CHECK_TIME: Duration = Duration::from_secs(60);

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

struct Characters {
    dir: PathBuf,
    menu: Submenu<Wry>,
    shown: Mutex<Option<String>>,
    unavailable: Mutex<HashSet<String>>,
    busy: AtomicBool,
    checking: Mutex<Option<(String, oneshot::Sender<Option<String>>)>>,
}

fn refresh_menu(app: &AppHandle) -> tauri::Result<()> {
    let state = app.state::<Characters>();
    let shown = state.shown.lock().unwrap().clone();
    let unavailable = state.unavailable.lock().unwrap().clone();
    let idle = !state.busy.load(Ordering::SeqCst) && shown.is_some();
    let menu = &state.menu;
    for item in menu.items()? {
        menu.remove(&item)?;
    }
    for (n, name) in SPIRITS.iter().enumerate() {
        menu.append(&CheckMenuItem::with_id(app, format!("spirit-{n}"), *name, shown.is_some(), shown.as_deref() == Some(&n.to_string()), None::<&str>)?)?;
    }
    let added = characters::list_characters(&state.dir);
    if !added.is_empty() {
        menu.append(&PredefinedMenuItem::separator(app)?)?;
    }
    let label = |character: &characters::Character, lost: bool| if lost { format!("{} (can’t be shown)", character.title) } else { character.title.clone() };
    let remove = Submenu::with_id(app, "remove", "Remove character", idle && !added.is_empty())?;
    for character in &added {
        let lost = !character.readable || unavailable.contains(&character.id);
        menu.append(&CheckMenuItem::with_id(app, format!("character-{}", character.id), label(character, lost), shown.is_some() && !lost, shown.as_ref() == Some(&character.id), None::<&str>)?)?;
        remove.append(&MenuItem::with_id(app, format!("remove-{}", character.id), label(character, lost), true, None::<&str>)?)?;
    }
    menu.append(&PredefinedMenuItem::separator(app)?)?;
    menu.append(&MenuItem::with_id(app, "add-character", "Add character…", idle, None::<&str>)?)?;
    menu.append(&remove)?;
    Ok(())
}

fn tell(app: &AppHandle, title: &str, message: String) {
    app.dialog().message(message).title(title).kind(MessageDialogKind::Error).show(|_| {});
}

async fn exclusive<F: std::future::Future<Output = ()>>(app: &AppHandle, work: F) {
    let state = app.state::<Characters>();
    if state.busy.swap(true, Ordering::SeqCst) {
        return;
    }
    let _ = refresh_menu(app);
    work.await;
    state.busy.store(false, Ordering::SeqCst);
    let _ = refresh_menu(app);
}

async fn add_character(app: AppHandle) {
    exclusive(&app, async {
        let (chosen, folder) = oneshot::channel();
        app.dialog().file().set_title("Choose a character folder").pick_folder(move |folder| {
            let _ = chosen.send(folder);
        });
        let Some(folder) = folder.await.ok().flatten() else { return };
        match import(&app, folder.into_path().ok()).await {
            Ok(id) => {
                let _ = app.emit("spirit", json!(id));
            }
            Err(problem) => tell(&app, "This character can’t be added", problem),
        }
    })
    .await;
}

/// Installs the folder's character only once the page has drawn this very import, by its token.
async fn import(app: &AppHandle, folder: Option<PathBuf>) -> Result<String, String> {
    let state = app.state::<Characters>();
    let folder = folder.ok_or("Choose a piece folder.")?;
    let (dir, token) = (state.dir.clone(), characters::new_id());
    let staged = {
        let (dir, token) = (dir.clone(), token.clone());
        tauri::async_runtime::spawn_blocking(move || characters::stage(&dir, &folder, &token)).await
    };
    staged.map_err(|err| err.to_string())??;
    let (answer, verdict) = oneshot::channel();
    *state.checking.lock().unwrap() = Some((token.clone(), answer));
    let _ = app.emit("check-character", &token);
    let verdict = tokio::time::timeout(CHECK_TIME, verdict).await;
    state.checking.lock().unwrap().take();
    let result = match verdict {
        Ok(Ok(None)) => characters::install(&dir, &token).map_err(|err| format!("Grove Companion cannot write to its data folder: {err}")),
        Ok(Ok(Some(problem))) => Err(problem),
        _ => Err("This character took too long to check.".into()),
    };
    if result.is_err() {
        characters::discard(&dir, &token);
    }
    result
}

async fn remove_character(app: AppHandle, id: String) {
    exclusive(&app, async {
        let state = app.state::<Characters>();
        let Some(character) = characters::list_characters(&state.dir).into_iter().find(|character| character.id == id) else { return };
        let (answer, confirmed) = oneshot::channel();
        app.dialog()
            .message(format!("Remove “{}” from Grove Companion? The folder you added it from stays as it is.", character.title))
            .title("Remove character")
            .buttons(MessageDialogButtons::OkCancelCustom("Remove".into(), "Cancel".into()))
            .show(move |yes| {
                let _ = answer.send(yes);
            });
        if !confirmed.await.unwrap_or(false) {
            return;
        }
        match characters::remove(&state.dir, &character.id) {
            Ok(()) => {
                state.unavailable.lock().unwrap().remove(&character.id);
                let _ = app.emit("removed", &character.id);
            }
            Err(err) => tell(&app, "This character can’t be removed", format!("Grove Companion cannot write to its data folder: {err}")),
        }
    })
    .await;
}

/// The page calls this once it is listening, so it does not miss the manager's first message.
#[tauri::command]
fn connect_manager(app: AppHandle) {
    if !FOLLOWING.swap(true, Ordering::SeqCst) {
        tauri::async_runtime::spawn(manager::follow(app));
    }
}

#[tauri::command]
fn spirit_shown(app: AppHandle, id: String) {
    *app.state::<Characters>().shown.lock().unwrap() = Some(id);
    let _ = refresh_menu(&app);
}

#[tauri::command]
fn character_checked(state: tauri::State<Characters>, token: String, problem: Option<String>) {
    let mut checking = state.checking.lock().unwrap();
    if checking.as_ref().is_some_and(|(waiting, _)| *waiting == token) {
        let (_, answer) = checking.take().unwrap();
        let _ = answer.send(problem);
    }
}

#[tauri::command]
fn character_unavailable(app: AppHandle, id: String, problem: String) {
    eprintln!("character {id}: {problem}");
    app.state::<Characters>().unavailable.lock().unwrap().insert(id);
    let _ = refresh_menu(&app);
}

#[tauri::command]
fn report(message: String) {
    eprintln!("{message}");
}

fn model_response(app: &AppHandle, method: &Method, path: &str) -> Response<Vec<u8>> {
    let state = app.try_state::<Characters>();
    let body = state.filter(|_| method == Method::GET).and_then(|state| {
        let checking = state.checking.lock().unwrap().as_ref().map(|(token, _)| token.clone());
        std::fs::read(characters::model_file(&state.dir, path, checking.as_deref())?).ok()
    });
    let response = Response::builder().header(header::ACCESS_CONTROL_ALLOW_ORIGIN, "*");
    match body {
        Some(body) => response.header(header::CONTENT_TYPE, "model/gltf-binary").body(body),
        None => response.status(StatusCode::NOT_FOUND).body(Vec::new()),
    }
    .expect("a model response is well formed")
}

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|_, _, _| {}))
        .plugin(tauri_plugin_dialog::init())
        .register_asynchronous_uri_scheme_protocol("character", |context, request, responder| {
            let app = context.app_handle().clone();
            let (method, path) = (request.method().clone(), request.uri().path().to_string());
            tauri::async_runtime::spawn_blocking(move || responder.respond(model_response(&app, &method, &path)));
        })
        .invoke_handler(tauri::generate_handler![connect_manager, spirit_shown, character_checked, character_unavailable, report])
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

            let dir = app.path().app_data_dir()?.join("characters");
            characters::sweep(&dir);
            let spirit_menu = Submenu::with_id(app, "spirit", "Spirit", true)?;
            app.manage(Characters { dir, menu: spirit_menu.clone(), shown: Mutex::new(None), unavailable: Mutex::default(), busy: AtomicBool::new(false), checking: Mutex::new(None) });
            refresh_menu(app.handle())?;

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
                    } else if id == "add-character" {
                        tauri::async_runtime::spawn(add_character(app.clone()));
                    } else if let Some(character) = id.strip_prefix("remove-").filter(|id| characters::is_id(id)) {
                        tauri::async_runtime::spawn(remove_character(app.clone(), character.to_string()));
                    } else if let Some(n) = id.strip_prefix("spirit-").and_then(|n| n.parse::<usize>().ok()) {
                        let _ = app.emit("spirit", json!(n));
                    } else if let Some(character) = id.strip_prefix("character-").filter(|id| characters::is_id(id)) {
                        let _ = app.emit("spirit", json!(character));
                    }
                })
                .build(app)?;
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("the companion could not start");
}
