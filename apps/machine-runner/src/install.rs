//! Installing a coding tool from the app (the owner, 2026-11-05: "I should be
//! able to install claude code or codex with one click").
//!
//! The owner taps Install; the workspace object sends `install` naming only the
//! tool. What happens next is fixed here and nowhere else:
//!
//! 1. Ask the npm registry which version is the maker's latest, and for this
//!    computer's own build of it (the per-platform package each maker publishes
//!    beside its CLI: `@anthropic-ai/claude-code-<platform>`,
//!    `@openai/codex@<version>-<platform>`). Its tarball must be on the registry
//!    itself, under that package's own name.
//! 2. Download it, hashing as it comes, and refuse it unless it matches the
//!    registry's published sha512 (`dist.integrity`).
//! 3. Unpack it with the system `tar` into a fresh folder, keep only the
//!    tool's own files, and point `<tools>/bin/<name>` at the binary.
//!
//! No installer script runs, no package manager is needed, and nothing outside
//! the tools folder changes. The runner looks in `<tools>/bin` before PATH
//! (`facts::tool_path`), so a broken copy elsewhere doesn't shadow a working one.

use crate::protocol::{InstallPhase, InstallState, InstallStep, RunnerMsg, Tool};
use anyhow::{anyhow, bail, Context, Result};
use base64::Engine;
use sha2::{Digest, Sha512};
use std::path::{Path, PathBuf};
use std::time::Duration;
use tokio::io::AsyncWriteExt;
use tokio::sync::mpsc;

const REGISTRY: &str = "https://registry.npmjs.org";
/// The longest an install may take, download included.
pub const INSTALL_WAIT: Duration = Duration::from_secs(20 * 60);
/// No tool's build is near this; a bigger download is refused.
const MOST_BYTES: u64 = 1024 * 1024 * 1024;

/// Where installed tools live: `$CONTEXT_MACHINE_TOOLS`, else
/// `~/.local/share/context-machine/tools`.
pub fn tools_dir() -> Option<PathBuf> {
    if let Some(dir) = std::env::var_os("CONTEXT_MACHINE_TOOLS") {
        return Some(PathBuf::from(dir));
    }
    let home = std::env::var_os("HOME")?;
    Some(PathBuf::from(home).join(".local/share/context-machine/tools"))
}

/// This computer's platform as the makers name their builds, or None where
/// neither publishes one.
pub fn platform(os: &str, arch: &str, musl: bool) -> Option<&'static str> {
    Some(match (os, arch, musl) {
        ("macos", "aarch64", _) => "darwin-arm64",
        ("macos", "x86_64", _) => "darwin-x64",
        ("linux", "x86_64", false) => "linux-x64",
        ("linux", "aarch64", false) => "linux-arm64",
        ("linux", "x86_64", true) => "linux-x64-musl",
        ("linux", "aarch64", true) => "linux-arm64-musl",
        _ => return None,
    })
}

/// This computer's platform, if either maker publishes a build for it.
pub fn platform_here() -> Option<&'static str> {
    this_platform()
}

fn this_platform() -> Option<&'static str> {
    let musl = cfg!(target_os = "linux")
        && std::fs::read_dir("/lib")
            .map(|d| {
                d.flatten()
                    .any(|e| e.file_name().to_string_lossy().starts_with("ld-musl-"))
            })
            .unwrap_or(false);
    platform(std::env::consts::OS, std::env::consts::ARCH, musl)
}

/// Where one tool's build is published: the package that names the latest
/// version, the package and version that hold this platform's build, and the
/// binary inside the unpacked tarball (with the folder kept beside it).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Source {
    pub latest_of: String,
    pub package: String,
    pub version: String,
    /// Inside `package/` in the tarball: the folder to keep, and the binary in it.
    pub keep: String,
    pub binary: String,
}

/// The source of `tool`'s build for `platform` at `version`.
pub fn source(tool: Tool, platform: &str, version: &str) -> Option<Source> {
    match tool {
        Tool::Claude => Some(Source {
            latest_of: "@anthropic-ai/claude-code".into(),
            package: format!("@anthropic-ai/claude-code-{platform}"),
            version: version.into(),
            keep: ".".into(),
            binary: "claude".into(),
        }),
        Tool::Codex => {
            // Codex's Linux builds are static (musl) whatever the system's libc.
            let triple = match platform.trim_end_matches("-musl") {
                "darwin-arm64" => "aarch64-apple-darwin",
                "darwin-x64" => "x86_64-apple-darwin",
                "linux-x64" => "x86_64-unknown-linux-musl",
                "linux-arm64" => "aarch64-unknown-linux-musl",
                _ => return None,
            };
            let platform = platform.trim_end_matches("-musl");
            Some(Source {
                latest_of: "@openai/codex".into(),
                package: "@openai/codex".into(),
                version: format!("{version}-{platform}"),
                keep: format!("vendor/{triple}"),
                binary: "bin/codex".into(),
            })
        }
    }
}

/// A version as the registry gives one: plain dotted digits, maybe a pre-release tag.
pub fn plain_version(v: &str) -> bool {
    !v.is_empty()
        && v.len() <= 64
        && v.chars().next().is_some_and(|c| c.is_ascii_digit())
        && v.chars()
            .all(|c| c.is_ascii_alphanumeric() || ".-+".contains(c))
}

fn registry_path(package: &str) -> String {
    package.replacen('/', "%2f", 1)
}

/// The tarball URL is only ever the registry's own, under the package's own name.
pub fn tarball_ok(url: &str, package: &str) -> bool {
    let bare = package.rsplit('/').next().unwrap_or(package);
    url.starts_with(&format!("{REGISTRY}/{package}/-/{bare}-"))
        && url.ends_with(".tgz")
        && !url.contains("..")
}

/// The sha512 a registry `integrity` string names.
pub fn sha512_of(integrity: &str) -> Option<Vec<u8>> {
    integrity
        .split_whitespace()
        .find_map(|i| i.strip_prefix("sha512-"))
        .and_then(|b| base64::engine::general_purpose::STANDARD.decode(b).ok())
        .filter(|d| d.len() == 64)
}

fn http() -> Result<reqwest::Client> {
    reqwest::Client::builder()
        .connect_timeout(Duration::from_secs(20))
        .user_agent(concat!("context-machine/", env!("CARGO_PKG_VERSION")))
        // The registry serves tarballs from itself; nothing should send us elsewhere.
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .context("build HTTP client")
}

async fn json(http: &reqwest::Client, url: &str) -> Result<serde_json::Value> {
    let r = http
        .get(url)
        .header("Accept", "application/json")
        .timeout(Duration::from_secs(30))
        .send()
        .await
        .context("reach the npm registry")?;
    if !r.status().is_success() {
        bail!("the npm registry answered {}", r.status());
    }
    r.json().await.context("read the npm registry's answer")
}

struct Report {
    id: String,
    tool: Tool,
    out: mpsc::Sender<RunnerMsg>,
}

impl Report {
    async fn send(&self, state: InstallStep, step: Option<InstallPhase>, percent: Option<u8>) {
        let _ = self
            .out
            .send(RunnerMsg::InstallState(InstallState {
                install_id: self.id.clone(),
                tool: self.tool,
                state,
                step,
                percent,
                version: None,
                error: None,
            }))
            .await;
    }
}

/// Runs one install to its end, sending `working` steps, then `done` or `failed`.
/// The caller sends a fresh status after. Returns the installed binary.
pub async fn run(id: String, tool: Tool, out: mpsc::Sender<RunnerMsg>) -> Option<PathBuf> {
    let report = Report { id, tool, out };
    let done = tokio::time::timeout(INSTALL_WAIT, install(&report)).await;
    let result = match done {
        Ok(r) => r,
        Err(_) => Err(anyhow!("The install took too long. Try again.")),
    };
    let msg = match &result {
        Ok((_, version)) => InstallState {
            install_id: report.id.clone(),
            tool,
            state: InstallStep::Done,
            step: None,
            percent: None,
            version: Some(version.clone()),
            error: None,
        },
        Err(e) => InstallState {
            install_id: report.id.clone(),
            tool,
            state: InstallStep::Failed,
            step: None,
            percent: None,
            version: None,
            error: Some(format!("{e:#}").chars().take(300).collect()),
        },
    };
    let _ = report.out.send(RunnerMsg::InstallState(msg)).await;
    result.ok().map(|(path, _)| path)
}

async fn install(report: &Report) -> Result<(PathBuf, String)> {
    let tool = report.tool;
    let root =
        tools_dir().ok_or_else(|| anyhow!("This computer has no home folder to install into."))?;
    let platform = this_platform()
        .ok_or_else(|| anyhow!("{} has no build for this computer.", label(tool)))?;
    report
        .send(InstallStep::Working, Some(InstallPhase::Finding), None)
        .await;
    let http = http()?;

    // 1. The latest version, and this platform's build of it.
    let probe = source(tool, platform, "0")
        .ok_or_else(|| anyhow!("{} has no build for this computer.", label(tool)))?;
    let latest = json(
        &http,
        &format!("{REGISTRY}/{}/latest", registry_path(&probe.latest_of)),
    )
    .await?;
    let version = latest["version"].as_str().unwrap_or("").to_string();
    if !plain_version(&version) {
        bail!("The npm registry gave no usable version.");
    }
    let src = source(tool, platform, &version).expect("same tool and platform");
    let meta = json(
        &http,
        &format!("{REGISTRY}/{}/{}", registry_path(&src.package), src.version),
    )
    .await?;
    let tarball = meta["dist"]["tarball"].as_str().unwrap_or("");
    if !tarball_ok(tarball, &src.package) {
        bail!("The npm registry pointed somewhere unexpected; nothing was installed.");
    }
    let want = sha512_of(meta["dist"]["integrity"].as_str().unwrap_or(""))
        .ok_or_else(|| anyhow!("The npm registry gave no checksum; nothing was installed."))?;

    // 2. Download, hashing as it comes.
    std::fs::create_dir_all(&root).context("make the tools folder")?;
    let work = root.join(format!(".install-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&work).context("make a folder to install into")?;
    let result = fetch_and_place(report, &http, tarball, &want, &work, &root, &src).await;
    let _ = std::fs::remove_dir_all(&work);
    let binary = result?;
    Ok((binary, version))
}

async fn fetch_and_place(
    report: &Report,
    http: &reqwest::Client,
    tarball: &str,
    want: &[u8],
    work: &Path,
    root: &Path,
    src: &Source,
) -> Result<PathBuf> {
    let file_path = work.join("build.tgz");
    let mut r = http
        .get(tarball)
        .timeout(INSTALL_WAIT)
        .send()
        .await
        .context("start the download")?;
    if !r.status().is_success() {
        bail!("The download answered {}", r.status());
    }
    let total = r.content_length().filter(|n| *n > 0);
    if total.is_some_and(|n| n > MOST_BYTES) {
        bail!("The download is bigger than any build should be; nothing was installed.");
    }
    let mut file = tokio::fs::File::create(&file_path)
        .await
        .context("save the download")?;
    let mut hash = Sha512::new();
    let mut got: u64 = 0;
    let mut told: Option<u8> = None;
    report
        .send(
            InstallStep::Working,
            Some(InstallPhase::Downloading),
            Some(0),
        )
        .await;
    while let Some(chunk) = r.chunk().await.context("download the build")? {
        got += chunk.len() as u64;
        if got > MOST_BYTES {
            bail!("The download is bigger than any build should be; nothing was installed.");
        }
        hash.update(&chunk);
        file.write_all(&chunk).await.context("save the download")?;
        if let Some(total) = total {
            let pct = ((got * 100) / total).min(100) as u8;
            if told.is_none_or(|t| pct >= t + 5) {
                told = Some(pct);
                report
                    .send(
                        InstallStep::Working,
                        Some(InstallPhase::Downloading),
                        Some(pct),
                    )
                    .await;
            }
        }
    }
    file.flush().await.context("save the download")?;
    drop(file);

    report
        .send(InstallStep::Working, Some(InstallPhase::Checking), None)
        .await;
    if hash.finalize().as_slice() != want {
        bail!("The download didn't match the published checksum; nothing was installed.");
    }

    // 3. Unpack, keep the tool's own files, point bin/<name> at it.
    report
        .send(InstallStep::Working, Some(InstallPhase::Unpacking), None)
        .await;
    let unpacked = work.join("unpacked");
    std::fs::create_dir_all(&unpacked).context("make a folder to unpack into")?;
    let tar = crate::facts::which("tar")
        .or_else(|| Some(PathBuf::from("/usr/bin/tar")).filter(|p| p.exists()))
        .ok_or_else(|| anyhow!("This computer has no tar to unpack the build."))?;
    let status = tokio::process::Command::new(tar)
        .arg("-xzf")
        .arg(&file_path)
        .arg("-C")
        .arg(&unpacked)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .kill_on_drop(true)
        .status()
        .await
        .context("unpack the build")?;
    if !status.success() {
        bail!("Couldn't unpack the build.");
    }
    place(&unpacked.join("package"), root, src)
}

/// Moves the kept folder into `<root>/<tool>/<version>` and points
/// `<root>/bin/<name>` at its binary. Older versions are removed.
pub fn place(package: &Path, root: &Path, src: &Source) -> Result<PathBuf> {
    let keep = package.join(&src.keep);
    let keep = keep.canonicalize().context("find the tool in the build")?;
    let package = package.canonicalize().context("find the build")?;
    if !keep.starts_with(&package) {
        bail!("The build's layout was unexpected; nothing was installed.");
    }
    let binary_in = keep.join(&src.binary);
    let meta = std::fs::symlink_metadata(&binary_in).context("find the tool in the build")?;
    if !meta.is_file() {
        bail!("The build's layout was unexpected; nothing was installed.");
    }
    let name = src
        .binary
        .rsplit('/')
        .next()
        .unwrap_or(&src.binary)
        .to_string();
    let tool_dir = root.join(&name);
    std::fs::create_dir_all(&tool_dir).context("make the tool's folder")?;
    let dest = tool_dir.join(&src.version);
    if dest.exists() {
        std::fs::remove_dir_all(&dest).context("replace the old copy")?;
    }
    std::fs::rename(&keep, &dest).context("move the tool into place")?;
    let binary = dest.join(&src.binary);
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let mut p = std::fs::metadata(&binary)?.permissions();
        p.set_mode(p.mode() | 0o755);
        std::fs::set_permissions(&binary, p)?;
    }
    let bin = root.join("bin");
    std::fs::create_dir_all(&bin).context("make the tools' bin folder")?;
    let link = bin.join(&name);
    let tmp = bin.join(format!(".{name}-{}", uuid::Uuid::new_v4()));
    #[cfg(unix)]
    std::os::unix::fs::symlink(&binary, &tmp).context("link the tool")?;
    #[cfg(not(unix))]
    std::fs::copy(&binary, &tmp).context("link the tool")?;
    std::fs::rename(&tmp, &link).context("link the tool")?;
    for old in std::fs::read_dir(&tool_dir).into_iter().flatten().flatten() {
        if old.path() != dest {
            let _ = std::fs::remove_dir_all(old.path());
        }
    }
    Ok(binary)
}

fn label(tool: Tool) -> &'static str {
    match tool {
        Tool::Claude => "Claude Code",
        Tool::Codex => "Codex",
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn each_computer_gets_its_own_build() {
        assert_eq!(platform("macos", "aarch64", false), Some("darwin-arm64"));
        assert_eq!(platform("macos", "x86_64", false), Some("darwin-x64"));
        assert_eq!(platform("linux", "x86_64", false), Some("linux-x64"));
        assert_eq!(platform("linux", "aarch64", true), Some("linux-arm64-musl"));
        assert_eq!(platform("windows", "x86_64", false), None);
        let claude = source(Tool::Claude, "darwin-arm64", "2.1.318").unwrap();
        assert_eq!(claude.package, "@anthropic-ai/claude-code-darwin-arm64");
        assert_eq!(claude.version, "2.1.318");
        let codex = source(Tool::Codex, "linux-x64-musl", "0.166.0").unwrap();
        assert_eq!(codex.package, "@openai/codex");
        assert_eq!(codex.version, "0.166.0-linux-x64");
        assert_eq!(codex.keep, "vendor/x86_64-unknown-linux-musl");
        assert_eq!(codex.binary, "bin/codex");
    }

    #[test]
    fn only_the_registrys_own_tarball_for_that_package() {
        assert!(tarball_ok(
            "https://registry.npmjs.org/@openai/codex/-/codex-0.166.0-darwin-arm64.tgz",
            "@openai/codex"
        ));
        assert!(tarball_ok(
            "https://registry.npmjs.org/@anthropic-ai/claude-code-darwin-arm64/-/claude-code-darwin-arm64-2.1.318.tgz",
            "@anthropic-ai/claude-code-darwin-arm64"
        ));
        assert!(!tarball_ok(
            "https://evil.example/@openai/codex/-/codex-1.tgz",
            "@openai/codex"
        ));
        assert!(!tarball_ok(
            "https://registry.npmjs.org/@evil/codex/-/codex-1.tgz",
            "@openai/codex"
        ));
        assert!(!tarball_ok(
            "https://registry.npmjs.org.evil.example/@openai/codex/-/codex-1.tgz",
            "@openai/codex"
        ));
        assert!(!tarball_ok(
            "https://registry.npmjs.org/@openai/codex/-/codex-../../x.tgz",
            "@openai/codex"
        ));
        assert!(!tarball_ok(
            "http://registry.npmjs.org/@openai/codex/-/codex-1.tgz",
            "@openai/codex"
        ));
    }

    #[test]
    fn versions_and_checksums_are_read_strictly() {
        assert!(plain_version("0.166.0"));
        assert!(plain_version("2.1.318-beta.1"));
        assert!(!plain_version(""));
        assert!(!plain_version("../1"));
        assert!(!plain_version("1 2"));
        let digest = Sha512::digest(b"build");
        let integrity = format!(
            "sha512-{}",
            base64::engine::general_purpose::STANDARD.encode(digest)
        );
        assert_eq!(sha512_of(&integrity).as_deref(), Some(digest.as_slice()));
        assert_eq!(sha512_of("sha1-abc"), None);
        assert_eq!(sha512_of("sha512-short"), None);
    }

    #[cfg(unix)]
    #[test]
    fn a_build_is_placed_and_linked_and_the_old_one_removed() {
        let base = std::env::temp_dir().join(format!("install-{}", uuid::Uuid::new_v4()));
        let root = base.join("tools");
        let src_for = |v: &str| Source {
            latest_of: "@openai/codex".into(),
            package: "@openai/codex".into(),
            version: format!("{v}-linux-x64"),
            keep: "vendor/x86_64-unknown-linux-musl".into(),
            binary: "bin/codex".into(),
        };
        for v in ["1.0.0", "1.1.0"] {
            let pkg = base.join(format!("unpacked-{v}/package"));
            let dir = pkg.join("vendor/x86_64-unknown-linux-musl/bin");
            std::fs::create_dir_all(&dir).unwrap();
            std::fs::write(dir.join("codex"), format!("#!/bin/sh\necho {v}\n")).unwrap();
            std::fs::create_dir_all(pkg.join("vendor/x86_64-unknown-linux-musl/codex-resources"))
                .unwrap();
            let binary = place(&pkg, &root, &src_for(v)).unwrap();
            assert!(binary.ends_with(format!("codex/{v}-linux-x64/bin/codex")));
            assert!(binary
                .parent()
                .unwrap()
                .parent()
                .unwrap()
                .join("codex-resources")
                .is_dir());
        }
        let link = root.join("bin/codex");
        let target = std::fs::read_link(&link).unwrap();
        assert!(
            target.ends_with("codex/1.1.0-linux-x64/bin/codex"),
            "{target:?}"
        );
        let kept: Vec<_> = std::fs::read_dir(root.join("codex"))
            .unwrap()
            .flatten()
            .map(|e| e.file_name())
            .collect();
        assert_eq!(kept, vec![std::ffi::OsString::from("1.1.0-linux-x64")]);
        let _ = std::fs::remove_dir_all(&base);
    }

    #[cfg(unix)]
    #[test]
    fn a_build_whose_binary_is_a_link_out_is_refused() {
        let base = std::env::temp_dir().join(format!("install-{}", uuid::Uuid::new_v4()));
        let pkg = base.join("package");
        std::fs::create_dir_all(&pkg).unwrap();
        std::os::unix::fs::symlink("/bin/sh", pkg.join("claude")).unwrap();
        let src = Source {
            latest_of: "@anthropic-ai/claude-code".into(),
            package: "@anthropic-ai/claude-code-linux-x64".into(),
            version: "1.0.0".into(),
            keep: ".".into(),
            binary: "claude".into(),
        };
        assert!(place(&pkg, &base.join("tools"), &src).is_err());
        assert!(!base.join("tools/bin/claude").exists());
        let _ = std::fs::remove_dir_all(&base);
    }

    /// The real thing, against the live registry (about 170 MB). Run by hand:
    /// `CONTEXT_MACHINE_TOOLS=/tmp/t cargo test install_codex_for_real -- --ignored`.
    #[tokio::test]
    #[ignore]
    async fn install_codex_for_real() {
        let (tx, mut rx) = mpsc::channel(64);
        let binary = run("in_live".into(), Tool::Codex, tx).await;
        let mut last = None;
        while let Ok(m) = rx.try_recv() {
            last = Some(m);
        }
        let binary = binary.unwrap_or_else(|| panic!("{last:?}"));
        assert!(binary.is_file(), "{binary:?}");
        assert_eq!(
            crate::facts::tool_path("codex").as_deref(),
            Some(binary.as_path())
        );
    }
}
