//! Install the runner as a per-user background service (launchd or systemd --user).

use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;

use anyhow::{bail, Context, Result};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Platform {
    Linux,
    Mac,
}

pub fn platform() -> Option<Platform> {
    if cfg!(target_os = "macos") {
        Some(Platform::Mac)
    } else if cfg!(target_os = "linux") {
        Some(Platform::Linux)
    } else {
        None
    }
}

pub const LABEL: &str = "lc.context.machine";
const UNIT: &str = "context-machine.service";
const LOG_FILE: &str = "runner.log";

pub fn launchd_plist(exe: &Path, log_dir: &Path) -> String {
    let exe = xml_escape(&exe.to_string_lossy());
    let log = xml_escape(&log_dir.join(LOG_FILE).to_string_lossy());
    format!(
        r#"<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>{LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>{exe}</string>
    <string>run</string>
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>ProcessType</key>
  <string>Background</string>
  <key>StandardOutPath</key>
  <string>{log}</string>
  <key>StandardErrorPath</key>
  <string>{log}</string>
</dict>
</plist>
"#
    )
}

pub fn systemd_unit(exe: &Path) -> String {
    format!(
        r#"[Unit]
Description=Context machine runner
After=network-online.target

[Service]
ExecStart={} run
Restart=always
RestartSec=5
NoNewPrivileges=true

[Install]
WantedBy=default.target
"#,
        systemd_arg(&exe.to_string_lossy())
    )
}

/// Unit files treat `%` and `$` as special, so they are doubled inside quotes.
fn systemd_arg(s: &str) -> String {
    let plain = !s.is_empty()
        && s.chars().all(|c| {
            c.is_ascii_alphanumeric() || matches!(c, '/' | '.' | '_' | '-' | '+' | ':' | '@')
        });
    if plain {
        return s.to_string();
    }
    let escaped = s
        .replace('\\', "\\\\")
        .replace('"', "\\\"")
        .replace('%', "%%")
        .replace('$', "$$");
    format!("\"{escaped}\"")
}

fn xml_escape(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for c in s.chars() {
        match c {
            '&' => out.push_str("&amp;"),
            '<' => out.push_str("&lt;"),
            '>' => out.push_str("&gt;"),
            '"' => out.push_str("&quot;"),
            '\'' => out.push_str("&apos;"),
            _ => out.push(c),
        }
    }
    out
}

pub fn unit_path(p: Platform, home: &Path) -> PathBuf {
    unit_path_with(p, home, None)
}

/// `xdg` is `XDG_CONFIG_HOME`. Only an absolute value is used, as the spec asks.
pub fn unit_path_with(p: Platform, home: &Path, xdg: Option<&Path>) -> PathBuf {
    match p {
        Platform::Mac => home
            .join("Library/LaunchAgents")
            .join(format!("{LABEL}.plist")),
        Platform::Linux => {
            let base = match xdg {
                Some(x) if x.is_absolute() => x.to_path_buf(),
                _ => home.join(".config"),
            };
            base.join("systemd/user").join(UNIT)
        }
    }
}

pub fn install(exe: &Path, home: &Path, state_dir: &Path) -> Result<String> {
    let p = platform().context("the background service is not supported on this platform")?;
    if !exe.is_absolute() || exe.to_string_lossy().chars().any(char::is_control) {
        bail!("the runner path must be absolute and have no control characters");
    }
    fs::create_dir_all(state_dir).with_context(|| format!("create {}", state_dir.display()))?;
    let path = unit_path(p, home);
    let body = match p {
        Platform::Mac => launchd_plist(exe, state_dir),
        Platform::Linux => systemd_unit(exe),
    };
    write_file(&path, &body)?;
    match p {
        Platform::Mac => {
            let domain = format!("gui/{}", uid());
            let target = mac_target();
            let plist = path.to_string_lossy().into_owned();
            // Ignore failure: the job may not be loaded yet.
            let _ = run("launchctl", &["bootout", target.as_str()]);
            run("launchctl", &["bootstrap", domain.as_str(), plist.as_str()])?;
            Ok(format!(
                "Installed {} and started the runner. It starts at login.",
                path.display()
            ))
        }
        Platform::Linux => {
            run("systemctl", &["--user", "daemon-reload"])?;
            run("systemctl", &["--user", "enable", "--now", UNIT])?;
            Ok(format!(
                "Installed {} and started the runner. It stops at logout unless lingering is on: run `loginctl enable-linger $USER`.",
                path.display()
            ))
        }
    }
}

pub fn uninstall(home: &Path) -> Result<String> {
    let p = platform().context("the background service is not supported on this platform")?;
    let path = unit_path(p, home);
    // Stop and disable first; both may fail if the service was never loaded.
    match p {
        Platform::Mac => {
            let _ = run("launchctl", &["bootout", mac_target().as_str()]);
        }
        Platform::Linux => {
            let _ = run("systemctl", &["--user", "disable", "--now", UNIT]);
        }
    }
    let existed = path.exists();
    if existed {
        fs::remove_file(&path).with_context(|| format!("remove {}", path.display()))?;
    }
    if existed && p == Platform::Linux {
        let _ = run("systemctl", &["--user", "daemon-reload"]);
    }
    Ok(if existed {
        format!("Stopped the runner and removed {}.", path.display())
    } else {
        "No background service was installed.".to_string()
    })
}

pub fn stop() -> Result<String> {
    let p = platform().context("the background service is not supported on this platform")?;
    match p {
        Platform::Mac => run("launchctl", &["bootout", mac_target().as_str()])?,
        Platform::Linux => run("systemctl", &["--user", "stop", UNIT])?,
    }
    Ok("Stopped the runner.".to_string())
}

pub fn is_installed(home: &Path) -> bool {
    platform().is_some_and(|p| unit_path(p, home).exists())
}

fn mac_target() -> String {
    format!("gui/{}/{LABEL}", uid())
}

fn write_file(path: &Path, body: &str) -> Result<()> {
    if let Some(dir) = path.parent() {
        fs::create_dir_all(dir).with_context(|| format!("create {}", dir.display()))?;
    }
    fs::write(path, body).with_context(|| format!("write {}", path.display()))
}

/// Runs a program with fixed arguments. No shell is involved.
fn run(program: &str, args: &[&str]) -> Result<()> {
    let out = Command::new(program)
        .args(args)
        .output()
        .with_context(|| format!("run {program}"))?;
    if out.status.success() {
        return Ok(());
    }
    let err = String::from_utf8_lossy(&out.stderr);
    bail!("{program} {} failed: {}", args.join(" "), err.trim())
}

#[cfg(unix)]
fn uid() -> u32 {
    // SAFETY: getuid has no preconditions and cannot fail.
    unsafe { libc::getuid() }
}

#[cfg(not(unix))]
fn uid() -> u32 {
    0
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn plist_has_run_arguments_and_keep_alive() {
        let plist = launchd_plist(
            Path::new("/opt/context/context-machine"),
            Path::new("/home/u/.local/state/context"),
        );
        assert!(plist.contains("<string>lc.context.machine</string>"));
        assert!(plist
            .contains("<string>/opt/context/context-machine</string>\n    <string>run</string>"));
        assert!(plist.contains("<key>KeepAlive</key>\n  <true/>"));
        assert!(plist.contains("<key>RunAtLoad</key>\n  <true/>"));
        assert!(plist.contains("<string>Background</string>"));
        assert_eq!(
            plist
                .matches("<string>/home/u/.local/state/context/runner.log</string>")
                .count(),
            2
        );
    }

    #[test]
    fn plist_escapes_xml_in_paths() {
        let plist = launchd_plist(Path::new("/tmp/a&b<c>/x"), Path::new("/tmp/\"q\"'s"));
        assert!(plist.contains("<string>/tmp/a&amp;b&lt;c&gt;/x</string>"));
        assert!(plist.contains("/tmp/&quot;q&quot;&apos;s/runner.log"));
        assert!(!plist.contains("a&b<c>"));
    }

    #[test]
    fn systemd_unit_plain_path() {
        let unit = systemd_unit(Path::new("/opt/context/context-machine"));
        assert!(unit.contains("\nExecStart=/opt/context/context-machine run\n"));
        assert!(unit.contains("After=network-online.target"));
        assert!(unit.contains("Restart=always\nRestartSec=5\n"));
        assert!(unit.contains("NoNewPrivileges=true"));
        assert!(unit.contains("WantedBy=default.target"));
    }

    #[test]
    fn systemd_unit_quotes_spaces() {
        let unit = systemd_unit(Path::new("/home/u/My Apps/context-machine"));
        assert!(unit.contains("ExecStart=\"/home/u/My Apps/context-machine\" run\n"));
    }

    #[test]
    fn systemd_unit_escapes_specifiers_and_quotes() {
        let unit = systemd_unit(Path::new("/x/a%b\"c$d"));
        assert!(unit.contains("ExecStart=\"/x/a%%b\\\"c$$d\" run\n"));
    }

    #[test]
    fn unit_paths_per_platform() {
        let home = Path::new("/home/u");
        assert_eq!(
            unit_path(Platform::Mac, home),
            PathBuf::from("/home/u/Library/LaunchAgents/lc.context.machine.plist")
        );
        assert_eq!(
            unit_path(Platform::Linux, home),
            PathBuf::from("/home/u/.config/systemd/user/context-machine.service")
        );
    }

    #[test]
    fn xdg_config_home_only_when_absolute() {
        let home = Path::new("/home/u");
        assert_eq!(
            unit_path_with(Platform::Linux, home, Some(Path::new("/srv/cfg"))),
            PathBuf::from("/srv/cfg/systemd/user/context-machine.service")
        );
        assert_eq!(
            unit_path_with(Platform::Linux, home, Some(Path::new("relative/cfg"))),
            PathBuf::from("/home/u/.config/systemd/user/context-machine.service")
        );
        assert_eq!(
            unit_path_with(Platform::Linux, home, None),
            PathBuf::from("/home/u/.config/systemd/user/context-machine.service")
        );
        // The launchd path ignores XDG.
        assert_eq!(
            unit_path_with(Platform::Mac, home, Some(Path::new("/srv/cfg"))),
            unit_path(Platform::Mac, home)
        );
    }

    #[test]
    fn is_installed_follows_the_unit_file() {
        let Some(p) = platform() else { return };
        let dir = tempfile::tempdir().unwrap();
        assert!(!is_installed(dir.path()));
        let path = unit_path(p, dir.path());
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(&path, "x").unwrap();
        assert!(is_installed(dir.path()));
    }
}
