//! Per-session state kept in `<claude_dir>/statusline/sessions/<session_id>.json`:
//! transcript read cursors, deduplicated token totals, git commit baselines, and the
//! last values seen for the history record written at SessionEnd.

use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::fs;
use std::io::{Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};

#[derive(Serialize, Deserialize, Default, Clone, PartialEq, Debug)]
#[serde(default)]
pub struct FileCursor {
    /// Byte offset just past the last complete line read.
    pub off: u64,
    /// `message.id:requestId` of the last counted assistant entry. Claude Code writes one
    /// transcript line per content block, each repeating the same usage; repeats are adjacent.
    pub key: String,
}

#[derive(Serialize, Deserialize, Default, Clone, PartialEq, Debug)]
#[serde(default)]
pub struct GitCursor {
    /// HEAD when the session first saw this repo.
    pub base: String,
    /// HEAD at the last render, with `n` = commits in `base..sha`.
    pub sha: String,
    pub n: u64,
}

#[derive(Serialize, Deserialize, Default, Clone, PartialEq, Debug)]
#[serde(default)]
pub struct State {
    /// Keyed by transcript path (main transcript plus subagent transcripts).
    pub files: BTreeMap<String, FileCursor>,
    /// input_tokens + cache_creation_input_tokens
    pub tin: u64,
    /// cache_read_input_tokens
    pub tcache: u64,
    /// output_tokens
    pub tout: u64,
    /// Keyed by repo root.
    pub git: BTreeMap<String, GitCursor>,
    /// Unix seconds of the first render.
    pub start: u64,
    pub model: String,
    pub project: String,
    /// stdin cost.total_cost_usd
    pub cost: f64,
    /// stdin cost.total_duration_ms / 1000
    pub dur: u64,
}

pub fn now_secs() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
}

impl State {
    /// Records the values the history needs from one statusline input.
    pub fn note_input(&mut self, data: &serde_json::Value, model: &str, dir: &str) {
        if self.start == 0 {
            self.start = now_secs();
        }
        self.model = model.to_string();
        let project_dir = data["workspace"]["project_dir"].as_str().filter(|s| !s.is_empty()).unwrap_or(dir);
        self.project = crate::sanitize(
            &Path::new(project_dir).file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default(),
        );
        if let Some(cost) = data["cost"]["total_cost_usd"].as_f64() {
            self.cost = cost;
        }
        if let Some(ms) = data["cost"]["total_duration_ms"].as_u64() {
            self.dur = ms / 1000;
        }
    }
}

fn home_dir() -> PathBuf {
    std::env::var("HOME")
        .or_else(|_| std::env::var("USERPROFILE"))
        .map(PathBuf::from)
        .unwrap_or_else(|_| PathBuf::from("."))
}

/// `$CLAUDE_CONFIG_DIR`, else `~/.claude`.
pub fn claude_dir() -> PathBuf {
    std::env::var("CLAUDE_CONFIG_DIR")
        .ok()
        .filter(|s| !s.is_empty())
        .map(PathBuf::from)
        .unwrap_or_else(|| home_dir().join(".claude"))
}

/// State file for a session, or None when the id is empty or not a plain file-name token.
pub fn state_path(claude_dir: &Path, session: &str) -> Option<PathBuf> {
    let safe = !session.is_empty()
        && session.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_');
    safe.then(|| claude_dir.join("statusline").join("sessions").join(format!("{session}.json")))
}

pub fn load(path: &Path) -> State {
    fs::read_to_string(path)
        .ok()
        .and_then(|t| serde_json::from_str(&t).ok())
        .unwrap_or_default()
}

pub fn save(path: &Path, state: &State) {
    if let Some(parent) = path.parent() {
        let _ = fs::create_dir_all(parent);
    }
    let tmp = path.with_extension("tmp");
    if let Ok(text) = serde_json::to_string(state) {
        if fs::write(&tmp, text).is_ok() {
            let _ = fs::rename(&tmp, path);
        }
    }
}

/// Reads new bytes of the main transcript and of `<transcript stem>/subagents/*.jsonl`.
pub fn update_tokens(state: &mut State, transcript: &Path) {
    let mut paths = vec![transcript.to_path_buf()];
    let subagents = transcript.with_extension("").join("subagents");
    if let Ok(entries) = fs::read_dir(&subagents) {
        let mut subs: Vec<PathBuf> = entries
            .flatten()
            .map(|e| e.path())
            .filter(|p| p.extension().map_or(false, |e| e == "jsonl"))
            .collect();
        subs.sort();
        paths.extend(subs);
    }
    for path in paths {
        let key = path.to_string_lossy().to_string();
        let mut cursor = state.files.get(&key).cloned().unwrap_or_default();
        if scan_file(&path, &mut cursor, state) {
            state.files.insert(key, cursor);
        }
    }
}

/// Returns false when the file can't be read (so no cursor is recorded for it).
fn scan_file(path: &Path, cursor: &mut FileCursor, state: &mut State) -> bool {
    let Ok(mut file) = fs::File::open(path) else { return false };
    let len = file.metadata().map(|m| m.len()).unwrap_or(0);
    if len < cursor.off {
        // ponytail: transcripts are append-only; a shrink means replacement, so skip rather than recount.
        cursor.off = len;
    }
    if len == cursor.off {
        return true;
    }
    let mut buf = Vec::with_capacity((len - cursor.off) as usize);
    if file.seek(SeekFrom::Start(cursor.off)).is_err() || file.read_to_end(&mut buf).is_err() {
        return true;
    }
    // Only complete lines: the writer may be mid-line.
    let Some(last_nl) = buf.iter().rposition(|&b| b == b'\n') else { return true };
    for line in buf[..last_nl].split(|&b| b == b'\n') {
        count_line(line, cursor, state);
    }
    cursor.off += last_nl as u64 + 1;
    true
}

fn contains(hay: &[u8], needle: &[u8]) -> bool {
    hay.windows(needle.len()).any(|w| w == needle)
}

fn count_line(line: &[u8], cursor: &mut FileCursor, state: &mut State) {
    // Cheap pre-filter: most lines are large tool results that never carry usage.
    if !contains(line, b"\"usage\"") || !contains(line, b"\"assistant\"") {
        return;
    }
    let Ok(entry) = serde_json::from_slice::<serde_json::Value>(line) else { return };
    if entry["type"] != "assistant" {
        return;
    }
    let Some(usage) = entry["message"]["usage"].as_object() else { return };
    let id = entry["message"]["id"].as_str().unwrap_or("");
    if !id.is_empty() {
        let key = format!("{}:{}", id, entry["requestId"].as_str().unwrap_or(""));
        if key == cursor.key {
            return;
        }
        cursor.key = key;
    }
    let get = |k: &str| usage.get(k).and_then(|v| v.as_u64()).unwrap_or(0);
    state.tin += get("input_tokens") + get("cache_creation_input_tokens");
    state.tcache += get("cache_read_input_tokens");
    state.tout += get("output_tokens");
}

/// Walks up from `start` to the repo root. Returns (root, gitdir, commondir).
fn find_git(start: &Path) -> Option<(PathBuf, PathBuf, PathBuf)> {
    for dir in start.ancestors() {
        let dotgit = dir.join(".git");
        if dotgit.is_dir() {
            return Some((dir.to_path_buf(), dotgit.clone(), dotgit));
        }
        if dotgit.is_file() {
            // Linked worktree or submodule: ".git" is a file containing "gitdir: <path>".
            let text = fs::read_to_string(&dotgit).ok()?;
            let gitdir = dir.join(text.trim().strip_prefix("gitdir:")?.trim());
            let common = fs::read_to_string(gitdir.join("commondir"))
                .map(|c| gitdir.join(c.trim()))
                .unwrap_or_else(|_| gitdir.clone());
            return Some((dir.to_path_buf(), gitdir, common));
        }
    }
    None
}

/// (branch label, HEAD sha) straight from the files in `.git`. None when the layout
/// needs git itself (e.g. the reftable backend).
fn read_head(gitdir: &Path, common: &Path) -> Option<(String, String)> {
    let head = fs::read_to_string(gitdir.join("HEAD")).ok()?;
    let head = head.trim();
    if let Some(reference) = head.strip_prefix("ref: ") {
        let branch = reference.strip_prefix("refs/heads/").unwrap_or(reference);
        if branch == ".invalid" {
            return None;
        }
        let sha = fs::read_to_string(common.join(reference))
            .ok()
            .map(|s| s.trim().to_string())
            .or_else(|| {
                let packed = fs::read_to_string(common.join("packed-refs")).ok()?;
                packed.lines().find_map(|l| {
                    let (sha, name) = l.split_once(' ')?;
                    (name == reference).then(|| sha.to_string())
                })
            })
            .unwrap_or_default(); // unborn branch: no commits yet
        return Some((branch.to_string(), sha));
    }
    (head.len() >= 40 && head.bytes().all(|b| b.is_ascii_hexdigit()))
        .then(|| (head[..7].to_string(), head.to_string()))
}

fn git_output(dir: &Path, args: &[&str]) -> Option<String> {
    let out = std::process::Command::new("git")
        .args(args)
        .current_dir(dir)
        .stderr(std::process::Stdio::null())
        .output()
        .ok()?;
    out.status.success().then(|| String::from_utf8_lossy(&out.stdout).to_string())
}

/// Returns (branch label, commits made this session). Reads `.git` directly; spawns git
/// only for unusual layouts and when HEAD moved since the last render.
pub fn git_info(dir: &Path, state: &mut State) -> (String, u64) {
    let Some((root, gitdir, common)) = find_git(dir) else { return (String::new(), 0) };
    let (branch, sha) = match read_head(&gitdir, &common) {
        Some(head) => head,
        None => {
            let Some(out) = git_output(&root, &["rev-parse", "HEAD", "--abbrev-ref", "HEAD"]) else {
                return (String::new(), 0);
            };
            let mut lines = out.lines();
            let sha = lines.next().unwrap_or("").trim().to_string();
            let branch = lines.next().unwrap_or("").trim().to_string();
            let branch = if branch == "HEAD" { sha.chars().take(7).collect() } else { branch };
            (branch, sha)
        }
    };
    if sha.is_empty() {
        return (branch, 0);
    }
    let cursor = state.git.entry(root.to_string_lossy().to_string()).or_default();
    if cursor.base.is_empty() {
        *cursor = GitCursor { base: sha.clone(), sha, n: 0 };
    } else if cursor.sha != sha {
        let range = format!("{}..{}", cursor.base, sha);
        cursor.n = git_output(&root, &["rev-list", "--count", &range])
            .and_then(|s| s.trim().parse().ok())
            .unwrap_or(0);
        cursor.sha = sha;
    }
    (branch, cursor.n)
}

#[cfg(test)]
#[path = "../tests/rust_unit/session_tests.rs"]
mod tests;
