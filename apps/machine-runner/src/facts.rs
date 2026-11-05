//! What the runner tells the gateway about this machine, for the slot advice,
//! the "not ready" state and the editable "good at" note.
//!
//! Facts only: OS, chip, memory, which tools are installed and whether the two
//! coding CLIs are signed in. Never a token, never a file's contents, never the
//! OS user name. Sign-in is asked of each CLI's own status command; the runner
//! never opens `~/.claude` or `~/.codex`.

use crate::protocol::{MachineFacts, Os, Tool, ToolFact};
use std::path::{Path, PathBuf};
use std::time::Duration;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ToolState {
    SignedIn,
    Installed,
    Missing,
}

/// Tools worth naming in the good-at note. Presence only.
const NOTABLE_TOOLS: &[&str] = &[
    "git",
    "gh",
    "node",
    "pnpm",
    "npm",
    "bun",
    "python3",
    "cargo",
    "go",
    "docker",
    "wrangler",
    "op",
    "xcodebuild",
    "gcloud",
    "aws",
    "fly",
    "vercel",
];

pub async fn gather() -> MachineFacts {
    let mem = memory();
    let mut tools = vec![];
    for tool in [Tool::Claude, Tool::Codex] {
        let state = cli_state(tool.name()).await;
        tools.push(ToolFact {
            name: tool.name().into(),
            installed: state != ToolState::Missing,
            signed_in: state == ToolState::SignedIn,
            version: None,
        });
    }
    tools.extend(
        NOTABLE_TOOLS
            .iter()
            .filter(|t| which(t).is_some())
            .map(|t| ToolFact {
                name: t.to_string(),
                installed: true,
                signed_in: false,
                version: None,
            }),
    );
    MachineFacts {
        os: if cfg!(target_os = "macos") {
            Os::Macos
        } else if cfg!(windows) {
            Os::Windows
        } else {
            Os::Linux
        },
        os_version: os_version().await.map(|v| clip(&v, 64)),
        arch: std::env::consts::ARCH.to_string(),
        chip: chip().await.map(|c| clip(&c, 128)),
        memory_mb: mem.total_mb,
        cores: cores(),
        gpu: None,
        has_screen: Some(cfg!(target_os = "macos")),
        tools,
        repos: None,
        sign_in: Some(vec![Tool::Claude, Tool::Codex]),
        run_settings: Some(true),
        install: crate::install::tools_dir()
            .and(crate::install::platform_here())
            .map(|_| vec![Tool::Claude, Tool::Codex]),
    }
}

/// Whether a coding tool is installed and signed in, from the facts.
pub fn ready(facts: &MachineFacts, tool: Tool) -> bool {
    facts
        .tools
        .iter()
        .any(|t| t.name == tool.name() && t.signed_in)
}

fn clip(s: &str, max: usize) -> String {
    s.chars().take(max).collect()
}

/// Repository names under the allowed folders (the folder itself and one level
/// down): `owner/name` from the origin remote, else the folder's name. Names
/// only, never paths outside the folders.
pub fn repos_in(folders: &[String]) -> Vec<String> {
    let mut out = vec![];
    for f in folders {
        let root = Path::new(f);
        let mut candidates = vec![root.to_path_buf()];
        candidates.extend(
            std::fs::read_dir(root)
                .into_iter()
                .flatten()
                .flatten()
                .map(|e| e.path()),
        );
        for dir in candidates {
            if dir.join(".git").exists() {
                let name = crate::workdir::origin_repo(&dir)
                    .or_else(|| dir.file_name().map(|n| n.to_string_lossy().to_string()));
                if let Some(n) = name {
                    if !out.contains(&n) && out.len() < 100 {
                        out.push(n);
                    }
                }
            }
        }
    }
    out
}

pub fn cores() -> u32 {
    std::thread::available_parallelism()
        .map(|n| n.get() as u32)
        .unwrap_or(1)
}

#[derive(Debug, Clone, Copy, Default)]
pub struct Memory {
    pub total_mb: u64,
    pub available_mb: u64,
}

/// Total and available memory. Available is what a new session could use
/// without pushing the person's own apps out.
pub fn memory() -> Memory {
    #[cfg(target_os = "linux")]
    {
        if let Ok(text) = std::fs::read_to_string("/proc/meminfo") {
            return parse_meminfo(&text);
        }
    }
    #[cfg(target_os = "macos")]
    {
        return macos_memory();
    }
    #[allow(unreachable_code)]
    Memory::default()
}

#[cfg_attr(not(target_os = "linux"), allow(dead_code))]
pub fn parse_meminfo(text: &str) -> Memory {
    let field = |name: &str| {
        text.lines()
            .find(|l| l.starts_with(name))
            .and_then(|l| l.split_whitespace().nth(1))
            .and_then(|v| v.parse::<u64>().ok())
            .map(|kb| kb / 1024)
    };
    Memory {
        total_mb: field("MemTotal:").unwrap_or(0),
        available_mb: field("MemAvailable:")
            .or_else(|| field("MemFree:"))
            .unwrap_or(0),
    }
}

#[cfg(target_os = "macos")]
fn macos_memory() -> Memory {
    let total = std::process::Command::new("sysctl")
        .args(["-n", "hw.memsize"])
        .output()
        .ok()
        .and_then(|o| String::from_utf8(o.stdout).ok())
        .and_then(|s| s.trim().parse::<u64>().ok())
        .unwrap_or(0)
        / (1024 * 1024);
    let available = std::process::Command::new("vm_stat")
        .output()
        .ok()
        .and_then(|o| String::from_utf8(o.stdout).ok())
        .map(|s| parse_vm_stat(&s))
        .unwrap_or(0);
    Memory {
        total_mb: total,
        available_mb: available,
    }
}

#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
/// Free + inactive + speculative + purgeable pages, as macOS counts what a new
/// process can have.
pub fn parse_vm_stat(text: &str) -> u64 {
    let page = text
        .lines()
        .next()
        .and_then(|l| l.split("page size of ").nth(1))
        .and_then(|r| r.split_whitespace().next())
        .and_then(|n| n.parse::<u64>().ok())
        .unwrap_or(16384);
    let pages = |name: &str| {
        text.lines()
            .find(|l| l.starts_with(name))
            .and_then(|l| l.rsplit(':').next())
            .and_then(|v| v.trim().trim_end_matches('.').parse::<u64>().ok())
            .unwrap_or(0)
    };
    let free = pages("Pages free")
        + pages("Pages inactive")
        + pages("Pages speculative")
        + pages("Pages purgeable");
    free * page / (1024 * 1024)
}

async fn os_version() -> Option<String> {
    if cfg!(target_os = "macos") {
        return run_text("sw_vers", &["-productVersion"])
            .await
            .map(|v| format!("macOS {v}"));
    }
    let text = tokio::fs::read_to_string("/etc/os-release").await.ok()?;
    text.lines()
        .find_map(|l| l.strip_prefix("PRETTY_NAME="))
        .map(|v| v.trim_matches('"').to_string())
}

async fn chip() -> Option<String> {
    if cfg!(target_os = "macos") {
        return run_text("sysctl", &["-n", "machdep.cpu.brand_string"]).await;
    }
    let text = tokio::fs::read_to_string("/proc/cpuinfo").await.ok()?;
    text.lines()
        .find(|l| l.starts_with("model name"))
        .and_then(|l| l.split(':').nth(1))
        .map(|v| v.trim().to_string())
}

async fn run_text(cmd: &str, args: &[&str]) -> Option<String> {
    let out = tokio::time::timeout(
        Duration::from_secs(5),
        tokio::process::Command::new(cmd)
            .args(args)
            .kill_on_drop(true)
            .output(),
    )
    .await
    .ok()?
    .ok()?;
    let s = String::from_utf8(out.stdout).ok()?.trim().to_string();
    (!s.is_empty()).then_some(s)
}

/// Whether a coding CLI is installed and signed in, asked of the CLI itself.
pub async fn cli_state(name: &str) -> ToolState {
    let Some(path) = tool_path(name) else {
        return ToolState::Missing;
    };
    let args: &[&str] = match name {
        "claude" => &["auth", "status"],
        _ => &["login", "status"],
    };
    let out = tokio::time::timeout(
        Duration::from_secs(15),
        tokio::process::Command::new(&path)
            .args(args)
            .stdin(std::process::Stdio::null())
            .kill_on_drop(true)
            .output(),
    )
    .await;
    match out {
        Ok(Ok(o))
            if signed_in(
                name,
                o.status.success(),
                &String::from_utf8_lossy(&o.stdout),
            ) =>
        {
            ToolState::SignedIn
        }
        _ => ToolState::Installed,
    }
}

/// Reads what each status command printed. `claude auth status` prints JSON
/// with `loggedIn`; `codex login status` exits 0 only when signed in.
pub fn signed_in(name: &str, exit_ok: bool, stdout: &str) -> bool {
    if name == "claude" {
        return serde_json::from_str::<serde_json::Value>(stdout)
            .ok()
            .and_then(|v| v.get("loggedIn").and_then(|b| b.as_bool()))
            .unwrap_or(false);
    }
    exit_ok && !stdout.to_ascii_lowercase().contains("not logged in")
}

/// Where a coding tool is: the copy installed from the app (`install.rs`)
/// first, so a broken copy elsewhere on PATH doesn't shadow it, else PATH.
/// The installed copy is given by its real path, so it finds the files
/// unpacked beside it.
pub fn tool_path(name: &str) -> Option<PathBuf> {
    crate::install::tools_dir()
        .map(|d| d.join("bin").join(name))
        .and_then(|link| link.canonicalize().ok())
        .filter(|p| is_executable(p))
        .or_else(|| which(name))
}

/// Finds an executable on PATH, as a shell would.
pub fn which(name: &str) -> Option<PathBuf> {
    let path = std::env::var_os("PATH")?;
    std::env::split_paths(&path)
        .map(|dir| dir.join(name))
        .find(|candidate| is_executable(candidate))
}

fn is_executable(p: &Path) -> bool {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        p.metadata()
            .map(|m| m.is_file() && m.permissions().mode() & 0o111 != 0)
            .unwrap_or(false)
    }
    #[cfg(not(unix))]
    {
        p.is_file()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn meminfo() {
        let m = parse_meminfo(
            "MemTotal:       8000000 kB\nMemFree:  100 kB\nMemAvailable:   4096000 kB\n",
        );
        assert_eq!(m.total_mb, 7812);
        assert_eq!(m.available_mb, 4000);
    }

    #[test]
    fn vm_stat() {
        let text = "Mach Virtual Memory Statistics: (page size of 16384 bytes)\nPages free:  65536.\nPages inactive: 65536.\nPages speculative: 0.\n";
        assert_eq!(parse_vm_stat(text), 2048);
    }

    #[test]
    fn claude_signed_in_reads_its_json() {
        assert!(signed_in(
            "claude",
            true,
            r#"{"loggedIn": true, "authMethod": "oauth_token"}"#
        ));
        assert!(!signed_in("claude", true, r#"{"loggedIn": false}"#));
        assert!(!signed_in("claude", true, "garbage"));
    }

    #[test]
    fn codex_signed_in_is_its_exit_code() {
        assert!(signed_in("codex", true, "Logged in using ChatGPT"));
        assert!(!signed_in("codex", false, ""));
        assert!(!signed_in("codex", true, "Not logged in"));
    }
}
