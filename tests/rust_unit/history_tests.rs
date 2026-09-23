use super::*;

fn tmp_dir(name: &str) -> PathBuf {
    let d = std::env::temp_dir().join(format!("sl_hist_{}_{}", name, std::process::id()));
    let _ = fs::remove_dir_all(&d);
    fs::create_dir_all(&d).unwrap();
    d
}

fn state(tin: u64, tout: u64) -> State {
    State { tin, tout, start: 1_700_000_000, dur: 90, model: "Opus 5.5".into(), project: "proj".into(), cost: 1.23456, ..State::default() }
}

#[test]
fn test_unix_secs_to_str_known_date() {
    // 2000-01-01 00:00:00 UTC = 946684800
    assert_eq!(unix_secs_to_str(946684800), "2000-01-01 00:00:00");
}

#[test]
fn test_parse_datetime_roundtrip() {
    let secs: u64 = 1705317045;
    assert_eq!(parse_datetime_to_unix_secs(&unix_secs_to_str(secs)), Some(secs));
    assert_eq!(parse_datetime_to_unix_secs("not-a-date"), None);
}

#[test]
fn line_round_trips_and_is_compact() {
    let line = record_line("3f9a2c1b-aaaa-bbbb", &state(100, 50), "clear", 0);
    assert_eq!(line, "h([\"3f9a2c1b\",\"proj\",\"Opus 5.5\",1700000000,90,100,0,50,1.2346,\"clear\"]);\n");
    let rec = parse_line(&line).unwrap();
    assert_eq!((rec.id.as_str(), rec.tokens_in, rec.tokens_out, rec.duration_seconds), ("3f9a2c1b", 100, 50, 90));
    assert_eq!(rec.start_time, "2023-11-14 22:13:20");
}

#[test]
fn line_escapes_hostile_names() {
    let mut st = state(1, 1);
    st.project = "\");alert(1);//</script>".into();
    let rec = parse_line(&record_line("x", &st, "other", 0)).unwrap();
    assert_eq!(rec.project_name, st.project);
}

#[test]
fn sessions_without_tokens_are_not_recorded() {
    assert_eq!(record_line("x", &State::default(), "clear", 5), "");
}

#[test]
fn read_history_keeps_last_line_per_id_and_sorts_newest_first() {
    let d = tmp_dir("read");
    let p = d.join("history.js");
    let mut old = state(1, 1);
    old.start = 100;
    let mut resumed = state(5, 5);
    resumed.start = 100;
    let mut other = state(2, 2);
    other.start = 200;
    let text = [
        record_line("aaaaaaaa", &old, "resume", 0),
        "garbage line\n".to_string(),
        record_line("bbbbbbbb", &other, "clear", 0),
        record_line("aaaaaaaa", &resumed, "prompt_input_exit", 0),
    ].concat();
    fs::write(&p, text).unwrap();
    let recs = read_history(&p);
    assert_eq!(recs.len(), 2);
    assert_eq!(recs[0].id, "bbbbbbbb");
    assert_eq!((recs[1].tokens_in, recs[1].exit_reason.as_str()), (5, "prompt_input_exit"));
    assert!(read_history(&d.join("missing.js")).is_empty());
    fs::remove_dir_all(&d).ok();
}

#[test]
fn finalize_appends_record_catches_up_transcript_and_deletes_state() {
    let d = tmp_dir("finalize");
    let sid = "sess-fin";
    let sp = session::state_path(&d, sid).unwrap();
    session::save(&sp, &state(10, 5));
    let transcript = d.join("t.jsonl");
    fs::write(&transcript, "{\"type\":\"assistant\",\"message\":{\"id\":\"m\",\"usage\":{\"input_tokens\":3,\"output_tokens\":2}}}\n").unwrap();

    finalize(&d, sid, &transcript.to_string_lossy(), "clear", 1_700_000_500);
    let recs = read_history(&history_path(&d));
    assert_eq!(recs.len(), 1);
    assert_eq!((recs[0].tokens_in, recs[0].tokens_out, recs[0].exit_reason.as_str()), (13, 7, "clear"));
    assert!(!sp.exists());
    fs::remove_dir_all(&d).ok();
}

#[test]
fn finalize_ignores_unsafe_session_ids() {
    let d = tmp_dir("unsafe");
    finalize(&d, "../x", "", "clear", 1);
    assert!(!history_path(&d).exists());
    fs::remove_dir_all(&d).ok();
}

#[test]
fn sweep_only_finalizes_old_state_files() {
    let d = tmp_dir("sweep");
    let fresh = session::state_path(&d, "fresh").unwrap();
    let stale = session::state_path(&d, "stale").unwrap();
    session::save(&fresh, &state(1, 1));
    session::save(&stale, &state(2, 2));
    let old = std::time::SystemTime::now() - std::time::Duration::from_secs(STALE_SECS + 60);
    fs::File::options().write(true).open(&stale).unwrap().set_modified(old).unwrap();

    sweep_stale(&d, session::now_secs());
    assert!(fresh.exists());
    assert!(!stale.exists());
    let recs = read_history(&history_path(&d));
    assert_eq!((recs.len(), recs[0].id.as_str(), recs[0].exit_reason.as_str()), (1, "stale", "other"));
    fs::remove_dir_all(&d).ok();
}

#[test]
fn migrate_legacy_converts_history_and_deletes_loose_files() {
    let d = tmp_dir("migrate");
    let home = d.join("home-claude");
    fs::create_dir_all(&home).unwrap();
    fs::write(home.join("statusline-history.jsonl"), concat!(
        "{\"session_id\":\"11111111-x\",\"project_name\":\"p\",\"model\":\"m\",\"start_time\":\"2026-01-01 00:00:00\",\"duration_seconds\":5,\"tokens_in\":9,\"tokens_out\":4,\"cost_usd\":0,\"exit_reason\":\"clear\"}\n",
        "{\"session_id\":\"pending-p-1\",\"project_name\":\"p\",\"exit_reason\":\"pending\"}\n",
        "not json\n",
    )).unwrap();
    for f in ["statusline-tokcache-a.json", "statusline-session-a.json", "statusline-state-t.json", "settings.json"] {
        fs::write(d.join(f), "{}").unwrap();
    }
    let existing = record_line("22222222", &state(1, 1), "other", 0);
    fs::create_dir_all(d.join("statusline")).unwrap();
    fs::write(history_path(&d), &existing).unwrap();

    migrate_legacy(&d, &home);
    let recs = read_history(&history_path(&d));
    assert_eq!(recs.len(), 2);
    let migrated = recs.iter().find(|r| r.id.is_empty()).unwrap();
    assert_eq!((migrated.tokens_in, migrated.start_time.as_str()), (9, "2026-01-01 00:00:00"));
    assert!(!home.join("statusline-history.jsonl").exists());
    assert!(!d.join("statusline-tokcache-a.json").exists());
    assert!(!d.join("statusline-session-a.json").exists());
    assert!(!d.join("statusline-state-t.json").exists());
    assert!(d.join("settings.json").exists());
    fs::remove_dir_all(&d).ok();
}
