use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    env, fs,
    future::Future,
    io::{self, BufRead, BufReader, Write},
    net::{Ipv4Addr, TcpStream},
    path::{Path, PathBuf},
    time::Duration,
};
use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt};

pub const USAGE: &str = "Usage: add <piece folder>, or show <spirit or character>.";
const HOME: &str = "GROVE_COMPANION_HOME";
const FILE: &str = "control.json";
const MAX_REQUEST: u64 = 64 * 1024;
const REQUEST_TIME: Duration = Duration::from_secs(5);
const ANSWER_TIME: Duration = Duration::from_secs(240);

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct Request {
    pub command: String,
    pub value: String,
}

pub fn home() -> Option<PathBuf> {
    env::var_os(HOME).map(PathBuf::from)
}

pub fn file(identifier: &str) -> Option<PathBuf> {
    let dir = |name| env::var_os(name).map(PathBuf::from);
    let data = match home() {
        Some(home) => home,
        None if cfg!(windows) => dir("APPDATA")?.join(identifier),
        None => dir("HOME")?.join("Library/Application Support").join(identifier),
    };
    Some(data.join(FILE))
}

pub fn parse(args: &[String], cwd: &Path) -> Option<Result<Request, String>> {
    let command = args.first().filter(|command| ["add", "show"].contains(&command.as_str()))?;
    Some(match &args[1..] {
        [value] if !value.trim().is_empty() => {
            let value = if command == "add" { cwd.join(value).to_string_lossy().into_owned() } else { value.clone() };
            Ok(Request { command: command.clone(), value })
        }
        _ => Err(USAGE.into()),
    })
}

pub fn send(file: &Path, request: &Request) -> Result<String, String> {
    let down = || "Grove Companion isn’t running.".to_string();
    let silent = || "Grove Companion didn’t answer.".to_string();
    let control: Value = fs::read(file).ok().and_then(|bytes| serde_json::from_slice(&bytes).ok()).ok_or_else(down)?;
    let port = control["port"].as_u64().and_then(|port| u16::try_from(port).ok()).ok_or_else(down)?;
    let mut stream = TcpStream::connect((Ipv4Addr::LOCALHOST, port)).map_err(|_| down())?;
    stream.set_read_timeout(Some(ANSWER_TIME)).map_err(|_| silent())?;
    let asked = json!({ "token": control["token"], "command": request.command, "value": request.value });
    stream.write_all(format!("{asked}\n").as_bytes()).map_err(|_| silent())?;
    let mut line = String::new();
    BufReader::new(&stream).read_line(&mut line).map_err(|_| silent())?;
    let answer: Value = serde_json::from_str(&line).map_err(|_| silent())?;
    let message = answer["message"].as_str().ok_or_else(silent)?.to_string();
    if answer["ok"] == true { Ok(message) } else { Err(message) }
}

fn publish(file: &Path, port: u16, token: &str) -> io::Result<()> {
    if let Some(dir) = file.parent() {
        fs::create_dir_all(dir)?;
    }
    let draft = file.with_extension("new");
    let _ = fs::remove_file(&draft);
    let mut options = fs::OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    std::os::unix::fs::OpenOptionsExt::mode(&mut options, 0o600);
    options.open(&draft)?.write_all(json!({ "port": port, "token": token }).to_string().as_bytes())?;
    fs::rename(draft, file)
}

pub fn listen(file: &Path) -> io::Result<(std::net::TcpListener, String)> {
    let listener = std::net::TcpListener::bind((Ipv4Addr::LOCALHOST, 0))?;
    listener.set_nonblocking(true)?;
    let token = format!("{}{}", uuid::Uuid::new_v4().simple(), uuid::Uuid::new_v4().simple());
    publish(file, listener.local_addr()?.port(), &token)?;
    Ok((listener, token))
}

fn same(given: &str, token: &str) -> bool {
    given.len() == token.len() && given.bytes().zip(token.bytes()).fold(0, |differs, (a, b)| differs | (a ^ b)) == 0
}

async fn handle<F, Fut>(stream: tokio::net::TcpStream, token: String, answer: F)
where
    F: Fn(Request) -> Fut,
    Fut: Future<Output = Result<String, String>>,
{
    let (read, mut write) = stream.into_split();
    let mut line = String::new();
    let asked = tokio::time::timeout(REQUEST_TIME, tokio::io::BufReader::new(read.take(MAX_REQUEST)).read_line(&mut line)).await;
    if !matches!(asked, Ok(Ok(_))) {
        return;
    }
    let Ok(message) = serde_json::from_str::<Value>(&line) else { return };
    if !message["token"].as_str().is_some_and(|given| same(given, &token)) {
        return;
    }
    let Ok(request) = serde_json::from_value::<Request>(message) else { return };
    let (ok, message) = match answer(request).await {
        Ok(message) => (true, message),
        Err(message) => (false, message),
    };
    let _ = write.write_all(format!("{}\n", json!({ "ok": ok, "message": message })).as_bytes()).await;
}

pub async fn serve<F, Fut>(listener: std::net::TcpListener, token: String, answer: F)
where
    F: Fn(Request) -> Fut + Clone + Send + Sync + 'static,
    Fut: Future<Output = Result<String, String>> + Send + 'static,
{
    let listener = match tokio::net::TcpListener::from_std(listener) {
        Ok(listener) => listener,
        Err(err) => return eprintln!("control: {err}"),
    };
    loop {
        match listener.accept().await {
            Ok((stream, _)) => {
                tauri::async_runtime::spawn(handle(stream, token.clone(), answer.clone()));
            }
            Err(_) => tokio::time::sleep(Duration::from_secs(1)).await,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn args(list: &[&str]) -> Vec<String> {
        list.iter().map(|arg| arg.to_string()).collect()
    }

    fn request(command: &str, value: &str) -> Request {
        Request { command: command.into(), value: value.into() }
    }

    fn served(name: &str) -> (PathBuf, String) {
        let file = env::temp_dir().join(format!("companion-control-{}-{name}", std::process::id())).join(FILE);
        let (listener, token) = listen(&file).unwrap();
        std::thread::spawn(move || {
            tauri::async_runtime::block_on(serve(listener, token, |asked: Request| async move {
                if asked.command == "show" { Ok(format!("Showing {}.", asked.value)) } else { Err(format!("{} is missing.", asked.value)) }
            }))
        });
        let token = serde_json::from_slice::<Value>(&fs::read(&file).unwrap()).unwrap()["token"].as_str().unwrap().to_string();
        (file, token)
    }

    #[test]
    fn only_add_and_show_are_commands() {
        let cwd = Path::new("/work");
        assert_eq!(parse(&args(&[]), cwd), None);
        assert_eq!(parse(&args(&["--flag", "add"]), cwd), None);
        assert_eq!(parse(&args(&["show", "Fox"]), cwd), Some(Ok(request("show", "Fox"))));
        assert_eq!(parse(&args(&["add", "piece"]), cwd), Some(Ok(request("add", &cwd.join("piece").to_string_lossy()))));
        for wrong in [&["add"][..], &["show", " "], &["show", "Fox", "Bird"]] {
            assert_eq!(parse(&args(wrong), cwd), Some(Err(USAGE.into())));
        }
    }

    #[test]
    fn a_command_gets_the_apps_answer_and_whether_it_worked() {
        let (file, _) = served("answers");
        assert_eq!(send(&file, &request("show", "Fox")), Ok("Showing Fox.".into()));
        assert_eq!(send(&file, &request("add", "piece.json")), Err("piece.json is missing.".into()));
    }

    #[test]
    fn a_request_without_the_token_is_not_answered() {
        let (file, token) = served("token");
        let port = serde_json::from_slice::<Value>(&fs::read(&file).unwrap()).unwrap()["port"].clone();
        for wrong in [json!("0".repeat(token.len())), json!(""), Value::Null] {
            fs::write(&file, json!({ "port": port, "token": wrong }).to_string()).unwrap();
            assert_eq!(send(&file, &request("show", "Fox")), Err("Grove Companion didn’t answer.".into()));
        }
        fs::write(&file, json!({ "port": port, "token": token }).to_string()).unwrap();
        assert_eq!(send(&file, &request("show", "Fox")), Ok("Showing Fox.".into()));
    }

    #[test]
    fn the_app_listens_on_loopback_only_and_keeps_its_token_private() {
        let file = env::temp_dir().join(format!("companion-control-{}-private", std::process::id())).join(FILE);
        let (listener, token) = listen(&file).unwrap();
        assert!(listener.local_addr().unwrap().ip().is_loopback());
        assert_eq!(token.len(), 64);
        #[cfg(unix)]
        assert_eq!(std::os::unix::fs::PermissionsExt::mode(&fs::metadata(&file).unwrap().permissions()) & 0o777, 0o600);
    }

    #[test]
    fn without_a_running_app_a_command_says_so() {
        let dir = env::temp_dir().join(format!("companion-control-{}-down", std::process::id()));
        assert_eq!(send(&dir.join(FILE), &request("show", "Fox")), Err("Grove Companion isn’t running.".into()));
        let port = std::net::TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).unwrap().local_addr().unwrap().port();
        fs::create_dir_all(&dir).unwrap();
        fs::write(dir.join(FILE), json!({ "port": port, "token": "stale" }).to_string()).unwrap();
        assert_eq!(send(&dir.join(FILE), &request("show", "Fox")), Err("Grove Companion isn’t running.".into()));
    }
}
