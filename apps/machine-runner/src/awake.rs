//! Keeping the machine awake for Tex while it is plugged in.
//!
//! Nothing reliably wakes a sleeping laptop from the internet, so the runner
//! keeps it from idle sleep instead: `systemd-inhibit` on Linux, `caffeinate`
//! on a Mac. On battery it lets the machine sleep, and the machine shows as
//! offline. A machine with no battery (a VM, a desktop) counts as plugged in.
//! The Mac app keeps the Mac awake itself and passes `--no-keep-awake`.

use std::time::Duration;
use tokio::process::{Child, Command};

pub async fn keep_awake_while_plugged_in() {
    let mut holder: Option<Child> = None;
    loop {
        let want = on_mains_power().await;
        match (&mut holder, want) {
            (None, true) => holder = start_inhibitor(),
            (Some(child), false) => {
                let _ = child.kill().await;
                holder = None;
            }
            (Some(child), true) => {
                if child.try_wait().ok().flatten().is_some() {
                    holder = start_inhibitor();
                }
            }
            (None, false) => {}
        }
        tokio::time::sleep(Duration::from_secs(60)).await;
    }
}

fn start_inhibitor() -> Option<Child> {
    let mut cmd = if cfg!(target_os = "macos") {
        let mut c = Command::new("caffeinate");
        c.args(["-i", "-w", &std::process::id().to_string()]);
        c
    } else {
        crate::facts::which("systemd-inhibit")?;
        let mut c = Command::new("systemd-inhibit");
        c.args([
            "--what=idle:sleep",
            "--who=context-machine",
            "--why=Tex can run jobs on this machine",
            "--mode=block",
            "sleep",
            "infinity",
        ]);
        c
    };
    cmd.stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .kill_on_drop(true);
    cmd.spawn().ok()
}

async fn on_mains_power() -> bool {
    if cfg!(target_os = "macos") {
        let out = Command::new("pmset").args(["-g", "batt"]).output().await;
        return out
            .map(|o| !String::from_utf8_lossy(&o.stdout).contains("Battery Power"))
            .unwrap_or(true);
    }
    linux_on_mains(std::path::Path::new("/sys/class/power_supply"))
}

/// On mains when any mains supply is online, or when there is no battery.
pub fn linux_on_mains(root: &std::path::Path) -> bool {
    let mut has_battery = false;
    for entry in std::fs::read_dir(root).into_iter().flatten().flatten() {
        let kind = std::fs::read_to_string(entry.path().join("type")).unwrap_or_default();
        match kind.trim() {
            "Mains" | "USB" => {
                if std::fs::read_to_string(entry.path().join("online"))
                    .unwrap_or_default()
                    .trim()
                    == "1"
                {
                    return true;
                }
            }
            "Battery" => has_battery = true,
            _ => {}
        }
    }
    !has_battery
}

#[cfg(test)]
mod tests {
    use super::*;

    fn supply(root: &std::path::Path, name: &str, kind: &str, online: Option<&str>) {
        let d = root.join(name);
        std::fs::create_dir_all(&d).unwrap();
        std::fs::write(d.join("type"), kind).unwrap();
        if let Some(o) = online {
            std::fs::write(d.join("online"), o).unwrap();
        }
    }

    #[test]
    fn power_sources() {
        let d = tempfile::tempdir().unwrap();
        assert!(
            linux_on_mains(d.path()),
            "no battery: a VM counts as plugged in"
        );
        supply(d.path(), "BAT0", "Battery", None);
        supply(d.path(), "AC", "Mains", Some("0"));
        assert!(!linux_on_mains(d.path()));
        std::fs::write(d.path().join("AC/online"), "1").unwrap();
        assert!(linux_on_mains(d.path()));
    }
}
