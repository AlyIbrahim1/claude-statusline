use serde_json::json;
use std::io::{Read, Write};
use std::io::ErrorKind;
use std::path::Path;
#[cfg(all(unix, not(test)))]
use std::process::Stdio;
use std::time::{SystemTime, UNIX_EPOCH};

use crate::realtime_paths;

pub fn realtime_enabled() -> bool {
    matches!(
        std::env::var("CLAUDE_STATUSLINE_REALTIME").as_deref(),
        Ok("1") | Ok("true") | Ok("TRUE")
    )
}

fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as i64
}

fn write_registry(claude_dir: &Path, tty: &str, timestamp: i64) -> std::io::Result<()> {
    let registry_file = realtime_paths::renderer_registry_path(claude_dir, tty);
    let socket = realtime_paths::socket_path(claude_dir, tty);
    let registry = json!({
        "version": 1,
        "pid": std::process::id(),
        "tty_slug": tty,
        "heartbeat_at_ms": timestamp,
        "socket_path": socket.to_string_lossy(),
    });
    realtime_paths::atomic_write(&registry_file, &serde_json::to_string(&registry).unwrap_or_default())
}

fn read_registry_heartbeat_ms(claude_dir: &Path, tty: &str) -> Option<i64> {
    let registry_file = realtime_paths::renderer_registry_path(claude_dir, tty);
    let text = std::fs::read_to_string(registry_file).ok()?;
    let v: serde_json::Value = serde_json::from_str(&text).ok()?;
    v["heartbeat_at_ms"].as_i64()
}

pub(crate) fn cleanup_stale_runtime(claude_dir: &Path, tty: &str, now: i64) -> std::io::Result<()> {
    const STALE_MS: i64 = 5 * 60 * 1000;

    let Some(heartbeat) = read_registry_heartbeat_ms(claude_dir, tty) else {
        return Ok(());
    };
    if now - heartbeat <= STALE_MS {
        return Ok(());
    }

    let registry_file = realtime_paths::renderer_registry_path(claude_dir, tty);
    let socket_file = realtime_paths::socket_path(claude_dir, tty);
    let _ = std::fs::remove_file(registry_file);
    let _ = std::fs::remove_file(socket_file);
    Ok(())
}

fn persist_event(claude_dir: &Path, tty: &str, event: &serde_json::Value, timestamp: i64) -> std::io::Result<()> {
    write_registry(claude_dir, tty, timestamp)?;
    let state_file = realtime_paths::state_path(claude_dir, tty);
    realtime_paths::atomic_write(&state_file, &serde_json::to_string(event).unwrap_or_default())
}

pub(crate) fn apply_resize_snapshot(
    claude_dir: &Path,
    tty: &str,
    width: u16,
    height: u16,
    timestamp: i64,
) -> std::io::Result<()> {
    let state_file = realtime_paths::state_path(claude_dir, tty);
    let mut state = std::fs::read_to_string(&state_file)
        .ok()
        .and_then(|t| serde_json::from_str::<serde_json::Value>(&t).ok())
        .unwrap_or_else(|| json!({}));

    state["version"] = json!(1);
    state["event_type"] = json!("resize");
    state["tty_slug"] = json!(tty);
    state["updated_at_ms"] = json!(timestamp);
    state["last_render_width"] = json!(width);
    state["last_render_height"] = json!(height);

    persist_event(claude_dir, tty, &state, timestamp)
}

#[cfg(unix)]
fn send_event_to_socket(socket_path: &Path, event: &serde_json::Value) -> std::io::Result<bool> {
    use std::os::unix::net::UnixStream;

    if !socket_path.exists() {
        return Ok(false);
    }
    let mut stream = match UnixStream::connect(socket_path) {
        Ok(s) => s,
        Err(_) => return Ok(false),
    };
    let msg = format!("{}\n", serde_json::to_string(event).unwrap_or_default());
    stream.write_all(msg.as_bytes())?;
    Ok(true)
}

#[cfg(not(unix))]
fn send_event_to_socket(_socket_path: &Path, _event: &serde_json::Value) -> std::io::Result<bool> {
    Ok(false)
}

fn publish_event(event: &serde_json::Value) -> std::io::Result<()> {
    let claude_dir = realtime_paths::claude_dir();
    let tty = realtime_paths::tty_slug();
    let socket = realtime_paths::socket_path(&claude_dir, &tty);
    let ts = now_ms();

    let _ = cleanup_stale_runtime(&claude_dir, &tty, ts);
    if event["event_type"] != "shutdown" {
        let _ = maybe_spawn_renderer(&claude_dir, &tty, ts);
    }

    let _ = send_event_to_socket(&socket, event);
    persist_event(&claude_dir, &tty, event, ts)
}

fn maybe_spawn_renderer(claude_dir: &Path, tty: &str, now: i64) -> std::io::Result<()> {
    // During `cargo test`, current_exe() resolves to the test binary.
    // Spawning it with ["realtime", "run"] causes the test binary to re-run
    // all tests, which spawn more copies — an exponential process explosion
    // that crashes the system.  The cfg guards below exclude all spawn logic
    // from the test build entirely.
    #[cfg(all(unix, not(test)))]
    {
        let socket = realtime_paths::socket_path(claude_dir, tty);
        if socket.exists() {
            return Ok(());
        }

        if let Some(heartbeat) = read_registry_heartbeat_ms(claude_dir, tty) {
            if now - heartbeat < 3_000 {
                return Ok(());
            }
        }

        let exe = std::env::current_exe()?;
        let mut cmd = std::process::Command::new(exe);
        cmd.args(["realtime", "run"])
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null());
        let _ = cmd.spawn();
    }

    let _ = (claude_dir, tty, now);
    Ok(())
}

pub fn emit_state_update(raw_stdin_json: &str) -> std::io::Result<()> {
    if !realtime_enabled() {
        return Ok(());
    }

    let parsed = serde_json::from_str::<serde_json::Value>(raw_stdin_json).unwrap_or_else(|_| json!({}));
    let snapshot = json!({
        "version": 1,
        "event_type": "state_update",
        "tty_slug": realtime_paths::tty_slug(),
        "updated_at_ms": now_ms(),
        "payload": parsed,
    });
    publish_event(&snapshot)
}

pub fn emit_lifecycle_event(kind: &str) -> std::io::Result<()> {
    if !realtime_enabled() {
        return Ok(());
    }

    let evt = json!({
        "version": 1,
        "event_type": kind,
        "tty_slug": realtime_paths::tty_slug(),
        "updated_at_ms": now_ms(),
    });

    publish_event(&evt)
}

#[cfg(unix)]
pub fn run_renderer_loop() -> std::io::Result<()> {
    use std::os::unix::net::UnixListener;
    use std::time::Duration;

    use crossterm::event::{poll, read, Event};

    let claude_dir = realtime_paths::claude_dir();
    let tty = realtime_paths::tty_slug();
    let socket = realtime_paths::socket_path(&claude_dir, &tty);

    if socket.exists() {
        let _ = std::fs::remove_file(&socket);
    }

    let _ = cleanup_stale_runtime(&claude_dir, &tty, now_ms());

    let listener = UnixListener::bind(&socket)?;
    listener.set_nonblocking(true)?;
    let _ = write_registry(&claude_dir, &tty, now_ms());

    loop {
        match listener.accept() {
            Ok((mut stream, _)) => {
                let mut buf = String::new();
                if stream.read_to_string(&mut buf).is_err() {
                    continue;
                }

                for line in buf.lines() {
                    let Ok(v) = serde_json::from_str::<serde_json::Value>(line) else {
                        continue;
                    };
                    let ts = now_ms();
                    let _ = persist_event(&claude_dir, &tty, &v, ts);
                    if v["event_type"] == "shutdown" {
                        let _ = std::fs::remove_file(&socket);
                        return Ok(());
                    }
                }
            }
            Err(err) if err.kind() == ErrorKind::WouldBlock => {}
            Err(_) => {}
        }

        if poll(Duration::from_millis(120)).unwrap_or(false) {
            if let Ok(Event::Resize(w, h)) = read() {
                let ts = now_ms();
                let _ = apply_resize_snapshot(&claude_dir, &tty, w, h, ts);
            }
        };
    }
}

#[cfg(not(unix))]
pub fn run_renderer_loop() -> std::io::Result<()> {
    Ok(())
}
