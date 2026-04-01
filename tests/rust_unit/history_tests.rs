use super::*;

#[test]
fn test_unix_secs_to_str_known_date() {
    // 2000-01-01 00:00:00 UTC = 946684800
    assert_eq!(unix_secs_to_str(946684800), "2000-01-01 00:00:00");
}

#[test]
fn test_unix_secs_to_str_epoch() {
    assert_eq!(unix_secs_to_str(0), "1970-01-01 00:00:00");
}

#[test]
fn test_parse_datetime_roundtrip() {
    let secs: u64 = 1705317045;
    let s = unix_secs_to_str(secs);
    assert_eq!(parse_datetime_to_unix_secs(&s), Some(secs));
}

#[test]
fn test_parse_datetime_invalid() {
    assert_eq!(parse_datetime_to_unix_secs("not-a-date"), None);
}

#[test]
fn test_read_sessions_missing_file() {
    let path = PathBuf::from("/tmp/nonexistent-history-test.jsonl");
    assert!(read_sessions(&path).is_empty());
}

#[test]
fn test_append_and_read_sessions() {
    let dir = std::env::temp_dir();
    let path = dir.join(format!("hist-test-{}.jsonl", std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_millis()));
    let s = json!({"session_id": "test-1", "project_name": "myproject", "exit_reason": "normal"});
    append_session(&path, &s);
    let sessions = read_sessions(&path);
    assert_eq!(sessions.len(), 1);
    assert_eq!(sessions[0]["session_id"], "test-1");
    let _ = std::fs::remove_file(&path);
}

#[test]
fn test_write_sessions_atomic() {
    let dir = std::env::temp_dir();
    let path = dir.join(format!("hist-write-test-{}.jsonl", std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_millis()));
    let sessions = vec![
        json!({"session_id": "s1", "exit_reason": "normal"}),
        json!({"session_id": "s2", "exit_reason": "pending"}),
    ];
    write_sessions(&path, &sessions);
    let read_back = read_sessions(&path);
    assert_eq!(read_back.len(), 2);
    assert_eq!(read_back[0]["session_id"], "s1");
    assert_eq!(read_back[1]["session_id"], "s2");
    let _ = std::fs::remove_file(&path);
}
