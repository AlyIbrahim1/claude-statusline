use std::collections::BTreeSet;
use std::env;
use std::fs;
use std::io;
use std::path::PathBuf;
use std::time::Duration;

use crossterm::event::{self, Event, KeyCode, KeyEventKind};
use crossterm::execute;
use crossterm::terminal::{
    EnterAlternateScreen, LeaveAlternateScreen, disable_raw_mode, enable_raw_mode,
};
use ratatui::prelude::*;
use ratatui::widgets::{
    Block, Borders, Cell, Clear, Paragraph, Row, Table, TableState, Wrap,
};
use serde::Deserialize;

#[derive(Debug, Clone, Deserialize, PartialEq)]
struct Session {
    #[serde(default)]
    project_name: String,
    #[serde(default)]
    model: String,
    #[serde(default)]
    start_time: String,
    #[serde(default)]
    duration_seconds: i64,
    #[serde(default)]
    tokens_in: u64,
    #[serde(default)]
    tokens_out: u64,
    #[serde(default)]
    cost_usd: f64,
    #[serde(default)]
    exit_reason: String,
}

#[derive(Debug, Clone, Copy, Default, PartialEq)]
struct Summary {
    count: usize,
    tokens: u64,
    cost_usd: f64,
}

#[derive(Debug)]
struct App {
    sessions: Vec<Session>,
    filtered: Vec<usize>,
    projects: Vec<String>,
    selected_project: Option<String>,
    selected_row: usize,
    table_offset: usize,
    filter_open: bool,
    filter_cursor: usize,
    visible_rows: usize,
}

impl App {
    fn new(mut sessions: Vec<Session>) -> Self {
        sessions.sort_by(|a, b| b.start_time.cmp(&a.start_time));

        let projects = sessions
            .iter()
            .map(|s| s.project_name.clone())
            .filter(|p| !p.trim().is_empty())
            .collect::<BTreeSet<_>>()
            .into_iter()
            .collect::<Vec<_>>();

        let mut app = Self {
            sessions,
            filtered: Vec::new(),
            projects,
            selected_project: None,
            selected_row: 0,
            table_offset: 0,
            filter_open: false,
            filter_cursor: 0,
            visible_rows: 1,
        };
        app.recompute_filtered();
        app
    }

    fn recompute_filtered(&mut self) {
        self.filtered = self
            .sessions
            .iter()
            .enumerate()
            .filter(|(_, s)| {
                self.selected_project
                    .as_ref()
                    .map(|project| &s.project_name == project)
                    .unwrap_or(true)
            })
            .map(|(idx, _)| idx)
            .collect();

        if self.filtered.is_empty() {
            self.selected_row = 0;
            self.table_offset = 0;
            return;
        }

        if self.selected_row >= self.filtered.len() {
            self.selected_row = self.filtered.len() - 1;
        }
        self.clamp_scroll(self.visible_rows);
    }

    fn filtered_sessions<'a>(&'a self) -> impl Iterator<Item = &'a Session> {
        self.filtered.iter().map(|&idx| &self.sessions[idx])
    }

    fn summary(&self) -> Summary {
        self.filtered_sessions().fold(Summary::default(), |mut acc, s| {
            acc.count += 1;
            acc.tokens = acc.tokens.saturating_add(s.tokens_in.saturating_add(s.tokens_out));
            acc.cost_usd += s.cost_usd;
            acc
        })
    }

    fn set_visible_rows(&mut self, visible_rows: usize) {
        self.visible_rows = visible_rows.max(1);
        self.clamp_scroll(self.visible_rows);
    }

    fn clamp_scroll(&mut self, visible_rows: usize) {
        let max_offset = self.filtered.len().saturating_sub(visible_rows);
        if self.table_offset > max_offset {
            self.table_offset = max_offset;
        }
        if self.selected_row < self.table_offset {
            self.table_offset = self.selected_row;
        }
        if self.selected_row >= self.table_offset.saturating_add(visible_rows) {
            self.table_offset = self.selected_row.saturating_sub(visible_rows.saturating_sub(1));
        }
    }

    fn move_selection(&mut self, delta: isize) {
        if self.filtered.is_empty() {
            self.selected_row = 0;
            self.table_offset = 0;
            return;
        }

        let max = self.filtered.len() - 1;
        self.selected_row = if delta < 0 {
            self.selected_row.saturating_sub(delta.unsigned_abs())
        } else {
            self.selected_row.saturating_add(delta as usize).min(max)
        };
        self.clamp_scroll(self.visible_rows);
    }

    fn open_filter(&mut self) {
        self.filter_open = true;
        self.filter_cursor = self
            .selected_project
            .as_ref()
            .and_then(|sel| self.projects.iter().position(|p| p == sel))
            .map(|idx| idx + 1)
            .unwrap_or(0);
    }

    fn close_filter(&mut self) {
        self.filter_open = false;
    }

    fn move_filter_cursor(&mut self, delta: isize) {
        let max = self.projects.len();
        self.filter_cursor = if delta < 0 {
            self.filter_cursor.saturating_sub(delta.unsigned_abs())
        } else {
            self.filter_cursor.saturating_add(delta as usize).min(max)
        };
    }

    fn apply_filter_cursor(&mut self) {
        self.selected_project = if self.filter_cursor == 0 {
            None
        } else {
            self.projects.get(self.filter_cursor - 1).cloned()
        };
        self.selected_row = 0;
        self.table_offset = 0;
        self.recompute_filtered();
        self.filter_open = false;
    }
}

fn history_path() -> PathBuf {
    let home = env::var("HOME")
        .or_else(|_| env::var("USERPROFILE"))
        .unwrap_or_else(|_| ".".to_string());
    PathBuf::from(home)
        .join(".claude")
        .join("statusline-history.jsonl")
}

fn parse_sessions_from_str(content: &str) -> Vec<Session> {
    let mut sessions: Vec<Session> = content
        .lines()
        .filter(|line| !line.trim().is_empty())
        .filter_map(|line| serde_json::from_str::<Session>(line).ok())
        .collect();
    sessions.sort_by(|a, b| b.start_time.cmp(&a.start_time));
    sessions
}

fn read_sessions(path: &PathBuf) -> Vec<Session> {
    match fs::read_to_string(path) {
        Ok(content) => parse_sessions_from_str(&content),
        Err(_) => Vec::new(),
    }
}

fn compact_tokens(tokens: u64) -> String {
    if tokens >= 1_000_000 {
        let m = tokens as f64 / 1_000_000.0;
        if tokens % 1_000_000 == 0 {
            format!("{}M", tokens / 1_000_000)
        } else {
            format!("{m:.1}M")
        }
    } else if tokens >= 1000 {
        format!("{:.1}k", tokens as f64 / 1000.0)
    } else {
        tokens.to_string()
    }
}

fn format_duration(seconds: i64) -> String {
    let secs = seconds.max(0) as u64;
    if secs >= 3600 {
        let h = secs / 3600;
        let m = (secs % 3600) / 60;
        format!("{h}h{m}m")
    } else if secs >= 60 {
        format!("{}m", secs / 60)
    } else {
        format!("{secs}s")
    }
}

fn format_started(raw: &str) -> String {
    if raw.len() >= 16 {
        raw[..16].to_string()
    } else {
        raw.to_string()
    }
}

fn format_cost(cost: f64) -> String {
    if cost < 0.01 {
        format!("${cost:.4}")
    } else {
        format!("${cost:.2}")
    }
}

fn exit_reason_style(exit_reason: &str) -> Style {
    match exit_reason {
        "normal" => Style::default().fg(Color::Green),
        "interrupt" => Style::default().fg(Color::Yellow),
        "pending" => Style::default().fg(Color::Rgb(255, 165, 0)),
        _ => Style::default(),
    }
}

fn ui(frame: &mut Frame<'_>, app: &mut App) {
    let area = frame.area();
    let chunks = Layout::default()
        .direction(Direction::Vertical)
        .constraints([
            Constraint::Length(3),
            Constraint::Length(3),
            Constraint::Min(6),
            Constraint::Length(2),
        ])
        .split(area);

    let summary = app.summary();
    let summary_text = format!(
        "Sessions: {}   Tokens: {}   Cost: {}",
        summary.count,
        compact_tokens(summary.tokens),
        format_cost(summary.cost_usd)
    );
    let summary_block = Paragraph::new(summary_text)
        .block(Block::default().title("claude-statusline history").borders(Borders::ALL))
        .wrap(Wrap { trim: true });
    frame.render_widget(summary_block, chunks[0]);

    let current_filter = app
        .selected_project
        .as_deref()
        .unwrap_or("All Projects");
    let filter_line = Paragraph::new(format!("Filter: [{current_filter} v]"))
        .block(Block::default().borders(Borders::ALL));
    frame.render_widget(filter_line, chunks[1]);

    let visible_rows = chunks[2].height.saturating_sub(3).max(1) as usize;
    app.set_visible_rows(visible_rows);

    let rows: Vec<Row<'_>> = app
        .filtered_sessions()
        .map(|session| {
            let tokens = session.tokens_in.saturating_add(session.tokens_out);
            let row_style = exit_reason_style(session.exit_reason.as_str());
            Row::new(vec![
                Cell::from(session.project_name.clone()),
                Cell::from(session.model.clone()),
                Cell::from(format_started(session.start_time.as_str())),
                Cell::from(format_duration(session.duration_seconds)),
                Cell::from(compact_tokens(tokens)),
                Cell::from(format_cost(session.cost_usd)),
            ])
            .style(row_style)
        })
        .collect();

    let table = Table::new(
        rows,
        [
            Constraint::Percentage(26),
            Constraint::Percentage(22),
            Constraint::Percentage(18),
            Constraint::Percentage(10),
            Constraint::Percentage(12),
            Constraint::Percentage(12),
        ],
    )
    .header(
        Row::new(vec!["Project", "Model", "Started", "Dur", "Tok", "Cost"])
            .style(Style::default().add_modifier(Modifier::BOLD)),
    )
    .block(Block::default().borders(Borders::ALL))
    .row_highlight_style(Style::default().add_modifier(Modifier::REVERSED))
    .highlight_symbol("> ");

    let mut table_state = TableState::default();
    if !app.filtered.is_empty() {
        table_state.select(Some(app.selected_row));
    }
    table_state = table_state.with_offset(app.table_offset);
    frame.render_stateful_widget(table, chunks[2], &mut table_state);
    app.table_offset = table_state.offset();

    let help = Paragraph::new("up/down or j/k: move   f: filter   Enter: apply   Esc: close   q: quit")
        .block(Block::default().borders(Borders::ALL));
    frame.render_widget(help, chunks[3]);

    if app.filter_open {
        let popup_width = area.width.min(42);
        let popup_height = area.height.min((app.projects.len() as u16).saturating_add(4).max(6));
        let popup_x = area.x + (area.width.saturating_sub(popup_width)) / 2;
        let popup_y = area.y + (area.height.saturating_sub(popup_height)) / 2;
        let popup_area = Rect::new(popup_x, popup_y, popup_width, popup_height);
        frame.render_widget(Clear, popup_area);

        let mut lines = Vec::with_capacity(app.projects.len() + 1);
        let all_style = if app.filter_cursor == 0 {
            Style::default().add_modifier(Modifier::REVERSED)
        } else {
            Style::default()
        };
        lines.push(Line::styled("All Projects", all_style));

        for (idx, project) in app.projects.iter().enumerate() {
            let style = if app.filter_cursor == idx + 1 {
                Style::default().add_modifier(Modifier::REVERSED)
            } else {
                Style::default()
            };
            lines.push(Line::styled(project.clone(), style));
        }

        let popup = Paragraph::new(lines)
            .block(Block::default().title("Filter by Project").borders(Borders::ALL));
        frame.render_widget(popup, popup_area);
    }
}

/// Terminal-native interactive history dashboard.
pub fn run() {
    let sessions = read_sessions(&history_path());
    let mut app = App::new(sessions);

    if enable_raw_mode().is_err() {
        eprintln!("failed to enable terminal raw mode");
        return;
    }

    let mut stdout = io::stdout();
    if execute!(stdout, EnterAlternateScreen).is_err() {
        let _ = disable_raw_mode();
        eprintln!("failed to enter alternate screen");
        return;
    }

    let backend = CrosstermBackend::new(stdout);
    let mut terminal = match Terminal::new(backend) {
        Ok(t) => t,
        Err(err) => {
            let _ = disable_raw_mode();
            eprintln!("failed to create terminal: {err}");
            return;
        }
    };

    let mut should_quit = false;
    while !should_quit {
        if terminal.draw(|frame| ui(frame, &mut app)).is_err() {
            break;
        }

        match event::poll(Duration::from_millis(150)) {
            Ok(true) => {
                if let Ok(Event::Key(key)) = event::read() {
                    if key.kind != KeyEventKind::Press {
                        continue;
                    }

                    if app.filter_open {
                        match key.code {
                            KeyCode::Up | KeyCode::Char('k') => app.move_filter_cursor(-1),
                            KeyCode::Down | KeyCode::Char('j') => app.move_filter_cursor(1),
                            KeyCode::Enter => app.apply_filter_cursor(),
                            KeyCode::Esc => app.close_filter(),
                            KeyCode::Char('q') => should_quit = true,
                            _ => {}
                        }
                    } else {
                        match key.code {
                            KeyCode::Up | KeyCode::Char('k') => app.move_selection(-1),
                            KeyCode::Down | KeyCode::Char('j') => app.move_selection(1),
                            KeyCode::Char('f') => app.open_filter(),
                            KeyCode::Char('q') => should_quit = true,
                            _ => {}
                        }
                    }
                }
            }
            Ok(false) => {}
            Err(_) => break,
        }
    }

    let _ = disable_raw_mode();
    let _ = execute!(terminal.backend_mut(), LeaveAlternateScreen);
    let _ = terminal.show_cursor();
}

#[cfg(test)]
#[path = "../tests/rust_unit/history_tui_tests.rs"]
mod tests;
