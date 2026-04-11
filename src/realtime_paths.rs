use std::path::{Path, PathBuf};

fn sanitize_slug(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for ch in s.chars() {
        if ch.is_ascii_alphanumeric() || ch == '-' || ch == '_' {
            out.push(ch);
        } else {
            out.push('-');
        }
    }
    while out.contains("--") {
        out = out.replace("--", "-");
    }
    out.trim_matches('-').to_string()
}

pub fn claude_dir() -> PathBuf {
    std::env::var("CLAUDE_CONFIG_DIR")
        .ok()
        .filter(|s| !s.is_empty())
        .map(PathBuf::from)
        .or_else(|| {
            std::env::var("HOME")
                .ok()
                .filter(|s| !s.is_empty())
                .map(|h| Path::new(&h).join(".claude"))
        })
        .unwrap_or_else(|| PathBuf::from("."))
}

pub fn tty_slug() -> String {
    if let Ok(v) = std::env::var("CLAUDE_STATUSLINE_TTY") {
        let s = sanitize_slug(v.trim());
        if !s.is_empty() {
            return s;
        }
    }

    if let Ok(v) = std::env::var("TERM_SESSION_ID") {
        let s = sanitize_slug(v.trim());
        if !s.is_empty() {
            return s;
        }
    }

    sanitize_slug(&format!("pid-{}", std::process::id()))
}

pub fn renderer_registry_path(dir: &Path, tty: &str) -> PathBuf {
    dir.join(format!("statusline-renderer-{}.json", sanitize_slug(tty)))
}

pub fn state_path(dir: &Path, tty: &str) -> PathBuf {
    dir.join(format!("statusline-state-{}.json", sanitize_slug(tty)))
}

pub fn socket_path(dir: &Path, tty: &str) -> PathBuf {
    dir.join(format!("statusline-rt-{}.sock", sanitize_slug(tty)))
}

pub fn atomic_write(path: &Path, content: &str) -> std::io::Result<()> {
    let tmp = path.with_extension("tmp");
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    std::fs::write(&tmp, content)?;
    std::fs::rename(&tmp, path)
}
