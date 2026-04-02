use super::*;

fn session(project: &str, start: &str, tokens_in: u64, tokens_out: u64, cost: f64) -> Session {
    Session {
        project_name: project.to_string(),
        model: "claude-sonnet-4-6".to_string(),
        start_time: start.to_string(),
        duration_seconds: 120,
        tokens_in,
        tokens_out,
        cost_usd: cost,
        exit_reason: "normal".to_string(),
    }
}

#[test]
fn parses_jsonl_and_sorts_descending() {
    let data = r#"{"project_name":"b","model":"m","start_time":"2026-01-01 10:00:00","duration_seconds":10,"tokens_in":2,"tokens_out":3,"cost_usd":0.1,"exit_reason":"normal"}
not-json
{"project_name":"a","model":"m","start_time":"2026-01-02 09:00:00","duration_seconds":20,"tokens_in":5,"tokens_out":5,"cost_usd":0.2,"exit_reason":"interrupt"}
"#;

    let sessions = parse_sessions_from_str(data);
    assert_eq!(sessions.len(), 2);
    assert_eq!(sessions[0].project_name, "a");
    assert_eq!(sessions[1].project_name, "b");
}

#[test]
fn filters_by_project() {
    let sessions = vec![
        session("alpha", "2026-01-03 10:00:00", 1, 1, 0.1),
        session("beta", "2026-01-02 10:00:00", 1, 1, 0.1),
        session("alpha", "2026-01-01 10:00:00", 1, 1, 0.1),
    ];
    let mut app = App::new(sessions);

    app.selected_project = Some("alpha".to_string());
    app.recompute_filtered();

    assert_eq!(app.filtered.len(), 2);
    assert!(app
        .filtered_sessions()
        .all(|s| s.project_name.as_str() == "alpha"));
}

#[test]
fn summary_uses_filtered_rows() {
    let sessions = vec![
        session("a", "2026-01-03 10:00:00", 100, 50, 0.15),
        session("b", "2026-01-02 10:00:00", 10, 10, 0.05),
        session("a", "2026-01-01 10:00:00", 20, 30, 0.20),
    ];
    let mut app = App::new(sessions);
    app.selected_project = Some("a".to_string());
    app.recompute_filtered();

    let summary = app.summary();
    assert_eq!(summary.count, 2);
    assert_eq!(summary.tokens, 200);
    assert!((summary.cost_usd - 0.35).abs() < 0.0001);
}

#[test]
fn scroll_bounds_are_clamped() {
    let sessions = (0..10)
        .map(|i| {
            session(
                "a",
                &format!("2026-01-{:02} 10:00:00", i + 1),
                1,
                1,
                0.01,
            )
        })
        .collect::<Vec<_>>();

    let mut app = App::new(sessions);
    app.set_visible_rows(3);
    app.selected_row = 9;
    app.table_offset = 99;
    app.clamp_scroll(3);

    let max_offset = app.filtered.len().saturating_sub(3);
    assert!(app.table_offset <= max_offset);
    assert!(app.selected_row >= app.table_offset);
    assert!(app.selected_row < app.table_offset + 3);
}

#[test]
fn filter_cursor_open_move_apply_and_cancel() {
    let sessions = vec![
        session("alpha", "2026-01-02 10:00:00", 1, 1, 0.1),
        session("beta", "2026-01-01 10:00:00", 1, 1, 0.1),
    ];
    let mut app = App::new(sessions);

    app.open_filter();
    assert!(app.filter_open);
    assert_eq!(app.filter_cursor, 0);

    app.move_filter_cursor(10);
    assert_eq!(app.filter_cursor, app.projects.len());

    app.apply_filter_cursor();
    assert!(!app.filter_open);
    assert_eq!(app.selected_project.as_deref(), Some("beta"));
    assert_eq!(app.filtered.len(), 1);

    app.open_filter();
    app.close_filter();
    assert!(!app.filter_open);
}
