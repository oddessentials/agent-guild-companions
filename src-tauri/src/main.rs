#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod characters;
mod control;
mod manager;
mod startup;

use std::{
    collections::{HashMap, HashSet},
    path::PathBuf,
    sync::{
        atomic::{AtomicBool, AtomicU64, Ordering},
        Mutex,
    },
    time::Duration,
};
use serde_json::json;
use tauri::{
    http::{header, Method, Response, StatusCode},
    image::Image,
    menu::{CheckMenuItem, Menu, MenuItem, PredefinedMenuItem, Submenu},
    tray::{TrayIconBuilder, TrayIconEvent},
    AppHandle, Emitter, Manager, PhysicalPosition, PhysicalSize, WindowEvent, Wry,
};
use tauri_plugin_dialog::{DialogExt, MessageDialogButtons, MessageDialogKind};
use tokio::sync::{oneshot, watch};

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
    shown: watch::Sender<Option<String>>,
    order: AtomicU64,
    choosing: Mutex<HashMap<String, oneshot::Sender<Option<String>>>>,
    unavailable: Mutex<HashSet<String>>,
    busy: AtomicBool,
    checking: Mutex<Option<(String, oneshot::Sender<Option<String>>)>>,
}

#[derive(Debug, PartialEq)]
enum Entry {
    Check { id: String, label: String, enabled: bool, checked: bool },
    Item { id: String, label: String, enabled: bool },
    Separator,
    Submenu { id: String, label: String, enabled: bool, items: Vec<Entry> },
}

fn menu_entries(shown: Option<&str>, added: &[characters::Character], unavailable: &HashSet<String>, busy: bool) -> Vec<Entry> {
    let idle = !busy && shown.is_some();
    let mut entries: Vec<Entry> = SPIRITS
        .iter()
        .enumerate()
        .map(|(n, name)| Entry::Check { id: format!("spirit-{n}"), label: name.to_string(), enabled: shown.is_some(), checked: shown == Some(n.to_string().as_str()) })
        .collect();
    if !added.is_empty() {
        entries.push(Entry::Separator);
    }
    let mut removals = Vec::new();
    for character in added {
        let lost = !character.readable || unavailable.contains(&character.id);
        let label = if lost { format!("{} (can’t be shown)", character.title) } else { character.title.clone() };
        entries.push(Entry::Check { id: format!("character-{}", character.id), label: label.clone(), enabled: shown.is_some() && !lost, checked: shown == Some(character.id.as_str()) });
        removals.push(Entry::Item { id: format!("remove-{}", character.id), label, enabled: true });
    }
    entries.push(Entry::Separator);
    entries.push(Entry::Item { id: "add-character".into(), label: "Add character…".into(), enabled: idle });
    entries.push(Entry::Submenu { id: "remove".into(), label: "Remove character".into(), enabled: idle && !added.is_empty(), items: removals });
    entries
}

fn append(app: &AppHandle, menu: &Submenu<Wry>, entries: &[Entry]) -> tauri::Result<()> {
    for entry in entries {
        match entry {
            Entry::Check { id, label, enabled, checked } => menu.append(&CheckMenuItem::with_id(app, id, label, *enabled, *checked, None::<&str>)?)?,
            Entry::Item { id, label, enabled } => menu.append(&MenuItem::with_id(app, id, label, *enabled, None::<&str>)?)?,
            Entry::Separator => menu.append(&PredefinedMenuItem::separator(app)?)?,
            Entry::Submenu { id, label, enabled, items } => {
                let submenu = Submenu::with_id(app, id, label, *enabled)?;
                append(app, &submenu, items)?;
                menu.append(&submenu)?;
            }
        }
    }
    Ok(())
}

/// One main-thread task per rebuild, reading the state when it runs, so rebuilds never interleave and a queued one is never stale.
fn refresh_menu(app: &AppHandle) {
    let app = app.clone();
    let task = app.clone();
    let _ = task.run_on_main_thread(move || {
        let state = app.state::<Characters>();
        let shown = state.shown.borrow().clone();
        let unavailable = state.unavailable.lock().unwrap().clone();
        let entries = menu_entries(shown.as_deref(), &characters::list_characters(&state.dir), &unavailable, state.busy.load(Ordering::SeqCst));
        let rebuilt = state.menu.items().and_then(|items| items.iter().try_for_each(|item| state.menu.remove(item))).and_then(|_| append(&app, &state.menu, &entries));
        if let Err(err) = rebuilt {
            eprintln!("menu: {err}");
        }
    });
}

fn tell(app: &AppHandle, title: &str, message: String) {
    app.dialog().message(message).title(title).kind(MessageDialogKind::Error).show(|_| {});
}

/// What the Start at sign-in tick last showed, so a click applies the opposite of what the person saw.
static STARTUP_SHOWN: Mutex<Option<bool>> = Mutex::new(None);

/// The tick follows what the system holds, whether or not the change went through.
fn toggle_startup(app: &AppHandle) {
    let on = startup::chosen(&mut STARTUP_SHOWN.lock().unwrap());
    if let Some(on) = on {
        if let Err(err) = startup::set(&startup::entry(&app.config().identifier), on) {
            tell(app, "This setting can’t be changed", format!("Grove Companion could not change whether it starts when you sign in: {err}"));
        }
    }
    show_startup(app);
}

fn show_startup(app: &AppHandle) {
    let (item, now) = (app.state::<CheckMenuItem<Wry>>(), startup::state(&startup::entry(&app.config().identifier)));
    *STARTUP_SHOWN.lock().unwrap() = now;
    let _ = item.set_checked(now == Some(true)).and_then(|_| item.set_enabled(now.is_some()));
}

async fn exclusive<T>(app: &AppHandle, work: impl std::future::Future<Output = T>) -> Option<T> {
    let state = app.state::<Characters>();
    if state.busy.swap(true, Ordering::SeqCst) {
        return None;
    }
    refresh_menu(app);
    let done = work.await;
    state.busy.store(false, Ordering::SeqCst);
    refresh_menu(app);
    Some(done)
}

/// Taken when a choice is made, not when it is ready to show, so the page can tell which of two is the newer.
fn issue(app: &AppHandle) -> u64 {
    app.state::<Characters>().order.fetch_add(1, Ordering::SeqCst) + 1
}

fn select(app: &AppHandle, spirit: &str, order: u64, request: Option<&str>) {
    let spirit = spirit.parse::<usize>().map_or(json!(spirit), |n| json!(n));
    let _ = app.emit("spirit", json!({ "spirit": spirit, "order": order, "request": request }));
}

async fn add_character(app: AppHandle) {
    let order = issue(&app);
    exclusive(&app, async {
        let (chosen, folder) = oneshot::channel();
        app.dialog().file().set_title("Choose a character folder").pick_folder(move |folder| {
            let _ = chosen.send(folder);
        });
        let Some(folder) = folder.await.ok().flatten() else { return };
        match import(&app, folder.into_path().ok()).await {
            Ok(id) => select(&app, &id, order, None),
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

fn spirit_named(name: &str, added: &[characters::Character], unavailable: &HashSet<String>) -> Result<(String, String), String> {
    let name = name.trim();
    let titled: Vec<&characters::Character> = added.iter().filter(|character| character.title.to_lowercase() == name.to_lowercase()).collect();
    let character = match (added.iter().find(|character| character.id == name), SPIRITS.iter().position(|spirit| spirit.eq_ignore_ascii_case(name)), titled.as_slice()) {
        (Some(character), _, _) => character,
        (None, Some(n), _) => return Ok((n.to_string(), SPIRITS[n].to_string())),
        (None, None, [character]) => *character,
        (None, None, []) => return Err(format!("There is no spirit or character called “{name}”. The spirits are {}.", SPIRITS.join(", "))),
        (None, None, several) => return Err(format!("More than one character is called “{name}”. Use an id instead: {}.", several.iter().map(|character| character.id.as_str()).collect::<Vec<_>>().join(", "))),
    };
    if !character.readable || unavailable.contains(&character.id) {
        return Err(format!("“{}” can’t be shown.", character.title));
    }
    Ok((character.id.clone(), character.title.clone()))
}

async fn show(app: &AppHandle, id: &str, order: u64) -> Result<(), String> {
    let state = app.state::<Characters>();
    let (token, (answer, outcome)) = (characters::new_id(), oneshot::channel());
    state.choosing.lock().unwrap().insert(token.clone(), answer);
    select(app, id, order, Some(&token));
    let outcome = tokio::time::timeout(CHECK_TIME, outcome).await;
    state.choosing.lock().unwrap().remove(&token);
    match outcome {
        Ok(Ok(None)) => Ok(()),
        Ok(Ok(Some(problem))) => Err(problem),
        _ => Err("It took too long to show.".into()),
    }
}

async fn answer(app: AppHandle, request: control::Request) -> Result<String, String> {
    let order = issue(&app);
    let state = app.state::<Characters>();
    let mut shown = state.shown.subscribe();
    if !tokio::time::timeout(CHECK_TIME, shown.wait_for(Option::is_some)).await.is_ok_and(|ready| ready.is_ok()) {
        return Err("Grove Companion is still starting. Try again in a moment.".into());
    }
    match request.command.as_str() {
        "add" => exclusive(&app, async {
            let id = import(&app, Some(request.value.into())).await?;
            let title = characters::list_characters(&state.dir).into_iter().find(|character| character.id == id).map_or_else(|| id.clone(), |character| character.title);
            show(&app, &id, order).await.map_err(|why| format!("Added “{title}”, but it isn’t shown: {why}"))?;
            Ok(format!("Added “{title}” and showing it."))
        })
        .await
        .unwrap_or_else(|| Err("Grove Companion is busy adding or removing a character. Try again in a moment.".into())),
        "show" => {
            let unavailable = state.unavailable.lock().unwrap().clone();
            let (id, label) = spirit_named(&request.value, &characters::list_characters(&state.dir), &unavailable)?;
            show(&app, &id, order).await.map_err(|why| format!("{label} isn’t shown: {why}"))?;
            Ok(format!("Showing {label}."))
        }
        _ => Err(control::USAGE.into()),
    }
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
    app.state::<Characters>().shown.send_replace(Some(id));
    refresh_menu(&app);
}

#[tauri::command]
fn spirit_chosen(state: tauri::State<Characters>, request: String, problem: Option<String>) {
    if let Some(answer) = state.choosing.lock().unwrap().remove(&request) {
        let _ = answer.send(problem);
    }
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
    refresh_menu(&app);
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
    let context = tauri::generate_context!();
    let args: Vec<String> = std::env::args_os().skip(1).map(|arg| arg.to_string_lossy().into_owned()).collect();
    if let Some(asked) = control::parse(&args, &std::env::current_dir().unwrap_or_default()) {
        let (code, said) = match asked.map(|request| control::file(&context.config().identifier).ok_or_else(|| "Grove Companion isn’t running.".to_string()).and_then(|file| control::send(&file, &request))) {
            Ok(Ok(said)) => (0, said),
            Ok(Err(why)) => (1, why),
            Err(usage) => (2, usage),
        };
        println!("{said}");
        std::process::exit(code);
    }
    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|_, _, _| {}))
        .plugin(tauri_plugin_dialog::init())
        .register_asynchronous_uri_scheme_protocol("character", |context, request, responder| {
            let app = context.app_handle().clone();
            let (method, path) = (request.method().clone(), request.uri().path().to_string());
            tauri::async_runtime::spawn_blocking(move || responder.respond(model_response(&app, &method, &path)));
        })
        .invoke_handler(tauri::generate_handler![connect_manager, spirit_shown, spirit_chosen, character_checked, character_unavailable, report])
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

            let dir = match control::home() {
                Some(home) => home,
                None => app.path().app_data_dir()?,
            }
            .join("characters");
            characters::sweep(&dir);
            let spirit_menu = Submenu::with_id(app, "spirit", "Spirit", true)?;
            app.manage(Characters { dir, menu: spirit_menu.clone(), shown: watch::channel(None).0, order: AtomicU64::new(0), choosing: Mutex::default(), unavailable: Mutex::default(), busy: AtomicBool::new(false), checking: Mutex::new(None) });
            refresh_menu(app.handle());
            match control::file(&app.config().identifier).ok_or_else(|| std::io::Error::other("no data folder")).and_then(|file| control::listen(&file)) {
                Ok((listener, token)) => {
                    let handle = app.handle().clone();
                    tauri::async_runtime::spawn(control::serve(listener, token, move |request| answer(handle.clone(), request)));
                }
                Err(err) => eprintln!("control: {err}"),
            }

            let menu = Menu::new(app)?;
            menu.append(&spirit_menu)?;
            let starts = startup::state(&startup::entry(&app.config().identifier));
            *STARTUP_SHOWN.lock().unwrap() = starts;
            let startup_item = CheckMenuItem::with_id(app, "startup", startup::LABEL, starts.is_some(), starts == Some(true), None::<&str>)?;
            menu.append(&startup_item)?;
            app.manage(startup_item);
            menu.append(&MenuItem::with_id(app, "quit", "Quit", true, None::<&str>)?)?;
            TrayIconBuilder::new()
                .icon(Image::from_bytes(include_bytes!("../icons/tray.png"))?)
                .tooltip("Grove Companion")
                .menu(&menu)
                .on_tray_icon_event(|tray, event| {
                    if matches!(event, TrayIconEvent::Enter { .. } | TrayIconEvent::Click { .. }) {
                        show_startup(tray.app_handle());
                    }
                })
                .on_menu_event(|app, event| {
                    let id = event.id().as_ref();
                    if id == "quit" {
                        app.exit(0);
                    } else if id == "startup" {
                        toggle_startup(app);
                    } else if id == "add-character" {
                        tauri::async_runtime::spawn(add_character(app.clone()));
                    } else if let Some(character) = id.strip_prefix("remove-").filter(|id| characters::is_id(id)) {
                        tauri::async_runtime::spawn(remove_character(app.clone(), character.to_string()));
                    } else if let Some(n) = id.strip_prefix("spirit-").and_then(|n| n.parse::<usize>().ok()) {
                        select(app, &n.to_string(), issue(app), None);
                    } else if let Some(character) = id.strip_prefix("character-").filter(|id| characters::is_id(id)) {
                        select(app, character, issue(app), None);
                    }
                })
                .build(app)?;
            Ok(())
        })
        .run(context)
        .expect("the companion could not start");
}

#[cfg(test)]
mod tests {
    use super::*;

    fn character(n: u8, readable: bool) -> characters::Character {
        characters::Character { id: format!("00000000-0000-4000-8000-00000000000{n}"), title: format!("Piece {n}"), readable }
    }

    fn flat(entries: &[Entry]) -> Vec<(&str, &Entry)> {
        entries
            .iter()
            .flat_map(|entry| match entry {
                Entry::Check { id, .. } | Entry::Item { id, .. } => vec![(id.as_str(), entry)],
                Entry::Submenu { id, items, .. } => [vec![(id.as_str(), entry)], flat(items)].concat(),
                Entry::Separator => vec![],
            })
            .collect()
    }

    fn find<'a>(entries: &'a [Entry], wanted: &str) -> &'a Entry {
        flat(entries).into_iter().find(|(id, _)| *id == wanted).unwrap_or_else(|| panic!("no {wanted}")).1
    }

    #[test]
    fn every_entry_is_listed_once() {
        let added = [character(1, true), character(2, false)];
        let entries = menu_entries(Some("3"), &added, &HashSet::new(), false);
        let all: Vec<&str> = flat(&entries).into_iter().map(|(id, _)| id).collect();
        assert_eq!(all.len(), all.iter().collect::<HashSet<_>>().len(), "{all:?}");
        assert_eq!(all.len(), 6 + 2 + 1 + 1 + 2);
    }

    #[test]
    fn a_character_that_cannot_be_shown_can_still_be_removed() {
        let (good, damaged, lost) = (character(1, true), character(2, false), character(3, true));
        let entries = menu_entries(Some(&good.id), &[good.clone(), damaged.clone(), lost.clone()], &HashSet::from([lost.id.clone()]), false);
        for piece in [&damaged, &lost] {
            assert!(matches!(find(&entries, &format!("character-{}", piece.id)), Entry::Check { enabled: false, label, .. } if label.ends_with("(can’t be shown)")));
            assert!(matches!(find(&entries, &format!("remove-{}", piece.id)), Entry::Item { enabled: true, .. }));
        }
        assert!(matches!(find(&entries, &format!("character-{}", good.id)), Entry::Check { enabled: true, checked: true, .. }));
        assert!(matches!(find(&entries, "remove"), Entry::Submenu { enabled: true, .. }));
    }

    #[test]
    fn a_spirit_or_character_is_found_by_name_title_or_id() {
        let (good, twin, lost) = (character(1, true), characters::Character { title: "piece 1".into(), ..character(2, true) }, character(3, true));
        let unavailable = HashSet::from([lost.id.clone()]);
        assert_eq!(spirit_named(" moss DEER ", &[], &unavailable), Ok(("1".into(), "Moss deer".into())));
        assert_eq!(spirit_named("Piece 1", &[good.clone()], &unavailable), Ok((good.id.clone(), "Piece 1".into())));
        assert_eq!(spirit_named(&twin.id, &[good.clone(), twin.clone()], &unavailable), Ok((twin.id.clone(), "piece 1".into())));
        assert_eq!(spirit_named("Piece 1", &[good.clone(), twin.clone()], &unavailable), Err(format!("More than one character is called “Piece 1”. Use an id instead: {}, {}.", good.id, twin.id)));
        assert_eq!(spirit_named("Piece 3", &[lost.clone()], &unavailable), Err("“Piece 3” can’t be shown.".into()));
        assert_eq!(spirit_named("Piece 2", &[character(2, false)], &unavailable), Err("“Piece 2” can’t be shown.".into()));
        assert!(spirit_named("Nobody", &[good], &unavailable).unwrap_err().starts_with("There is no spirit or character called “Nobody”. The spirits are Fox, "));
    }

    #[test]
    fn nothing_changes_while_busy_or_before_the_page_reports() {
        let added = [character(1, true)];
        for (shown, busy) in [(Some("3"), true), (None, false)] {
            let entries = menu_entries(shown, &added, &HashSet::new(), busy);
            assert!(matches!(find(&entries, "add-character"), Entry::Item { enabled: false, .. }));
            assert!(matches!(find(&entries, "remove"), Entry::Submenu { enabled: false, .. }));
        }
        assert!(matches!(find(&menu_entries(None, &added, &HashSet::new(), false), "spirit-3"), Entry::Check { enabled: false, checked: false, .. }));
        assert!(matches!(find(&menu_entries(Some("3"), &[], &HashSet::new(), false), "remove"), Entry::Submenu { enabled: false, .. }));
    }
}
