//! Keeping a headless runner up to date by itself.
//!
//! A runner put in place by `install.sh` (`~/.context-machine/bin/context-machine`)
//! looks for a newer `machine-runner-v<x.y.z>` release a few minutes after it starts
//! and then every six hours. A newer one is fetched from the same GitHub release
//! `install.sh` reads, its `.sha256` checked, and the binary swapped in beside the
//! running one. Once no job, install or sign-in is under way the runner starts the
//! new binary in its own place (`exec`), with the same arguments, so the service,
//! the pairing and the settings carry on.
//!
//! The Mac app's runner never updates itself: the app ships it inside its signed
//! bundle and updates as a whole (it passes `--grant-file`). Neither does a runner
//! run from anywhere else (a cargo build, a package manager), and
//! `CONTEXT_MACHINE_AUTO_UPDATE=off` turns it off. `context-machine update` does
//! the same check and swap at once, by hand.

use anyhow::{anyhow, bail, Context, Result};
use sha2::{Digest, Sha256};
use std::path::{Path, PathBuf};
use std::time::Duration;

const REPO: &str = "Supa-Media/context";
const TAG_PREFIX: &str = "machine-runner-v";
/// The first look, once the runner has settled in.
pub const FIRST_LOOK: Duration = Duration::from_secs(5 * 60);
/// How often it looks again.
pub const EVERY: Duration = Duration::from_secs(6 * 60 * 60);
/// A runner archive is a few MB; anything near this is not one.
const MOST_BYTES: u64 = 200 * 1024 * 1024;

/// `x.y.z` as numbers, or None for anything else (a pre-release, a stray tag).
pub fn version_of(s: &str) -> Option<(u64, u64, u64)> {
    let mut parts = s.split('.');
    let mut next = || -> Option<u64> {
        let p = parts.next()?;
        if p.is_empty() || p.len() > 6 || !p.bytes().all(|b| b.is_ascii_digit()) {
            return None;
        }
        p.parse().ok()
    };
    let v = (next()?, next()?, next()?);
    if parts.next().is_some() {
        return None;
    }
    Some(v)
}

/// The newest runner release in a GitHub releases listing: its tag and version.
/// Drafts and pre-releases never count.
pub fn newest(releases: &serde_json::Value) -> Option<(String, (u64, u64, u64))> {
    releases
        .as_array()?
        .iter()
        .filter(|r| r["draft"] != true && r["prerelease"] != true)
        .filter_map(|r| {
            let tag = r["tag_name"].as_str()?;
            let v = version_of(tag.strip_prefix(TAG_PREFIX)?)?;
            Some((tag.to_string(), v))
        })
        .max_by_key(|(_, v)| *v)
}

/// The target triple this build is published under (`install.sh` picks the same).
pub fn target() -> Option<&'static str> {
    match (std::env::consts::OS, std::env::consts::ARCH) {
        ("linux", "x86_64") => Some("x86_64-unknown-linux-musl"),
        ("linux", "aarch64") => Some("aarch64-unknown-linux-musl"),
        ("macos", "x86_64") => Some("x86_64-apple-darwin"),
        ("macos", "aarch64") => Some("aarch64-apple-darwin"),
        _ => None,
    }
}

/// The hex digest in a `.sha256` file (`<hex>  <name>`), lower-cased.
pub fn sha256_in(file: &str) -> Option<String> {
    let hex = file.split_whitespace().next()?.to_ascii_lowercase();
    (hex.len() == 64 && hex.bytes().all(|b| b.is_ascii_hexdigit())).then_some(hex)
}

/// Whether this runner may replace itself: one `install.sh` put in place, not the
/// Mac app's (which passes a grant file), and not turned off.
pub fn may_update(exe: &Path, grant_file: bool, off: Option<&str>) -> bool {
    if grant_file || off.is_some_and(|v| matches!(v.trim(), "off" | "0" | "false" | "no")) {
        return false;
    }
    let named = exe.file_name().is_some_and(|n| n == "context-machine");
    let in_bin = exe
        .parent()
        .and_then(|p| p.file_name())
        .is_some_and(|n| n == "bin");
    named && in_bin
}

/// This runner's own binary, with links followed.
pub fn this_exe() -> Result<PathBuf> {
    let exe = std::env::current_exe().context("find this runner's binary")?;
    Ok(std::fs::canonicalize(&exe).unwrap_or(exe))
}

fn http() -> Result<reqwest::Client> {
    reqwest::Client::builder()
        .connect_timeout(Duration::from_secs(20))
        .timeout(Duration::from_secs(10 * 60))
        .user_agent(concat!("context-machine/", env!("CARGO_PKG_VERSION")))
        .build()
        .context("build HTTP client")
}

/// Looks for a newer release and, when there is one, puts it in place of `exe`.
/// Returns the new version, or None when this one is already the newest.
pub async fn fetch_newer(exe: &Path) -> Result<Option<String>> {
    let here = version_of(env!("CARGO_PKG_VERSION"))
        .ok_or_else(|| anyhow!("this runner has no plain version"))?;
    fetch_newer_than(exe, here).await
}

async fn fetch_newer_than(exe: &Path, here: (u64, u64, u64)) -> Result<Option<String>> {
    let target = target().ok_or_else(|| anyhow!("there is no runner build for this computer"))?;
    let http = http()?;
    let releases: serde_json::Value = http
        .get(format!(
            "https://api.github.com/repos/{REPO}/releases?per_page=30"
        ))
        .header("Accept", "application/vnd.github+json")
        .send()
        .await
        .context("ask GitHub for runner releases")?
        .error_for_status()
        .context("ask GitHub for runner releases")?
        .json()
        .await
        .context("read GitHub's releases")?;
    let Some((tag, newest)) = newest(&releases) else {
        return Ok(None);
    };
    if newest <= here {
        return Ok(None);
    }
    let base = format!(
        "https://github.com/{REPO}/releases/download/{tag}/context-machine-{target}.tar.gz"
    );
    let sums = http
        .get(format!("{base}.sha256"))
        .send()
        .await
        .context("download the checksum")?
        .error_for_status()
        .context("download the checksum")?
        .text()
        .await
        .context("read the checksum")?;
    let want = sha256_in(&sums).ok_or_else(|| anyhow!("the release's checksum file is not one"))?;
    let archive = http
        .get(&base)
        .send()
        .await
        .context("download the runner")?
        .error_for_status()
        .context("download the runner")?;
    if archive.content_length().is_some_and(|n| n > MOST_BYTES) {
        bail!("the download is bigger than any runner should be");
    }
    let bytes = archive.bytes().await.context("download the runner")?;
    if bytes.len() as u64 > MOST_BYTES {
        bail!("the download is bigger than any runner should be");
    }
    let got = hex(&Sha256::digest(&bytes));
    if got != want {
        bail!("the download did not match its checksum; nothing was changed");
    }
    let version = format!("{}.{}.{}", newest.0, newest.1, newest.2);
    place(exe, &bytes).await?;
    Ok(Some(version))
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

/// Unpacks the archive beside `exe` and swaps its `context-machine` in, in one rename.
async fn place(exe: &Path, archive: &[u8]) -> Result<()> {
    let dir = exe
        .parent()
        .ok_or_else(|| anyhow!("this runner's folder is unknown"))?;
    let work = dir.join(format!(".update-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&work).context("make a folder to unpack into")?;
    let result = unpack_and_swap(exe, archive, &work).await;
    let _ = std::fs::remove_dir_all(&work);
    result
}

async fn unpack_and_swap(exe: &Path, archive: &[u8], work: &Path) -> Result<()> {
    let file = work.join("runner.tar.gz");
    std::fs::write(&file, archive).context("save the download")?;
    let out = tokio::process::Command::new("tar")
        .arg("-xzf")
        .arg(&file)
        .arg("-C")
        .arg(work)
        .arg("context-machine")
        .output()
        .await
        .context("run tar")?;
    if !out.status.success() {
        bail!("the download would not unpack");
    }
    let new = work.join("context-machine");
    let meta = std::fs::symlink_metadata(&new).context("find the new runner")?;
    if !meta.file_type().is_file() {
        bail!("the download held no runner");
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&new, std::fs::Permissions::from_mode(0o755))
            .context("make the new runner runnable")?;
    }
    // Beside the old one first, so the last step is one rename on the same disk.
    let staged = exe.with_file_name("context-machine.new");
    std::fs::rename(&new, &staged)
        .or_else(|_| std::fs::copy(&new, &staged).map(|_| ()))
        .context("put the new runner beside this one")?;
    std::fs::rename(&staged, exe).context("swap the new runner in")?;
    Ok(())
}

/// Starts the binary now at `exe` in this process's place, with the same arguments.
#[cfg(unix)]
pub fn restart(exe: &Path) -> Result<()> {
    use std::os::unix::process::CommandExt;
    let err = std::process::Command::new(exe)
        .args(std::env::args_os().skip(1))
        .exec();
    Err(anyhow!("start the new runner: {err}"))
}

#[cfg(not(unix))]
pub fn restart(_exe: &Path) -> Result<()> {
    bail!("restarting in place needs a Unix system")
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn versions_are_three_plain_numbers() {
        assert_eq!(version_of("0.2.4"), Some((0, 2, 4)));
        assert_eq!(version_of("1.10.0"), Some((1, 10, 0)));
        for bad in ["0.2", "0.2.4.1", "0.2.4-rc1", "v0.2.4", "", "0..4", "0.2.x"] {
            assert_eq!(version_of(bad), None, "{bad}");
        }
    }

    #[test]
    fn the_newest_runner_release_wins_and_others_are_ignored() {
        let releases = json!([
            { "tag_name": "v0.1.77", "draft": false, "prerelease": false },
            { "tag_name": "machine-runner-v0.2.4", "draft": false, "prerelease": false },
            { "tag_name": "machine-runner-v0.2.10", "draft": false, "prerelease": false },
            { "tag_name": "machine-runner-v0.3.0", "draft": true, "prerelease": false },
            { "tag_name": "machine-runner-v0.4.0", "draft": false, "prerelease": true },
            { "tag_name": "machine-runner-v9.9.9-evil", "draft": false, "prerelease": false },
        ]);
        assert_eq!(
            newest(&releases),
            Some(("machine-runner-v0.2.10".to_string(), (0, 2, 10)))
        );
        assert_eq!(newest(&json!([{ "tag_name": "v0.1.77" }])), None);
        assert_eq!(newest(&json!({})), None);
    }

    #[test]
    fn a_checksum_file_gives_its_hex_or_nothing() {
        let hex = "a".repeat(64);
        assert_eq!(
            sha256_in(&format!("{hex}  context-machine-x.tar.gz\n")),
            Some(hex)
        );
        assert_eq!(
            sha256_in(&format!("{}  x", "A".repeat(64))),
            Some("a".repeat(64))
        );
        assert_eq!(sha256_in("nope  x"), None);
        assert_eq!(sha256_in(""), None);
        assert_eq!(sha256_in(&"g".repeat(64)), None);
    }

    #[test]
    fn only_a_runner_install_sh_put_in_place_updates_itself() {
        let installed = Path::new("/home/u/.context-machine/bin/context-machine");
        assert!(may_update(installed, false, None));
        // The Mac app's runner: it passes a grant file, and the app updates as a whole.
        assert!(!may_update(installed, true, None));
        assert!(!may_update(
            Path::new("/Applications/Context.app/Contents/Resources/context-machine"),
            false,
            None
        ));
        assert!(!may_update(
            Path::new("/home/u/code/target/release/context-machine"),
            false,
            None
        ));
        assert!(!may_update(installed, false, Some("off")));
        assert!(!may_update(installed, false, Some(" 0 ")));
        assert!(may_update(installed, false, Some("on")));
    }

    /// Live: the newest real release lands in a temporary `bin/` (nothing is run).
    #[tokio::test]
    #[ignore]
    async fn fetch_the_newest_release_for_real() {
        let dir = tempfile::tempdir().unwrap();
        let bin = dir.path().join("bin");
        std::fs::create_dir_all(&bin).unwrap();
        let exe = bin.join("context-machine");
        std::fs::write(&exe, b"old").unwrap();
        let got = fetch_newer_than(&exe, (0, 0, 1)).await.unwrap();
        assert!(got.is_some());
        assert!(std::fs::metadata(&exe).unwrap().len() > 1_000_000);
    }

    #[tokio::test]
    async fn a_new_binary_is_swapped_in_by_one_rename() {
        let dir = tempfile::tempdir().unwrap();
        let bin = dir.path().join("bin");
        std::fs::create_dir_all(&bin).unwrap();
        let exe = bin.join("context-machine");
        std::fs::write(&exe, b"old").unwrap();
        let stage = dir.path().join("stage");
        std::fs::create_dir_all(&stage).unwrap();
        std::fs::write(stage.join("context-machine"), b"new").unwrap();
        let archive = dir.path().join("a.tar.gz");
        let made = std::process::Command::new("tar")
            .arg("-C")
            .arg(&stage)
            .arg("-czf")
            .arg(&archive)
            .arg("context-machine")
            .status()
            .unwrap();
        assert!(made.success());
        place(&exe, &std::fs::read(&archive).unwrap())
            .await
            .unwrap();
        assert_eq!(std::fs::read(&exe).unwrap(), b"new");
        let left: Vec<_> = std::fs::read_dir(&bin)
            .unwrap()
            .map(|e| e.unwrap().file_name())
            .collect();
        assert_eq!(
            left,
            vec![std::ffi::OsString::from("context-machine")],
            "nothing left beside it"
        );
        // An archive without the runner changes nothing.
        std::fs::write(stage.join("other"), b"x").unwrap();
        std::process::Command::new("tar")
            .arg("-C")
            .arg(&stage)
            .arg("-czf")
            .arg(&archive)
            .arg("other")
            .status()
            .unwrap();
        assert!(place(&exe, &std::fs::read(&archive).unwrap())
            .await
            .is_err());
        assert_eq!(std::fs::read(&exe).unwrap(), b"new");
    }
}
