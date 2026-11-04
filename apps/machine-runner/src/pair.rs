//! Pairing with a short code, like a TV app or `codex login --device-auth`.
//!
//! The runner sends its name, OS and public key and gets a code. The person
//! opens the link signed in, compares the code and taps Approve; the control
//! plane then issues this machine its own grant, bound to that public key.
//! The private key never leaves the machine.

use crate::state::{Machine, State};
use anyhow::{bail, Context, Result};
use serde::{Deserialize, Serialize};
use std::time::Duration;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct PairRequest<'a> {
    name: &'a str,
    os: &'a str,
    public_key: &'a str,
    facts: &'a crate::facts::Facts,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PairStart {
    pub code: String,
    pub poll_token: String,
    pub approve_url: String,
    #[serde(default = "default_interval")]
    pub interval_seconds: u64,
}

fn default_interval() -> u64 {
    3
}

#[derive(Deserialize, Debug, PartialEq)]
#[serde(tag = "state", rename_all = "camelCase")]
pub enum PairPoll {
    Pending,
    Approved {
        #[serde(rename = "machineId")]
        machine_id: String,
        grant: String,
    },
    Declined,
    Expired,
}

pub async fn pair(state: &State, endpoint: &str, name: &str) -> Result<()> {
    let base = endpoint.trim_end_matches('/');
    if !base.starts_with("https://")
        && !base.starts_with("http://127.0.0.1:")
        && !base.starts_with("http://localhost:")
    {
        bail!("the endpoint must be https");
    }
    let facts = crate::facts::gather().await;
    let public_key = state.public_key()?;
    let http = reqwest::Client::builder()
        .timeout(Duration::from_secs(30))
        .user_agent(concat!("context-machine/", env!("CARGO_PKG_VERSION")))
        .build()?;
    let start: PairStart = http
        .post(format!("{base}/machines/pair"))
        .json(&PairRequest {
            name,
            os: &facts.os,
            public_key: &public_key,
            facts: &facts,
        })
        .send()
        .await?
        .error_for_status()
        .context("the gateway refused to start pairing")?
        .json()
        .await?;
    println!("Approve this machine at {}", start.approve_url);
    println!("and check the code there is {}", start.code);
    let interval = Duration::from_secs(start.interval_seconds.clamp(1, 30));
    let deadline = tokio::time::Instant::now() + Duration::from_secs(15 * 60);
    while tokio::time::Instant::now() < deadline {
        tokio::time::sleep(interval).await;
        let poll: PairPoll = match http
            .post(format!("{base}/machines/pair/poll"))
            .json(&serde_json::json!({ "pollToken": start.poll_token }))
            .send()
            .await
        {
            Ok(r) if r.status().is_success() => r.json().await.unwrap_or(PairPoll::Pending),
            _ => continue,
        };
        match poll {
            PairPoll::Pending => continue,
            PairPoll::Approved { machine_id, grant } => {
                state.save_grant(&grant)?;
                state.save_machine(&Machine {
                    machine_id,
                    endpoint: base.to_string(),
                    name: name.to_string(),
                })?;
                println!("Paired. Run `context-machine service install` to keep it running, or `context-machine run`.");
                return Ok(());
            }
            PairPoll::Declined => bail!("the pairing was declined"),
            PairPoll::Expired => bail!("the code expired; run `context-machine pair` again"),
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

    #[test]
    fn poll_answers_parse() {
        assert_eq!(
            serde_json::from_str::<PairPoll>(r#"{"state":"pending"}"#).unwrap(),
            PairPoll::Pending
        );
        assert_eq!(
            serde_json::from_str::<PairPoll>(
                r#"{"state":"approved","machineId":"m1","grant":"g"}"#
            )
            .unwrap(),
            PairPoll::Approved {
                machine_id: "m1".into(),
                grant: "g".into()
            }
        );
    }
}
