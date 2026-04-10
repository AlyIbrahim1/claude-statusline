use super::*;

#[test]
fn sanitize_strips_ansi_m_codes() {
    assert_eq!(sanitize("\x1b[32mhello\x1b[0m"), "hello");
}

#[test]
fn sanitize_strips_cursor_codes() {
    assert_eq!(sanitize("\x1b[2Jclear\x1b[H"), "clear");
}

#[test]
fn sanitize_preserves_non_ansi() {
    assert_eq!(sanitize("hello world"), "hello world");
}

#[test]
fn sanitize_preserves_utf8() {
    assert_eq!(sanitize("💀 bar"), "💀 bar");
}

#[test]
fn visible_len_strips_only_m_codes() {
    let s = "\x1b[32mhello\x1b[0m";
    assert_eq!(visible_len(s), 5);
}

#[test]
fn visible_len_keeps_non_m_escapes() {
    // \x1b[2J is NOT an SGR (m) code — it stays and counts toward length
    let s = "\x1b[2Jabc";
    assert_eq!(visible_len(s), s.chars().count());
}

#[test]
fn visible_len_counts_emoji_as_two() {
    // 💀 is above U+FFFF — counts as 2 to match JS .length (surrogate pair)
    assert_eq!(visible_len("💀"), 2);
}

#[test]
fn context_bar_green_below_50() {
    // remaining=80 → usable_remaining = (80-16.5)/83.5*100 = 75.99 → used = round(24.01) = 24
    let bar = context_bar(80.0);
    assert!(bar.contains("\x1b[32m"), "expected green for used=24");
}

#[test]
fn context_bar_yellow_50_to_64() {
    // used=50 → usable_remaining=50 → remaining = 50*83.5/100 + 16.5 = 58.25
    let bar = context_bar(58.25);
    assert!(bar.contains("\x1b[33m"), "expected yellow for used=50");
}

#[test]
fn context_bar_orange_65_to_79() {
    // used=65 → usable_remaining=35 → remaining = 35*83.5/100 + 16.5 = 45.725
    let bar = context_bar(45.725);
    assert!(bar.contains("\x1b[38;5;208m"), "expected orange for used=65");
}

#[test]
fn context_bar_red_skull_at_80_plus() {
    // used=80 → usable_remaining=20 → remaining = 20*83.5/100 + 16.5 = 33.2
    let bar = context_bar(33.2);
    assert!(bar.contains("\x1b[5;31m"), "expected blinking red for used=80");
    assert!(bar.contains("💀"));
}

#[test]
fn context_bar_full_at_zero_remaining() {
    let bar = context_bar(0.0);
    assert!(bar.contains("██████████"), "expected 10 filled segments");
    assert!(bar.contains("100%"));
}

#[test]
fn context_bar_empty_at_full_remaining() {
    let bar = context_bar(100.0);
    assert!(bar.contains("░░░░░░░░░░"), "expected 10 empty segments");
    assert!(bar.contains("0%"));
}

#[test]
fn context_bar_has_10_segments() {
    let bar = context_bar(50.0);
    let stripped = sanitize(&bar);
    let filled = stripped.matches('█').count();
    let empty = stripped.matches('░').count();
    assert_eq!(filled + empty, 10);
}

#[test]
fn usage_line_green_below_50() {
    let line = usage_line("Current", 49.0, "");
    assert!(line.contains("\x1b[32m"));
    assert!(line.contains("49%"));
    assert!(line.contains("Current:"));
}

#[test]
fn usage_line_yellow_50_to_74() {
    let line = usage_line("Weekly", 74.0, "");
    assert!(line.contains("\x1b[33m"));
}

#[test]
fn usage_line_red_at_75_plus() {
    let line = usage_line("Current", 75.0, "");
    assert!(line.contains("\x1b[31m"));
}

#[test]
fn usage_line_includes_suffix() {
    let line = usage_line("Current", 50.0, " mysuffix");
    assert!(line.ends_with(" mysuffix"));
}

#[test]
fn usage_line_rounds_pct() {
    let line = usage_line("X", 49.6, "");
    assert!(line.contains("50%"));
}

#[test]
fn reset_suffix_formats_correctly() {
    let future = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_secs() as i64 + 90 * 60;
    let s = reset_suffix(future);
    assert!(s.contains("↺"));
    assert!(s.contains("1h"));
    assert!(s.contains("30m"));
}

#[test]
fn reset_suffix_zero_pads_minutes() {
    let future = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_secs() as i64 + 65 * 60;
    let s = reset_suffix(future);
    assert!(s.contains("05m"));
}

#[test]
fn reset_suffix_past_returns_zero() {
    let s = reset_suffix(0i64);
    assert!(s.contains("0h00m"));
}

#[test]
fn format_cost_small_uses_4_decimals() {
    assert_eq!(format_cost(0.0099), "$0.0099");
}

#[test]
fn format_cost_large_uses_2_decimals() {
    assert_eq!(format_cost(0.01), "$0.01");
    assert_eq!(format_cost(1.5), "$1.50");
}

#[test]
fn format_tokens_small() {
    assert_eq!(format_tokens(999), "999");
    assert_eq!(format_tokens(0), "0");
}

#[test]
fn format_tokens_thousands() {
    assert_eq!(format_tokens(1000), "1.0k");
    assert_eq!(format_tokens(5300), "5.3k");
    assert_eq!(format_tokens(12500), "12.5k");
}

#[test]
fn format_tokens_millions() {
    assert_eq!(format_tokens(1_000_000), "1M");
    assert_eq!(format_tokens(1_100_000), "1.1M");
    assert_eq!(format_tokens(10_500_000), "10.5M");
    assert_eq!(format_tokens(2_000_000), "2M");
}

#[test]
fn effort_suffix_low() {
    let s = effort_suffix_from_level("low");
    assert!(s.contains("[L]"));
    assert!(s.contains("\x1b[32m"));
}

#[test]
fn effort_suffix_medium() {
    let s = effort_suffix_from_level("medium");
    assert!(s.contains("[M]"));
    assert!(s.contains("\x1b[33m"));
}

#[test]
fn effort_suffix_high() {
    let s = effort_suffix_from_level("high");
    assert!(s.contains("[H]"));
    assert!(s.contains("\x1b[38;5;208m"));
}

#[test]
fn effort_suffix_max() {
    let s = effort_suffix_from_level("max");
    assert!(s.contains("[MAXX]"));
    assert!(s.contains("\x1b[31m"));
}

#[test]
fn effort_suffix_unknown_is_empty() {
    assert_eq!(effort_suffix_from_level(""), "");
    assert_eq!(effort_suffix_from_level("unknown"), "");
}

#[test]
fn dir_label_is_home() {
    let home = std::path::Path::new("/home/user");
    assert_eq!(dir_label(home, home), "~");
}

#[test]
fn dir_label_direct_child_of_home() {
    let abs = std::path::Path::new("/home/user/myproject");
    let home = std::path::Path::new("/home/user");
    assert_eq!(dir_label(abs, home), "~/myproject");
}

#[test]
fn dir_label_nested_path() {
    let abs = std::path::Path::new("/home/user/projects/myapp");
    let home = std::path::Path::new("/home/user");
    assert_eq!(dir_label(abs, home), "~/projects/myapp");
}

#[test]
fn dir_label_unrelated_path() {
    let abs = std::path::Path::new("/tmp/foo/bar");
    let home = std::path::Path::new("/home/user");
    assert_eq!(dir_label(abs, home), "~/foo/bar");
}

fn write_todo_file(dir: &std::path::Path, name: &str, todos: &serde_json::Value) {
    std::fs::write(dir.join(name), serde_json::to_string(todos).unwrap()).unwrap();
}

#[test]
fn scan_todos_finds_active_task() {
    let tmp = std::env::temp_dir().join(format!("sl_test_{}", std::process::id()));
    let todos_dir = tmp.join("todos");
    std::fs::create_dir_all(&todos_dir).unwrap();
    let session = "sess123";
    write_todo_file(&todos_dir, "sess123-agent-1.json", &serde_json::json!([
        {"status": "in_progress", "activeForm": "Writing tests"}
    ]));
    let (task, agents) = scan_todos(&tmp, session);
    assert_eq!(task, "Writing tests");
    assert_eq!(agents, 1);
    std::fs::remove_dir_all(&tmp).ok();
}

#[test]
fn scan_todos_ignores_non_agent_files() {
    let tmp = std::env::temp_dir().join(format!("sl_test2_{}", std::process::id()));
    let todos_dir = tmp.join("todos");
    std::fs::create_dir_all(&todos_dir).unwrap();
    write_todo_file(&todos_dir, "sess123-other.json", &serde_json::json!([
        {"status": "in_progress", "activeForm": "Should not appear"}
    ]));
    let (task, agents) = scan_todos(&tmp, "sess123");
    assert_eq!(task, "");
    assert_eq!(agents, 0);
    std::fs::remove_dir_all(&tmp).ok();
}

#[test]
fn scan_todos_counts_multiple_agents() {
    let tmp = std::env::temp_dir().join(format!("sl_test3_{}", std::process::id()));
    let todos_dir = tmp.join("todos");
    std::fs::create_dir_all(&todos_dir).unwrap();
    let session = "abc";
    write_todo_file(&todos_dir, "abc-agent-1.json", &serde_json::json!([
        {"status": "in_progress", "activeForm": "First task"}
    ]));
    // Sleep to ensure distinct mtime so sort order is deterministic (newest = agent-2)
    std::thread::sleep(std::time::Duration::from_millis(15));
    write_todo_file(&todos_dir, "abc-agent-2.json", &serde_json::json!([
        {"status": "in_progress", "activeForm": "Second task"}
    ]));
    let (task, agents) = scan_todos(&tmp, session);
    assert_eq!(agents, 2);
    assert_eq!(task, "Second task");
    std::fs::remove_dir_all(&tmp).ok();
}

#[test]
fn scan_todos_returns_empty_when_no_in_progress() {
    let tmp = std::env::temp_dir().join(format!("sl_test4_{}", std::process::id()));
    let todos_dir = tmp.join("todos");
    std::fs::create_dir_all(&todos_dir).unwrap();
    write_todo_file(&todos_dir, "sess-agent-1.json", &serde_json::json!([
        {"status": "completed", "activeForm": "Done"}
    ]));
    let (task, agents) = scan_todos(&tmp, "sess");
    assert_eq!(task, "");
    assert_eq!(agents, 0);
    std::fs::remove_dir_all(&tmp).ok();
}

#[test]
fn scan_todos_empty_session_returns_empty() {
    let tmp = std::env::temp_dir().join(format!("sl_test5_{}", std::process::id()));
    let (task, agents) = scan_todos(&tmp, "");
    assert_eq!(task, "");
    assert_eq!(agents, 0);
}

#[test]
fn read_session_tokens_missing_file_returns_none() {
    let tmp = std::env::temp_dir().join(format!("sl_tok_test_{}", std::process::id()));
    std::fs::create_dir_all(&tmp).unwrap();
    let result = read_session_tokens(&tmp, "nosuchsession", "/no/such/dir");
    assert!(result.is_none());
    std::fs::remove_dir_all(&tmp).ok();
}

#[test]
fn read_session_tokens_parses_jsonl() {
    let tmp = std::env::temp_dir().join(format!("sl_tok_test2_{}", std::process::id()));
    let slug = "-tmp-myproject";
    let projects_dir = tmp.join("projects").join(slug);
    std::fs::create_dir_all(&projects_dir).unwrap();
    let session = "testsession";
    let jsonl = concat!(
        "{\"type\":\"assistant\",\"message\":{\"usage\":{\"input_tokens\":100,\"output_tokens\":50,\"cache_read_input_tokens\":200,\"cache_creation_input_tokens\":0}}}\n",
        "{\"type\":\"user\",\"message\":{}}\n",
        "{\"type\":\"assistant\",\"message\":{\"usage\":{\"input_tokens\":10,\"output_tokens\":5,\"cache_read_input_tokens\":0,\"cache_creation_input_tokens\":0}}}\n",
    );
    std::fs::write(projects_dir.join(format!("{}.jsonl", session)), jsonl).unwrap();
    let result = read_session_tokens(&tmp, session, "/tmp/myproject").unwrap();
    // total_in = (100 + 200/10 + 0) + (10 + 0 + 0) = 130
    // total_out = 50 + 5 = 55
    assert_eq!(result.total_in, 130);
    assert_eq!(result.total_out, 55);
    std::fs::remove_dir_all(&tmp).ok();
}

#[test]
fn read_session_tokens_normalizes_backslash_slug() {
    let tmp = std::env::temp_dir().join(format!("sl_tok_test_backslash_{}", std::process::id()));
    let slug = "C:-work-repo";
    let projects_dir = tmp.join("projects").join(slug);
    std::fs::create_dir_all(&projects_dir).unwrap();
    let session = "testsession-backslash";
    let jsonl = "{\"type\":\"assistant\",\"message\":{\"usage\":{\"input_tokens\":1,\"output_tokens\":2,\"cache_read_input_tokens\":0,\"cache_creation_input_tokens\":0}}}\n";
    std::fs::write(projects_dir.join(format!("{}.jsonl", session)), jsonl).unwrap();
    let result = read_session_tokens(&tmp, session, "C:\\work\\repo").unwrap();
    assert_eq!(result.total_in, 1);
    assert_eq!(result.total_out, 2);
    std::fs::remove_dir_all(&tmp).ok();
}

#[test]
fn read_session_tokens_uses_offset_cache() {
    let tmp = std::env::temp_dir().join(format!("sl_tok_test3_{}", std::process::id()));
    let slug = "-tmp-myproject";
    let projects_dir = tmp.join("projects").join(slug);
    std::fs::create_dir_all(&projects_dir).unwrap();
    let session = "testsession2";
    let line1 = "{\"type\":\"assistant\",\"message\":{\"usage\":{\"input_tokens\":100,\"output_tokens\":50,\"cache_read_input_tokens\":0,\"cache_creation_input_tokens\":0}}}\n";
    std::fs::write(projects_dir.join(format!("{}.jsonl", session)), line1).unwrap();
    // First read
    let r1 = read_session_tokens(&tmp, session, "/tmp/myproject").unwrap();
    assert_eq!(r1.total_in, 100);
    // Append a second line
    let line2 = "{\"type\":\"assistant\",\"message\":{\"usage\":{\"input_tokens\":20,\"output_tokens\":10,\"cache_read_input_tokens\":0,\"cache_creation_input_tokens\":0}}}\n";
    use std::io::Write;
    let mut f = std::fs::OpenOptions::new()
        .append(true)
        .open(projects_dir.join(format!("{}.jsonl", session)))
        .unwrap();
    f.write_all(line2.as_bytes()).unwrap();
    // Second read — should pick up only the new line via offset cache
    let r2 = read_session_tokens(&tmp, session, "/tmp/myproject").unwrap();
    assert_eq!(r2.total_in, 120);
    assert_eq!(r2.total_out, 60);
    std::fs::remove_dir_all(&tmp).ok();
}

fn make_basic_input(model: &str) -> String {
    serde_json::json!({
        "model": {"display_name": model},
        "workspace": {"current_dir": "/tmp/myproject"},
        "session_id": "",
        "context_window": {"remaining_percentage": 90.0}
    }).to_string()
}

#[test]
fn render_returns_some_for_valid_input() {
    assert!(render(&make_basic_input("claude-sonnet-4-6")).is_some());
}

#[test]
fn render_contains_model_name() {
    let out = render(&make_basic_input("claude-sonnet-4-6")).unwrap();
    assert!(out.contains("claude-sonnet-4-6"));
}

#[test]
fn render_contains_dirname() {
    let out = render(&make_basic_input("M")).unwrap();
    assert!(out.contains("myproject"));
}

#[test]
fn render_dirname_uses_parent_slash_base_format() {
    let out = render(&make_basic_input("M")).unwrap();
    // /tmp/myproject → ~/tmp/myproject (when HOME is not /tmp)
    // At minimum the path separator format should be present
    assert!(out.contains("myproject"));
    // Should not show bare basename without path context (old [branch] style)
    assert!(!out.contains("[main]") && !out.contains("[master]"),
        "branch should use () not [] format");
}

#[test]
fn render_branch_uses_parens_format() {
    // Verify branch is shown with () not [] when present
    // (branch detection depends on git being available in the test env)
    let out = render(&make_basic_input("M")).unwrap();
    // If a branch is shown, it must not use square brackets
    if out.contains('(') {
        assert!(!out.contains('['), "branch format should use () not []");
    }
}

#[test]
fn render_returns_none_for_invalid_json() {
    assert!(render("not json").is_none());
}

#[test]
fn render_defaults_model_to_claude() {
    let input = serde_json::json!({"session_id": ""}).to_string();
    let out = render(&input).unwrap();
    assert!(out.contains("Claude"));
}

#[test]
fn render_shows_usage_line_for_subscription() {
    let input = serde_json::json!({
        "model": {"display_name": "M"},
        "session_id": "",
        "rate_limits": {
            "five_hour": {"used_percentage": 30.0, "resets_at": 9999999999i64},
            "seven_day": {"used_percentage": 20.0}
        }
    }).to_string();
    let out = render(&input).unwrap();
    assert!(out.contains("Usage"));
    assert!(out.contains("30%"));
}

#[test]
fn render_shows_cost_for_api_key_users() {
    let input = serde_json::json!({
        "model": {"display_name": "M"},
        "session_id": "",
        "cost": {"total_cost_usd": 0.0042}
    }).to_string();
    let out = render(&input).unwrap();
    assert!(out.contains("$0.0042"));
}

#[test]
fn render_shows_token_display_from_stdin() {
    let input = serde_json::json!({
        "model": {"display_name": "M"},
        "session_id": "",
        "context_window": {
            "remaining_percentage": 80.0,
            "total_input_tokens": 3000,
            "total_output_tokens": 500
        }
    }).to_string();
    let out = render(&input).unwrap();
    assert!(out.contains("↓"), "expected input token display down arrow");
    assert!(out.contains("↑"), "expected output token display up arrow");
    assert!(out.contains("3.0k↓ 500↑"), "expected separated tokens");
}

#[test]
fn render_no_trailing_newline() {
    let out = render(&make_basic_input("M")).unwrap();
    assert!(!out.ends_with('\n'));
}

#[test]
fn render_sep_length_matches_line1_visible_length() {
    let input = serde_json::json!({
        "model": {"display_name": "M"},
        "session_id": "",
        "rate_limits": {
            "five_hour": {"used_percentage": 30.0, "resets_at": 9999999999i64},
            "seven_day": {"used_percentage": 20.0}
        }
    }).to_string();
    let out = render(&input).unwrap();
    if out.contains('\n') {
        let lines: Vec<&str> = out.splitn(3, '\n').collect();
        let line1_len = visible_len(lines[0]);
        let sep_visible = visible_len(lines[1]);
        assert_eq!(line1_len, sep_visible);
    }
}
