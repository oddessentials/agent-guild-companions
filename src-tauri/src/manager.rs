//! The connection to Agent Guild's session manager (docs/api.md in agent-guild).
//! It stays on this side so the page never holds the token, which gives full control of every terminal.

use futures_util::StreamExt;
use serde_json::{json, Map, Value};
use std::{path::PathBuf, time::Duration};
use tauri::{AppHandle, Emitter};
use tokio_tungstenite::{
    connect_async,
    tungstenite::{client::IntoClientRequest, http::header::AUTHORIZATION, Message},
};

const RETRY: Duration = Duration::from_secs(2);

/// As in the manager's src/manager/config.mjs.
fn data_dir() -> Option<PathBuf> {
    if let Some(home) = std::env::var_os("AGENT_GUILD_HOME") {
        return Some(home.into());
    }
    let env_dir = |name| std::env::var_os(name).map(PathBuf::from);
    if cfg!(windows) {
        Some(env_dir("APPDATA")?.join("AgentGuild"))
    } else {
        Some(env_dir("HOME")?.join("Library/Application Support/AgentGuild"))
    }
}

fn request() -> Option<tokio_tungstenite::tungstenite::handshake::client::Request> {
    let dir = data_dir()?;
    let manager: Value = serde_json::from_str(&std::fs::read_to_string(dir.join("manager.json")).ok()?).ok()?;
    let token = std::fs::read_to_string(dir.join("auth-token")).ok()?;
    let port = manager.get("port")?.as_u64()?;
    let mut request = format!("ws://127.0.0.1:{port}/api/v1/events").into_client_request().ok()?;
    request.headers_mut().insert(AUTHORIZATION, format!("Bearer {}", token.trim()).parse().ok()?);
    Some(request)
}

fn pick(from: &Value, fields: &[&str]) -> Value {
    let mut out = Map::new();
    for field in fields {
        if let Some(value) = from.get(*field) {
            out.insert((*field).to_string(), value.clone());
        }
    }
    Value::Object(out)
}

/// Only what staging reads (docs/yard/CONTRACT.md in agent-guild), so folders and tasks stay out of the page.
fn session(from: &Value) -> Value {
    let mut out = pick(from, &["id", "status", "activity", "lastOutputAt", "startedAt", "createdAt", "exitedAt", "exitCode", "signal", "multiplexer"]);
    let list = |name: &str, fields: &[&str]| -> Value {
        Value::Array(from.get(name).and_then(Value::as_array).map(|items| items.iter().map(|item| pick(item, fields)).collect()).unwrap_or_default())
    };
    out["agents"] = list("agents", &["id", "name", "status"]);
    out["shells"] = list("shells", &["id", "kind"]);
    out
}

fn event_for_page(message: &Value) -> Option<Value> {
    match message.get("type")?.as_str()? {
        "hello" => Some(json!({ "type": "hello", "sessions": message.get("sessions")?.as_array()?.iter().map(session).collect::<Vec<_>>() })),
        kind @ ("session.created" | "session.updated") => Some(json!({ "type": kind, "session": session(message.get("session")?) })),
        "session.removed" => Some(json!({ "type": "session.removed", "sessionId": message.get("sessionId")? })),
        _ => None,
    }
}

/// Keeps a connection open for as long as the app runs. A stopped manager reads as no sessions.
pub async fn follow(app: AppHandle) {
    let mut connected = false;
    loop {
        if let Some(request) = request() {
            if let Ok((mut socket, _)) = connect_async(request).await {
                connected = true;
                eprintln!("manager: connected");
                // Reading answers the manager's heartbeat pings.
                while let Some(Ok(frame)) = socket.next().await {
                    let Message::Text(text) = frame else { continue };
                    let Ok(message) = serde_json::from_str::<Value>(&text) else { continue };
                    if let Some(event) = event_for_page(&message) {
                        let _ = app.emit("manager", event);
                    }
                }
            }
        }
        if connected {
            connected = false;
            eprintln!("manager: disconnected");
            let _ = app.emit("manager", json!({ "type": "disconnected" }));
        }
        tokio::time::sleep(RETRY).await;
    }
}
