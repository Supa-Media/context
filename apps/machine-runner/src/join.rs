//! A session's computer joining Context as a mail-only device, and leaving.
//!
//! A cloud VM lives as long as its Claude Code session. At session start the
//! repository's hook runs `context-machine hook session-start`, which starts
//! this module's daemon in the background: it opens a pairing, writes the
//! code where the hook can read it, and waits. The session approves the code
//! from the Context connection it already has (the `pair_device` action), the
//! daemon collects its own grant with its own key, as `pair` does, and stays
//! connected so mail reaches the device at once. At session end the hook gives
//! the grant back (`/machines/leave`) and the daemon stops.
//!
//! Nothing here holds a secret beyond what `pair` already keeps: the grant
//! and the key are the same 0600 files. The pairing code is not a secret
//! (it is shown on screen in the ordinary flow) and is only good for ten
//! minutes, for an approval by a signed-in member.

use crate::pair::{approved, check_started};
use crate::protocol::{pair_signing_text, PairPoll, PairStart, PairStarted, PairState, PairStatus};
use crate::state::State;
use anyhow::{bail, Context, Result};
use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use std::time::Duration;

/// A pairing this daemon opened and is waiting on.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Pending {
    pub code: String,
    pub approve_url: String,
    pub expires_at: u64,
}

/// Where a device stands for the hooks.
#[derive(Debug, Clone, PartialEq)]
pub enum Joined {
    /// Paired; the daemon is (re)started if it had stopped.
    Paired { machine_id: String },
    /// Waiting for the session to approve this code.
    Pairing { code: String },
}

fn pid_path(state: &State) -> PathBuf {
    state.dir.join("daemon.pid")
}

fn pending_path(state: &State) -> PathBuf {
    state.dir.join("joining.json")
}

/// Written when a pairing ends without a device (expired, declined): the hooks stop showing new codes on every
/// prompt, as a session with no Context connection could never approve one. A new session tries again.
fn ended_path(state: &State) -> PathBuf {
    state.dir.join("joining.ended")
}

/// Lets the next `ensure` pair again after one that ran out (`SessionStart`).
pub fn allow_retry(state: &State) {
    let _ = std::fs::remove_file(ended_path(state));
}

pub fn pending(state: &State) -> Option<Pending> {
    let raw = std::fs::read(pending_path(state)).ok()?;
    let p: Pending = serde_json::from_slice(&raw).ok()?;
    (!p.code.is_empty() && p.expires_at > crate::machine::now_ms()).then_some(p)
}

/// Whether a process holds `pid` and is this program.
fn alive(pid: i32) -> bool {
    if pid <= 0 {
        return false;
    }
    #[cfg(unix)]
    {
        // SAFETY: signal 0 only checks that the process exists and may be signalled.
        if unsafe { libc::kill(pid, 0) } != 0 {
            return false;
        }
        // On Linux, make sure a reused pid is still this runner.
        match std::fs::read(format!("/proc/{pid}/cmdline")) {
            Ok(cmd) => String::from_utf8_lossy(&cmd).contains("context-machine"),
            Err(_) => true,
        }
    }
    #[cfg(not(unix))]
    false
}

pub fn daemon_pid(state: &State) -> Option<i32> {
    let pid: i32 = std::fs::read_to_string(pid_path(state))
        .ok()?
        .trim()
        .parse()
        .ok()?;
    alive(pid).then_some(pid)
}

/// Starts the daemon detached from the hook: its own process group, no terminal, output to `daemon.log`.
pub fn spawn_daemon(state: &State, endpoint: &str, name: &str) -> Result<()> {
    let exe = std::env::current_exe()?;
    let log = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(state.dir.join("daemon.log"))?;
    let mut cmd = std::process::Command::new(exe);
    cmd.arg("--dir")
        .arg(&state.dir)
        .args(["join", "--daemon", "--endpoint", endpoint, "--name", name])
        .stdin(std::process::Stdio::null())
        .stdout(log.try_clone()?)
        .stderr(log);
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        // Its own group: the hook's group is ended when the hook returns.
        cmd.process_group(0);
    }
    cmd.spawn()
        .context("cannot start the device in the background")?;
    Ok(())
}

/// Makes sure this computer is a device or on its way: the daemon is running, and either it is paired or it shows a code.
pub async fn ensure(state: &State, endpoint: &str, name: &str) -> Result<Joined> {
    let paired = state.grant(None).is_ok() && !state.machine().machine_id.is_empty();
    if daemon_pid(state).is_none() {
        if !paired {
            if ended_path(state).exists() {
                bail!("the last pairing ended without approval; a new session tries again");
            }
            let _ = std::fs::remove_file(pending_path(state));
        }
        spawn_daemon(state, endpoint, name)?;
    }
    if paired {
        return Ok(Joined::Paired {
            machine_id: state.machine().machine_id,
        });
    }
    // The daemon writes its code within a request's time; wait for it.
    let deadline = tokio::time::Instant::now() + Duration::from_secs(20);
    loop {
        if let Some(p) = pending(state) {
            return Ok(Joined::Pairing { code: p.code });
        }
        if state.grant(None).is_ok() && !state.machine().machine_id.is_empty() {
            return Ok(Joined::Paired {
                machine_id: state.machine().machine_id,
            });
        }
        if tokio::time::Instant::now() > deadline {
            bail!(
                "the device did not get a pairing code; see {}",
                state.dir.join("daemon.log").display()
            );
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
}

/// The daemon: pair (when there is no grant yet) by a code the session approves, then stay connected.
pub async fn daemon(state: State, endpoint: &str, name: &str) -> Result<()> {
    crate::state::write_private(&pid_path(&state), std::process::id().to_string().as_bytes())?;
    let _gone = PidFile(pid_path(&state));
    if state.grant(None).is_err() || state.machine().machine_id.is_empty() {
        if let Err(e) = pair_by_session(&state, endpoint, name).await {
            let _ = crate::state::write_private(&ended_path(&state), format!("{e:#}").as_bytes());
            return Err(e);
        }
    }
    crate::run(
        state,
        &crate::RunOpts {
            no_keep_awake: true,
            ..Default::default()
        },
    )
    .await
}

/// Removes the pid file when the daemon ends, however it ends.
struct PidFile(PathBuf);

impl Drop for PidFile {
    fn drop(&mut self) {
        let _ = std::fs::remove_file(&self.0);
    }
}

async fn pair_by_session(state: &State, endpoint: &str, name: &str) -> Result<()> {
    let base = endpoint.trim_end_matches('/');
    if !crate::rules::endpoint_ok(base) {
        bail!("the endpoint must be https");
    }
    let mut facts = crate::facts::gather().await;
    facts.repos = None;
    let http = reqwest::Client::builder()
        .timeout(Duration::from_secs(30))
        .user_agent(concat!("context-machine/", env!("CARGO_PKG_VERSION")))
        .build()?;
    let start: PairStarted = http
        .post(format!("{base}/machines/pair"))
        .json(&PairStart {
            public_key: state.public_key()?,
            name: name.to_string(),
            facts,
        })
        .send()
        .await?
        .error_for_status()
        .context("the gateway refused to start pairing")?
        .json()
        .await?;
    check_started(&start)?;
    crate::state::write_private(
        &pending_path(state),
        &serde_json::to_vec(&Pending {
            code: start.code.clone(),
            approve_url: start.approve_url.clone(),
            expires_at: start.expires_at,
        })?,
    )?;
    let poll = PairPoll {
        pairing_id: start.pairing_id.clone(),
        signature: state.sign(&pair_signing_text(&start.pairing_id))?,
    };
    // Faster than `pair`: a session is waiting on it, and it lives for minutes.
    let interval = Duration::from_millis(start.poll_ms.clamp(500, 3000).min(1000));
    let deadline = tokio::time::Instant::now() + Duration::from_secs(10 * 60);
    let ended = loop {
        if tokio::time::Instant::now() > deadline {
            break Err(anyhow::anyhow!(
                "the code expired before the session approved it"
            ));
        }
        tokio::time::sleep(interval).await;
        let status: PairStatus = match http
            .post(format!("{base}/machines/pair/poll"))
            .json(&poll)
            .send()
            .await
        {
            Ok(r) if r.status().is_success() => match r.json().await {
                Ok(s) => s,
                Err(_) => continue,
            },
            _ => continue,
        };
        match status.status {
            PairState::Waiting => continue,
            PairState::Approved => {
                let (machine, grant) = approved(&status, base, name)?;
                state.save_grant(&grant)?;
                state.save_machine(&machine)?;
                break Ok(());
            }
            PairState::Declined => break Err(anyhow::anyhow!("the pairing was declined")),
            PairState::Expired => break Err(anyhow::anyhow!("the code expired")),
        }
    };
    let _ = std::fs::remove_file(pending_path(state));
    ended
}

/// The device leaving: its grant given back, the daemon stopped, and everything of it removed from this computer.
pub async fn leave(state: &State, endpoint: &str) -> Result<()> {
    if let Ok(grant) = state.grant(None) {
        let base = endpoint.trim_end_matches('/');
        if crate::rules::endpoint_ok(base) {
            let http = reqwest::Client::builder()
                .timeout(Duration::from_secs(10))
                .user_agent(concat!("context-machine/", env!("CARGO_PKG_VERSION")))
                .build()?;
            // Best effort: a grant that is not given back still ends with the device's time or its connection.
            let _ = http
                .post(format!("{base}/machines/leave"))
                .bearer_auth(grant)
                .send()
                .await;
        }
    }
    if let Some(pid) = daemon_pid(state) {
        #[cfg(unix)]
        // SAFETY: a plain SIGTERM to the daemon this folder's pid file names, checked alive above.
        unsafe {
            libc::kill(pid, libc::SIGTERM);
        }
    }
    for name in ["daemon.pid", "joining.json", "joining.ended"] {
        let _ = std::fs::remove_file(state.dir.join(name));
    }
    crate::mailbox::clear(state);
    state.forget()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn an_expired_or_empty_pending_code_is_not_offered() {
        let d = tempfile::tempdir().unwrap();
        let s = State::open(Some(d.path().to_path_buf())).unwrap();
        assert!(pending(&s).is_none());
        let write = |p: &Pending| {
            crate::state::write_private(&pending_path(&s), &serde_json::to_vec(p).unwrap()).unwrap()
        };
        write(&Pending {
            code: "ABC-DEF".into(),
            approve_url: "https://e.test".into(),
            expires_at: 1,
        });
        assert!(pending(&s).is_none(), "expired");
        write(&Pending {
            code: "ABC-DEF".into(),
            approve_url: "https://e.test".into(),
            expires_at: u64::MAX,
        });
        assert_eq!(pending(&s).unwrap().code, "ABC-DEF");
    }

    #[tokio::test]
    async fn a_pairing_that_ended_is_not_retried_until_a_new_session_allows_it() {
        let d = tempfile::tempdir().unwrap();
        let s = State::open(Some(d.path().to_path_buf())).unwrap();
        crate::state::write_private(&ended_path(&s), b"the code expired").unwrap();
        let refused = ensure(&s, "https://e.test", "vm").await.unwrap_err();
        assert!(refused.to_string().contains("new session"), "{refused}");
        assert!(daemon_pid(&s).is_none(), "no daemon is started for it");
        allow_retry(&s);
        assert!(!ended_path(&s).exists());
    }

    #[test]
    fn a_pid_file_naming_no_live_runner_is_not_a_daemon() {
        let d = tempfile::tempdir().unwrap();
        let s = State::open(Some(d.path().to_path_buf())).unwrap();
        assert!(daemon_pid(&s).is_none());
        crate::state::write_private(&pid_path(&s), b"999999999").unwrap();
        assert!(daemon_pid(&s).is_none());
    }
}
