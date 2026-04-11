use crate::sanitize;

pub struct StatusInput {
    pub model: String,
    pub dir: String,
    pub session: String,
    pub remaining_pct: Option<f64>,
}

pub fn parse_status_input(data: &serde_json::Value) -> StatusInput {
    let model = {
        let m = sanitize(data["model"]["display_name"].as_str().unwrap_or(""));
        if m.is_empty() {
            "Claude".to_string()
        } else {
            m
        }
    };

    let dir = {
        let d = data["workspace"]["current_dir"].as_str().unwrap_or("").to_string();
        if d.is_empty() {
            std::env::current_dir()
                .map(|p| p.to_string_lossy().to_string())
                .unwrap_or_default()
        } else {
            d
        }
    };

    let session = data["session_id"].as_str().unwrap_or("").to_string();
    let remaining_pct = data["context_window"]["remaining_percentage"].as_f64();

    StatusInput {
        model,
        dir,
        session,
        remaining_pct,
    }
}
