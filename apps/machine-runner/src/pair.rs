//! Pairing with a short code, like a TV app or `codex login --device-auth`.
//!
//! The runner sends its name, facts and public key and gets a code. The
//! person opens the link signed in, compares the code and taps Approve; the
//! control plane then issues this machine its own grant, bound to that public
//! key. Every poll is signed, so only the machine that started a pairing can
//! collect its grant. The private key never leaves the machine.

use crate::protocol::{
    pair_signing_text, valid_id, PairPoll, PairStart, PairStarted, PairState, PairStatus,
};
use crate::state::{Machine, State};
use anyhow::{bail, Context, Result};
use std::time::Duration;

/// Checks a pairing's start answer before anything from it is shown or used.
fn check_started(s: &PairStarted) -> Result<()> {
    if !valid_id(&s.pairing_id) {
        bail!("the gateway's pairing id is malformed");
    }
    if !s.approve_url.starts_with("https://")
        && !s.approve_url.starts_with("http://127.0.0.1:")
        && !s.approve_url.starts_with("http://localhost:")
    {
        bail!("the approve link is not https");
    }
    Ok(())
}

/// The machine to save from an approved pairing, or why it cannot be saved.
pub fn approved(status: &PairStatus, endpoint: &str, name: &str) -> Result<(Machine, String)> {
    let machine_id = status
        .machine_id
        .clone()
        .filter(|m| valid_id(m))
        .context("the approval has no machine id")?;
    let grant = status
        .grant
        .clone()
        .filter(|g| g.len() >= 16)
        .context("the approval has no grant")?;
    let socket_url = match status.socket_url.clone() {
        Some(u) if u.starts_with("wss://") => u,
        Some(_) => bail!("the socket address is not wss"),
        None => crate::conn::socket_url(endpoint)?,
    };
    Ok((
        Machine {
            machine_id,
            endpoint: endpoint.to_string(),
            name: name.to_string(),
            socket_url,
        },
        grant,
    ))
}

pub async fn pair(state: &State, endpoint: &str, name: &str) -> Result<()> {
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
        .await
        .context("the gateway's pairing answer is not one the runner knows")?;
    check_started(&start)?;
    println!("Approve this machine at {}", start.approve_url);
    println!("and check the code there is {}", start.code);
    let interval = Duration::from_millis(start.poll_ms.clamp(1000, 30_000));
    let deadline = tokio::time::Instant::now() + Duration::from_secs(30 * 60);
    let poll = PairPoll {
        pairing_id: start.pairing_id.clone(),
        signature: state.sign(&pair_signing_text(&start.pairing_id))?,
    };
    while tokio::time::Instant::now() < deadline {
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
                match status.workspace {
                    Some(w) => println!("Paired with @{w}."),
                    None => println!("Paired."),
                }
                println!("Run `context-machine service install` to keep it running, or `context-machine run`.");
                return Ok(());
            }
            PairState::Declined => bail!("the pairing was declined"),
            PairState::Expired => bail!("the code expired; run `context-machine pair` again"),
        }
    }
    bail!("the code expired; run `context-machine pair` again")
}

/// A default name: the host name, without a domain.
pub fn default_name() -> String {
    let raw = std::process::Command::new("hostname")
        .output()
        .ok()
        .and_then(|o| String::from_utf8(o.stdout).ok())
        .unwrap_or_default();
    let short = raw.trim().split('.').next().unwrap_or("").to_string();
    if short.is_empty() {
        "my computer".into()
    } else {
        short
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn status(json: &str) -> PairStatus {
        serde_json::from_str(json).unwrap()
    }

    #[test]
    fn an_approval_saves_its_socket_address() {
        let s = status(
            r#"{"status":"approved","machineId":"m_1","grant":"g-0123456789abcdef","socketUrl":"wss://example.test/machines/socket"}"#,
        );
        let (m, g) = approved(&s, "https://example.test", "vm").unwrap();
        assert_eq!(
            (m.machine_id.as_str(), m.socket_url.as_str(), g.as_str()),
            (
                "m_1",
                "wss://example.test/machines/socket",
                "g-0123456789abcdef"
            )
        );
    }

    #[test]
    fn an_approval_without_a_socket_address_uses_the_endpoint() {
        let s = status(r#"{"status":"approved","machineId":"m_1","grant":"g-0123456789abcdef"}"#);
        assert_eq!(
            approved(&s, "https://example.test", "vm")
                .unwrap()
                .0
                .socket_url,
            "wss://example.test/machines/socket"
        );
    }

    #[test]
    fn a_bad_approval_is_refused() {
        // A plain-text socket, a malformed id and a missing grant are all refused.
        assert!(approved(&status(r#"{"status":"approved","machineId":"m_1","grant":"g-0123456789abcdef","socketUrl":"ws://evil.test"}"#), "https://e.test", "vm").is_err());
        assert!(approved(
            &status(r#"{"status":"approved","machineId":"m/1","grant":"g-0123456789abcdef"}"#),
            "https://e.test",
            "vm"
        )
        .is_err());
        assert!(approved(
            &status(r#"{"status":"approved","machineId":"m_1"}"#),
            "https://e.test",
            "vm"
        )
        .is_err());
    }

    #[test]
    fn a_start_answer_is_checked() {
        let ok = PairStarted {
            pairing_id: "p_1".into(),
            code: "ABCD".into(),
            approve_url: "https://e.test/a".into(),
            expires_at: 1,
            poll_ms: 2000,
        };
        assert!(check_started(&ok).is_ok());
        assert!(check_started(&PairStarted {
            approve_url: "http://evil.test".into(),
            ..ok.clone()
        })
        .is_err());
        assert!(check_started(&PairStarted {
            pairing_id: "../x".into(),
            ..ok
        })
        .is_err());
    }
}
