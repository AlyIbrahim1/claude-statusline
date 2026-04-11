use super::{realtime, realtime_paths};

#[cfg(unix)]
use std::io::Read;

#[test]
fn realtime_flag_defaults_off() {
    std::env::remove_var("CLAUDE_STATUSLINE_REALTIME");
    assert!(!realtime::realtime_enabled());
}

#[test]
fn realtime_flag_accepts_true_values() {
    std::env::set_var("CLAUDE_STATUSLINE_REALTIME", "1");
    assert!(realtime::realtime_enabled());
    std::env::set_var("CLAUDE_STATUSLINE_REALTIME", "true");
    assert!(realtime::realtime_enabled());
    std::env::remove_var("CLAUDE_STATUSLINE_REALTIME");
}

#[test]
fn tty_slug_uses_override() {
    std::env::set_var("CLAUDE_STATUSLINE_TTY", "pts/12@host");
    let slug = realtime_paths::tty_slug();
    std::env::remove_var("CLAUDE_STATUSLINE_TTY");
    assert_eq!(slug, "pts-12-host");
}

#[test]
fn emit_state_update_writes_snapshot_when_enabled() {
    let tmp = std::env::temp_dir().join(format!("rt_state_test_{}", std::process::id()));
    std::fs::create_dir_all(&tmp).unwrap();

    std::env::set_var("CLAUDE_CONFIG_DIR", &tmp);
    std::env::set_var("CLAUDE_STATUSLINE_REALTIME", "1");
    std::env::set_var("CLAUDE_STATUSLINE_TTY", "pts/99");

    let input = serde_json::json!({
        "model": {"display_name": "M"},
        "session_id": "abc",
        "context_window": {"remaining_percentage": 80.0}
    })
    .to_string();

    realtime::emit_state_update(&input).unwrap();

    let p = realtime_paths::state_path(&tmp, "pts/99");
    let text = std::fs::read_to_string(p).unwrap();
    let v: serde_json::Value = serde_json::from_str(&text).unwrap();
    assert_eq!(v["event_type"], "state_update");
    assert_eq!(v["tty_slug"], "pts-99");

    let registry = realtime_paths::renderer_registry_path(&tmp, "pts/99");
    let reg_text = std::fs::read_to_string(registry).unwrap();
    let reg: serde_json::Value = serde_json::from_str(&reg_text).unwrap();
    assert_eq!(reg["tty_slug"], "pts-99");
    assert!(reg["socket_path"].as_str().unwrap_or("").contains("statusline-rt-pts-99.sock"));

    std::env::remove_var("CLAUDE_CONFIG_DIR");
    std::env::remove_var("CLAUDE_STATUSLINE_REALTIME");
    std::env::remove_var("CLAUDE_STATUSLINE_TTY");
    std::fs::remove_dir_all(&tmp).ok();
}

#[cfg(unix)]
#[test]
fn emit_lifecycle_event_sends_to_unix_socket_when_present() {
    use std::os::unix::net::UnixListener;
    use std::sync::mpsc;

    let tmp = std::env::temp_dir().join(format!("rt_socket_send_test_{}", std::process::id()));
    std::fs::create_dir_all(&tmp).unwrap();

    std::env::set_var("CLAUDE_CONFIG_DIR", &tmp);
    std::env::set_var("CLAUDE_STATUSLINE_REALTIME", "1");
    std::env::set_var("CLAUDE_STATUSLINE_TTY", "pts/55");

    let socket = realtime_paths::socket_path(&tmp, "pts/55");
    let _ = std::fs::remove_file(&socket);
    let listener = UnixListener::bind(&socket).unwrap();

    let (tx, rx) = mpsc::channel();
    std::thread::spawn(move || {
        if let Ok((mut stream, _)) = listener.accept() {
            let mut buf = String::new();
            let _ = stream.read_to_string(&mut buf);
            let _ = tx.send(buf);
        }
    });

    realtime::emit_lifecycle_event("session_start").unwrap();
    let msg = rx.recv_timeout(std::time::Duration::from_secs(2)).unwrap();
    assert!(msg.contains("session_start"));

    std::env::remove_var("CLAUDE_CONFIG_DIR");
    std::env::remove_var("CLAUDE_STATUSLINE_REALTIME");
    std::env::remove_var("CLAUDE_STATUSLINE_TTY");
    let _ = std::fs::remove_file(&socket);
    std::fs::remove_dir_all(&tmp).ok();
}

#[cfg(unix)]
#[test]
fn renderer_loop_exits_on_shutdown_event() {
    use std::os::unix::net::UnixStream;
    use std::thread;

    let tmp = std::env::temp_dir().join(format!("rt_loop_test_{}", std::process::id()));
    std::fs::create_dir_all(&tmp).unwrap();

    std::env::set_var("CLAUDE_CONFIG_DIR", &tmp);
    std::env::set_var("CLAUDE_STATUSLINE_TTY", "pts/66");

    let socket = realtime_paths::socket_path(&tmp, "pts/66");
    let handle = thread::spawn(|| {
        let _ = realtime::run_renderer_loop();
    });

    // Wait briefly for listener bind.
    let start = std::time::Instant::now();
    while !socket.exists() && start.elapsed() < std::time::Duration::from_secs(2) {
        thread::sleep(std::time::Duration::from_millis(10));
    }

    let mut s = UnixStream::connect(&socket).unwrap();
    use std::io::Write;
    s.write_all(b"{\"event_type\":\"shutdown\"}\n").unwrap();
    drop(s);

    let _ = handle.join();

    std::env::remove_var("CLAUDE_CONFIG_DIR");
    std::env::remove_var("CLAUDE_STATUSLINE_TTY");
    std::fs::remove_dir_all(&tmp).ok();
}

#[test]
fn cleanup_stale_runtime_removes_old_registry_and_socket() {
    let tmp = std::env::temp_dir().join(format!("rt_stale_cleanup_{}", std::process::id()));
    std::fs::create_dir_all(&tmp).unwrap();

    let tty = "pts/333";
    let registry = realtime_paths::renderer_registry_path(&tmp, tty);
    let socket = realtime_paths::socket_path(&tmp, tty);

    std::fs::write(
        &registry,
        serde_json::json!({
            "heartbeat_at_ms": 1,
        })
        .to_string(),
    )
    .unwrap();
    std::fs::write(&socket, "sock").unwrap();

    realtime::cleanup_stale_runtime(&tmp, tty, 1 + 6 * 60 * 1000).unwrap();
    assert!(!registry.exists());
    assert!(!socket.exists());

    std::fs::remove_dir_all(&tmp).ok();
}

#[test]
fn cleanup_stale_runtime_keeps_recent_registry_and_socket() {
    let tmp = std::env::temp_dir().join(format!("rt_fresh_cleanup_{}", std::process::id()));
    std::fs::create_dir_all(&tmp).unwrap();

    let tty = "pts/444";
    let registry = realtime_paths::renderer_registry_path(&tmp, tty);
    let socket = realtime_paths::socket_path(&tmp, tty);

    let heartbeat = 50_000i64;
    std::fs::write(
        &registry,
        serde_json::json!({
            "heartbeat_at_ms": heartbeat,
        })
        .to_string(),
    )
    .unwrap();
    std::fs::write(&socket, "sock").unwrap();

    realtime::cleanup_stale_runtime(&tmp, tty, heartbeat + 10_000).unwrap();
    assert!(registry.exists());
    assert!(socket.exists());

    std::fs::remove_dir_all(&tmp).ok();
}

#[test]
fn apply_resize_snapshot_updates_width_height_fields() {
    let tmp = std::env::temp_dir().join(format!("rt_resize_snapshot_{}", std::process::id()));
    std::fs::create_dir_all(&tmp).unwrap();
    let tty = "pts/222";

    let ts = 123_456i64;
    realtime::apply_resize_snapshot(&tmp, tty, 80, 24, ts).unwrap();

    let p = realtime_paths::state_path(&tmp, tty);
    let text = std::fs::read_to_string(p).unwrap();
    let v: serde_json::Value = serde_json::from_str(&text).unwrap();
    assert_eq!(v["event_type"], "resize");
    assert_eq!(v["last_render_width"], 80);
    assert_eq!(v["last_render_height"], 24);
    assert_eq!(v["updated_at_ms"], ts);

    std::fs::remove_dir_all(&tmp).ok();
}

#[test]
fn emit_state_update_isolated_by_tty_slug() {
    let tmp = std::env::temp_dir().join(format!("rt_tty_isolation_{}", std::process::id()));
    std::fs::create_dir_all(&tmp).unwrap();

    std::env::set_var("CLAUDE_CONFIG_DIR", &tmp);
    std::env::set_var("CLAUDE_STATUSLINE_REALTIME", "1");

    std::env::set_var("CLAUDE_STATUSLINE_TTY", "pts/111");
    realtime::emit_state_update("{}").unwrap();
    let p1 = realtime_paths::state_path(&tmp, "pts/111");
    assert!(p1.exists());

    std::env::set_var("CLAUDE_STATUSLINE_TTY", "pts/112");
    realtime::emit_state_update("{}").unwrap();
    let p2 = realtime_paths::state_path(&tmp, "pts/112");
    assert!(p2.exists());
    assert_ne!(p1, p2);

    std::env::remove_var("CLAUDE_CONFIG_DIR");
    std::env::remove_var("CLAUDE_STATUSLINE_REALTIME");
    std::env::remove_var("CLAUDE_STATUSLINE_TTY");
    std::fs::remove_dir_all(&tmp).ok();
}

#[test]
fn emit_state_update_recovers_from_stale_registry() {
    let tmp = std::env::temp_dir().join(format!("rt_recovery_{}", std::process::id()));
    std::fs::create_dir_all(&tmp).unwrap();

    std::env::set_var("CLAUDE_CONFIG_DIR", &tmp);
    std::env::set_var("CLAUDE_STATUSLINE_REALTIME", "1");
    std::env::set_var("CLAUDE_STATUSLINE_TTY", "pts/900");

    let registry = realtime_paths::renderer_registry_path(&tmp, "pts/900");
    std::fs::write(
        &registry,
        serde_json::json!({
            "heartbeat_at_ms": 1,
        })
        .to_string(),
    )
    .unwrap();

    realtime::emit_state_update("{}").unwrap();

    let text = std::fs::read_to_string(&registry).unwrap();
    let v: serde_json::Value = serde_json::from_str(&text).unwrap();
    assert!(v["heartbeat_at_ms"].as_i64().unwrap_or(0) > 1);

    std::env::remove_var("CLAUDE_CONFIG_DIR");
    std::env::remove_var("CLAUDE_STATUSLINE_REALTIME");
    std::env::remove_var("CLAUDE_STATUSLINE_TTY");
    std::fs::remove_dir_all(&tmp).ok();
}
