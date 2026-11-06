//! What both coding CLIs report, in one shape.

/// What a CLI said about its plan's own limits.
#[derive(Debug, Clone, PartialEq)]
pub struct LimitSignal {
    /// allowed, warning or rejected.
    pub status: String,
    /// e.g. five_hour, seven_day.
    pub window: Option<String>,
    /// 0..1 when the CLI reports it.
    pub utilization: Option<f64>,
    /// Unix seconds.
    pub resets_at: Option<u64>,
}

#[derive(Debug, Clone, PartialEq)]
pub enum CliEvent {
    /// The CLI's session (Claude Code) or thread (Codex) id.
    Session(String),
    Step(StepLine),
    /// Something the agent said; the last one of a turn is the part's answer.
    Text(String),
    /// The agent's thinking, where the tool shows it.
    Thinking(String),
    Usage {
        input: u64,
        output: u64,
        cache_read: u64,
        cache_write: u64,
        model: Option<String>,
    },
    Limit(LimitSignal),
    /// The turn ended. `error` is a short code, never the CLI's own text.
    TurnDone {
        ok: bool,
        text: String,
        error: Option<String>,
    },
}

#[derive(Debug, Clone, PartialEq)]
pub struct StepLine {
    pub tool: String,
    pub action: String,
    pub target: String,
}

const TARGET_MAX: usize = 120;

impl StepLine {
    pub fn new(tool: &str, action: &str, target: &str) -> Self {
        StepLine {
            tool: clip(tool, 40),
            action: clip(action, 60),
            target: clip(target, TARGET_MAX),
        }
    }
}

fn clip(s: &str, max: usize) -> String {
    let one_line: String = s
        .chars()
        .map(|c| if c.is_control() { ' ' } else { c })
        .collect();
    let trimmed = one_line.trim();
    if trimmed.chars().count() <= max {
        return trimmed.to_string();
    }
    let mut out: String = trimmed.chars().take(max - 1).collect();
    out.push('…');
    out
}

/// The program a shell line starts: `FOO=bar cargo test --x` is `cargo`. Only
/// the name, because the rest of a command line can hold a token.
pub fn program_of(command: &str) -> &str {
    command
        .split_whitespace()
        .find(|w| !w.contains('='))
        .map(|w| w.rsplit('/').next().unwrap_or(w))
        .unwrap_or("")
}

/// A URL's host, never its path or query (either can carry a secret).
pub fn host_of(url: &str) -> &str {
    let rest = url.split("://").nth(1).unwrap_or(url);
    let host = rest.split(['/', '?', '#']).next().unwrap_or("");
    host.rsplit('@').next().unwrap_or(host)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_command_line_is_reduced_to_its_program() {
        assert_eq!(
            program_of("GITHUB_TOKEN=ghp_secret gh pr create --body x"),
            "gh"
        );
        assert_eq!(
            program_of("/usr/bin/curl -H 'Authorization: Bearer x' https://a"),
            "curl"
        );
        assert_eq!(program_of(""), "");
    }

    #[test]
    fn a_url_is_reduced_to_its_host() {
        assert_eq!(
            host_of("https://user:pw@example.com/a?token=x"),
            "example.com"
        );
        assert_eq!(host_of("example.com/path"), "example.com");
    }

    #[test]
    fn step_lines_are_one_short_line() {
        let s = StepLine::new("files", "read", &format!("a\nb{}", "x".repeat(500)));
        assert!(!s.target.contains('\n'));
        assert_eq!(s.target.chars().count(), 120);
    }
}
