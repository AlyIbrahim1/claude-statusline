use super::*;

fn tmp_dir(name: &str) -> PathBuf {
    let d = std::env::temp_dir().join(format!("sl_session_{}_{}", name, std::process::id()));
    let _ = fs::remove_dir_all(&d);
    fs::create_dir_all(&d).unwrap();
    d
}

fn assistant(id: &str, req: &str, inp: u64, out: u64, read: u64, write: u64) -> String {
    format!(
        "{{\"type\":\"assistant\",\"requestId\":\"{req}\",\"message\":{{\"id\":\"{id}\",\"usage\":{{\"input_tokens\":{inp},\"output_tokens\":{out},\"cache_read_input_tokens\":{read},\"cache_creation_input_tokens\":{write}}}}}}}\n"
    )
}

fn git(dir: &Path, args: &[&str]) {
    let ok = std::process::Command::new("git")
        .args(["-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false"])
        .args(args)
        .current_dir(dir)
        .output()
        .unwrap()
        .status
        .success();
    assert!(ok, "git {:?} failed", args);
}

#[test]
fn state_path_rejects_unsafe_ids() {
    let base = Path::new("/c");
    assert!(state_path(base, "").is_none());
    assert!(state_path(base, "../etc").is_none());
    assert!(state_path(base, "a/b").is_none());
    assert_eq!(
        state_path(base, "abc-123_x").unwrap(),
        Path::new("/c/statusline/sessions/abc-123_x.json")
    );
}

#[test]
fn save_and_load_round_trip() {
    let d = tmp_dir("roundtrip");
    let p = d.join("statusline").join("sessions").join("s.json");
    let mut st = State::default();
    st.tin = 5;
    st.files.insert("x".into(), FileCursor { off: 9, key: "k".into() });
    save(&p, &st);
    assert_eq!(load(&p), st);
    assert!(!p.with_extension("tmp").exists());
    fs::remove_dir_all(&d).ok();
}

#[test]
fn load_returns_default_on_garbage() {
    let d = tmp_dir("garbage");
    let p = d.join("s.json");
    fs::write(&p, "{not json").unwrap();
    assert_eq!(load(&p), State::default());
    fs::remove_dir_all(&d).ok();
}

#[test]
fn update_tokens_dedupes_adjacent_repeats_and_splits_cache() {
    let d = tmp_dir("dedupe");
    let t = d.join("s.jsonl");
    let text = [
        assistant("m1", "r1", 100, 50, 2000, 10),
        assistant("m1", "r1", 100, 50, 2000, 10), // same message, next content block
        "{\"type\":\"user\",\"message\":{\"content\":\"usage\"}}\n".to_string(),
        assistant("m2", "r2", 1, 2, 3, 4),
    ]
    .concat();
    fs::write(&t, text).unwrap();
    let mut st = State::default();
    update_tokens(&mut st, &t);
    assert_eq!((st.tin, st.tcache, st.tout), (100 + 10 + 1 + 4, 2003, 52));
    fs::remove_dir_all(&d).ok();
}

#[test]
fn update_tokens_is_incremental_and_skips_partial_lines() {
    let d = tmp_dir("incremental");
    let t = d.join("s.jsonl");
    let partial = assistant("m2", "r2", 7, 7, 0, 0);
    fs::write(&t, format!("{}{}", assistant("m1", "r1", 10, 5, 0, 0), partial.trim_end())).unwrap();
    let mut st = State::default();
    update_tokens(&mut st, &t);
    assert_eq!((st.tin, st.tout), (10, 5));

    // Writer finishes the line and adds a repeat of it: counted once, no re-read of m1.
    let mut f = fs::OpenOptions::new().append(true).open(&t).unwrap();
    use std::io::Write;
    write!(f, "\n{}", partial).unwrap();
    update_tokens(&mut st, &t);
    assert_eq!((st.tin, st.tout), (17, 12));
    assert_eq!(st.files[&t.to_string_lossy().to_string()].off, fs::metadata(&t).unwrap().len());
    fs::remove_dir_all(&d).ok();
}

#[test]
fn update_tokens_ignores_malformed_lines() {
    let d = tmp_dir("malformed");
    let t = d.join("s.jsonl");
    fs::write(&t, format!("{{\"usage\" \"assistant\" bad\n{}", assistant("m1", "r1", 3, 4, 0, 0))).unwrap();
    let mut st = State::default();
    update_tokens(&mut st, &t);
    assert_eq!((st.tin, st.tout), (3, 4));
    fs::remove_dir_all(&d).ok();
}

#[test]
fn update_tokens_includes_subagent_transcripts() {
    let d = tmp_dir("subagents");
    let t = d.join("sess.jsonl");
    fs::write(&t, assistant("m1", "r1", 10, 1, 0, 0)).unwrap();
    let subs = d.join("sess").join("subagents");
    fs::create_dir_all(&subs).unwrap();
    fs::write(subs.join("agent-a.jsonl"), assistant("m9", "r9", 5, 2, 0, 0)).unwrap();
    fs::write(subs.join("notes.txt"), assistant("m8", "r8", 999, 999, 0, 0)).unwrap();
    let mut st = State::default();
    update_tokens(&mut st, &t);
    assert_eq!((st.tin, st.tout), (15, 3));
    assert_eq!(st.files.len(), 2);
    fs::remove_dir_all(&d).ok();
}

#[test]
fn update_tokens_missing_transcript_records_nothing() {
    let d = tmp_dir("missing");
    let mut st = State::default();
    update_tokens(&mut st, &d.join("nope.jsonl"));
    assert!(st.files.is_empty());
    fs::remove_dir_all(&d).ok();
}

#[test]
fn git_info_empty_outside_repo() {
    let d = tmp_dir("norepo");
    let mut st = State::default();
    assert_eq!(git_info(&d, &mut st), (String::new(), 0));
    fs::remove_dir_all(&d).ok();
}

#[test]
fn git_info_reads_branch_and_counts_session_commits() {
    let d = tmp_dir("repo");
    git(&d, &["init", "-q", "-b", "trunk"]);
    git(&d, &["commit", "-q", "--allow-empty", "-m", "one"]);
    let sub = d.join("src");
    fs::create_dir_all(&sub).unwrap();

    let mut st = State::default();
    assert_eq!(git_info(&sub, &mut st), ("trunk".to_string(), 0));

    git(&d, &["commit", "-q", "--allow-empty", "-m", "two"]);
    git(&d, &["commit", "-q", "--allow-empty", "-m", "three"]);
    assert_eq!(git_info(&sub, &mut st), ("trunk".to_string(), 2));

    // Packed refs are resolved without spawning git.
    git(&d, &["pack-refs", "--all"]);
    assert_eq!(git_info(&d, &mut st), ("trunk".to_string(), 2));

    // Detached HEAD shows the short sha.
    git(&d, &["checkout", "-q", "--detach"]);
    let (label, _) = git_info(&d, &mut st);
    assert_eq!(label.len(), 7);
    fs::remove_dir_all(&d).ok();
}

#[test]
fn git_info_follows_linked_worktree_gitfile() {
    let d = tmp_dir("worktree");
    let main = d.join("main");
    fs::create_dir_all(&main).unwrap();
    git(&main, &["init", "-q", "-b", "trunk"]);
    git(&main, &["commit", "-q", "--allow-empty", "-m", "one"]);
    git(&main, &["worktree", "add", "-q", "-b", "feat", "../wt"]);
    let mut st = State::default();
    assert_eq!(git_info(&d.join("wt"), &mut st).0, "feat");
    fs::remove_dir_all(&d).ok();
}

#[test]
fn git_info_unborn_branch_has_label_but_no_count() {
    let d = tmp_dir("unborn");
    git(&d, &["init", "-q", "-b", "fresh"]);
    let mut st = State::default();
    assert_eq!(git_info(&d, &mut st), ("fresh".to_string(), 0));
    assert!(st.git.is_empty());
    fs::remove_dir_all(&d).ok();
}

#[test]
fn prune_abandoned_deletes_only_week_old_state_files() {
    let d = tmp_dir("prune");
    let (fresh, old) = (d.join("fresh.json"), d.join("old.json"));
    fs::write(&fresh, "{}").unwrap();
    fs::write(&old, "{}").unwrap();
    let week_ago = std::time::SystemTime::now() - std::time::Duration::from_secs(8 * 24 * 3600);
    fs::File::options().write(true).open(&old).unwrap().set_modified(week_ago).unwrap();
    prune_abandoned(&d);
    assert!(fresh.exists());
    assert!(!old.exists());
    fs::remove_dir_all(&d).ok();
}
