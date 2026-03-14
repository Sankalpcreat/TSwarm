use portable_pty::{native_pty_system, CommandBuilder, PtySize};
use serde::Serialize;
use std::{
    collections::HashMap,
    fs,
    io::{Read, Write},
    path::PathBuf,
    sync::{Arc, Mutex},
};
use tauri::{AppHandle, Emitter};
use uuid::Uuid;

struct Session {
    master: Mutex<Box<dyn portable_pty::MasterPty + Send>>,
    writer: Mutex<Box<dyn Write + Send>>,
    child: Mutex<Box<dyn portable_pty::Child + Send + Sync>>,
}

struct SessionState {
    sessions: Mutex<HashMap<String, Arc<Session>>>,
}

impl SessionState {
    fn new() -> Self {
        Self {
            sessions: Mutex::new(HashMap::new()),
        }
    }
}

#[derive(Serialize)]
struct SessionInfo {
    id: String,
}

#[derive(Serialize, Clone)]
struct TerminalData {
    id: String,
    data: String,
}

#[derive(Serialize)]
struct FileEntry {
    name: String,
    path: String,
    is_dir: bool,
    size: u64,
    modified: u64,
}

#[tauri::command]
fn default_root() -> Result<String, String> {
    let home = if cfg!(windows) {
        std::env::var("USERPROFILE")
    } else {
        std::env::var("HOME")
    };

    if let Ok(home) = home {
        return Ok(home);
    }

    std::env::current_dir()
        .map(|cwd| cwd.to_string_lossy().to_string())
        .map_err(|e| e.to_string())
}

#[tauri::command]
fn list_dir(path: String) -> Result<Vec<FileEntry>, String> {
    let dir = PathBuf::from(path);
    let mut entries = Vec::new();

    for entry in fs::read_dir(&dir).map_err(|e| e.to_string())? {
        let entry = entry.map_err(|e| e.to_string())?;
        let meta = entry.metadata().map_err(|e| e.to_string())?;
        let name = entry
            .file_name()
            .to_string_lossy()
            .to_string();
        let path = entry.path().to_string_lossy().to_string();
        let is_dir = meta.is_dir();
        let size = if is_dir { 0 } else { meta.len() };
        let modified = meta
            .modified()
            .ok()
            .and_then(|m| m.elapsed().ok())
            .map(|e| e.as_secs())
            .unwrap_or(0);

        entries.push(FileEntry {
            name,
            path,
            is_dir,
            size,
            modified,
        });
    }

    entries.sort_by(|a, b| {
        match (a.is_dir, b.is_dir) {
            (true, false) => std::cmp::Ordering::Less,
            (false, true) => std::cmp::Ordering::Greater,
            _ => a.name.to_lowercase().cmp(&b.name.to_lowercase()),
        }
    });

    Ok(entries)
}

#[tauri::command]
fn create_session(
    app: AppHandle,
    state: tauri::State<SessionState>,
    shell: Option<String>,
    cwd: Option<String>,
) -> Result<SessionInfo, String> {
    let id = Uuid::new_v4().to_string();

    let default_shell = if cfg!(windows) {
        "cmd.exe".to_string()
    } else {
        std::env::var("SHELL").unwrap_or_else(|_| "/bin/zsh".to_string())
    };
    let shell = shell.unwrap_or(default_shell);

    let pty_system = native_pty_system();
    let pair = pty_system
        .openpty(PtySize {
            rows: 30,
            cols: 120,
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|e| e.to_string())?;

    let mut cmd = CommandBuilder::new(&shell);
    cmd.env("TERM", "xterm-256color");
    cmd.env("COLORTERM", "truecolor");
    cmd.env("TERM_PROGRAM", "canvas-terminal");
    cmd.env("TERM_PROGRAM_VERSION", env!("CARGO_PKG_VERSION"));

    if !cfg!(windows) {
        if shell.ends_with("zsh") {
            cmd.arg("-l");
            cmd.arg("-i");
        } else if shell.ends_with("bash") {
            cmd.arg("-l");
            cmd.arg("-i");
        }
    }
    if let Some(cwd) = cwd {
        cmd.cwd(PathBuf::from(cwd));
    }

    let child = pair
        .slave
        .spawn_command(cmd)
        .map_err(|e| e.to_string())?;
    drop(pair.slave);

    let mut master = pair.master;
    let mut reader = master
        .try_clone_reader()
        .map_err(|e| e.to_string())?;
    let writer = master.take_writer().map_err(|e| e.to_string())?;

    let session = Arc::new(Session {
        master: Mutex::new(master),
        writer: Mutex::new(writer),
        child: Mutex::new(child),
    });

    println!("created session {}", id);

    state
        .sessions
        .lock()
        .map_err(|_| "session lock poisoned".to_string())?
        .insert(id.clone(), session);

    let app_handle = app.clone();
    let id_clone = id.clone();
    std::thread::spawn(move || {
        let mut buf = [0u8; 8192];
        loop {
            match reader.read(&mut buf) {
                Ok(0) => break,
                Ok(n) => {
                    let data = String::from_utf8_lossy(&buf[..n]).to_string();
                    if n > 0 {
                        println!("session {} output {} bytes", id_clone, n);
                    }
                    if let Err(e) = app_handle.emit(
                        "terminal:data",
                        TerminalData {
                            id: id_clone.clone(),
                            data,
                        },
                    ) {
                        println!("Failed to emit terminal data: {}", e);
                    }
                }
                Err(_) => break,
            }
        }
    });

    Ok(SessionInfo { id })
}

#[tauri::command]
fn write_session(
    state: tauri::State<SessionState>,
    id: String,
    data: String,
) -> Result<(), String> {
    let sessions = state
        .sessions
        .lock()
        .map_err(|_| "session lock poisoned".to_string())?;
    let session = sessions.get(&id).ok_or("session not found")?;
    let mut writer = session
        .writer
        .lock()
        .map_err(|_| "writer lock poisoned".to_string())?;
    writer
        .write_all(data.as_bytes())
        .map_err(|e| e.to_string())?;
    writer.flush().map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
fn resize_session(
    state: tauri::State<SessionState>,
    id: String,
    cols: u16,
    rows: u16,
) -> Result<(), String> {
    let sessions = state
        .sessions
        .lock()
        .map_err(|_| "session lock poisoned".to_string())?;
    let session = sessions.get(&id).ok_or("session not found")?;
    let mut master = session
        .master
        .lock()
        .map_err(|_| "master lock poisoned".to_string())?;
    master
        .resize(PtySize {
            rows,
            cols,
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
fn close_session(state: tauri::State<SessionState>, id: String) -> Result<(), String> {
    let mut sessions = state
        .sessions
        .lock()
        .map_err(|_| "session lock poisoned".to_string())?;
    if let Some(session) = sessions.remove(&id) {
        let _ = session.child.lock().map_err(|_| "child lock poisoned")?.kill();
    }
    Ok(())
}

#[tauri::command]
fn log_frontend(message: String) {
    println!("[FRONTEND] {}", message);
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .manage(SessionState::new())
        .invoke_handler(tauri::generate_handler![
            default_root,
            list_dir,
            create_session,
            write_session,
            resize_session,
            close_session,
            log_frontend
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
