//! The one outbound socket to the workspace object.
//!
//! The runner only dials out: nothing listens on the machine, and a laptop
//! behind any router works. Every connect proves the machine holds its key by
//! signing the gateway's fresh challenge, so a copied grant without the key is
//! useless. When the socket drops, running parts carry on and the runner dials
//! again with backoff.

use crate::machine::{Machine, Stop};
use crate::protocol::{GoodbyeReason, RunnerMsg, ServerMsg, PROTOCOL_VERSION};
use anyhow::{bail, Context, Result};
use futures_util::{SinkExt, StreamExt};
use std::time::Duration;
use tokio::sync::mpsc;
use tokio_tungstenite::tungstenite::client::IntoClientRequest;
use tokio_tungstenite::tungstenite::Message;

pub const SOCKET_PATH: &str = "/machines/socket";
const CHALLENGE_WAIT: Duration = Duration::from_secs(15);
const SILENCE_LIMIT: Duration = Duration::from_secs(90);
const PING_EVERY: Duration = Duration::from_secs(30);
const STATUS_EVERY: Duration = Duration::from_secs(60);

/// `https://host` becomes `wss://host/machines/socket`.
pub fn socket_url(endpoint: &str) -> Result<String> {
    let base = endpoint.trim_end_matches('/');
    let ws = if let Some(rest) = base.strip_prefix("https://") {
        format!("wss://{rest}")
    } else if let Some(rest) = base
        .strip_prefix("http://")
        .filter(|r| r.starts_with("127.0.0.1:") || r.starts_with("localhost:"))
    {
        format!("ws://{rest}")
    } else {
        bail!("the endpoint must be https");
    };
    Ok(format!("{ws}{SOCKET_PATH}"))
}

/// Backoff after the nth failed connect: 1 s doubling to 60 s, with jitter.
pub fn backoff(attempt: u32) -> Duration {
    let base = 1u64 << attempt.min(6);
    let ms = base.min(60) * 1000;
    let jitter = rand::random::<u64>() % (ms / 4 + 1);
    Duration::from_millis(ms - ms / 8 + jitter)
}

/// Whether a failed dial means this machine is gone, not just offline: the gateway answered the upgrade with 401
/// (the grant is unknown or revoked) or 404 (the workspace object removed the machine, as it does a mail-only device
/// offline past its time). Dialling again would loop forever on the same answer, so the runner treats it as a
/// "revoked" goodbye: the grant is deleted and the next hook pairs the device again.
pub fn gone(err: &anyhow::Error) -> bool {
    use tokio_tungstenite::tungstenite::{http::StatusCode, Error};
    err.chain().any(|e| {
        matches!(
            e.downcast_ref::<Error>(),
            Some(Error::Http(r)) if r.status() == StatusCode::NOT_FOUND || r.status() == StatusCode::UNAUTHORIZED
        )
    })
}

/// Where and as whom to dial.
#[derive(Clone)]
pub struct Dial {
    pub socket_url: String,
    pub grant: String,
    pub machine_id: String,
}

/// A challenge nonce as the schema allows it: 32 to 128 base64url characters.
pub fn valid_nonce(nonce: &str) -> bool {
    (32..=128).contains(&nonce.len())
        && nonce
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
}

/// Runs until the gateway says goodbye; dials again after every other end.
/// `on_state` hears "online" and "offline".
pub async fn run_forever(
    machine: Machine,
    dial: Dial,
    mut out_rx: mpsc::Receiver<RunnerMsg>,
    on_state: impl Fn(&str),
) -> GoodbyeReason {
    let mut attempt = 0u32;
    loop {
        match connect_once(&machine, &dial, &mut out_rx, &on_state).await {
            Ok(Stop::Goodbye(reason)) => {
                on_state("offline");
                return reason;
            }
            Ok(Stop::No) => attempt = 0,
            Err(e) => eprintln!("connection: {e:#}"),
        }
        on_state("offline");
        let wait = backoff(attempt);
        attempt = attempt.saturating_add(1);
        tokio::time::sleep(wait).await;
    }
}

async fn connect_once(
    machine: &Machine,
    dial: &Dial,
    out_rx: &mut mpsc::Receiver<RunnerMsg>,
    on_state: &impl Fn(&str),
) -> Result<Stop> {
    let mut req = dial.socket_url.as_str().into_client_request()?;
    req.headers_mut().insert(
        "authorization",
        format!("Bearer {}", dial.grant)
            .parse()
            .context("grant has characters a header cannot carry")?,
    );
    req.headers_mut().insert(
        "user-agent",
        format!("context-machine/{}", env!("CARGO_PKG_VERSION")).parse()?,
    );
    let dialled = tokio::time::timeout(
        Duration::from_secs(20),
        tokio_tungstenite::connect_async(req),
    )
    .await
    .context("connect timed out")?;
    let (ws, _) = match dialled {
        Ok(ws) => ws,
        Err(e) => {
            let e = anyhow::Error::from(e);
            if gone(&e) {
                eprintln!("connection: {e:#}; this device is gone from Context");
                return Ok(Stop::Goodbye(GoodbyeReason::Revoked));
            }
            return Err(e);
        }
    };
    let (mut tx, mut rx) = ws.split();

    let challenge = loop {
        let msg = tokio::time::timeout(CHALLENGE_WAIT, rx.next())
            .await
            .context("no challenge from the gateway")?;
        match msg {
            Some(Ok(Message::Text(t))) => match serde_json::from_str::<ServerMsg>(&t) {
                Ok(ServerMsg::Challenge(c)) => break c,
                Ok(ServerMsg::Goodbye(g)) => return Ok(Stop::Goodbye(g.reason)),
                _ => continue,
            },
            Some(Ok(_)) => continue,
            Some(Err(e)) => return Err(e.into()),
            None => bail!("closed before the challenge"),
        }
    };
    if challenge.protocol != PROTOCOL_VERSION {
        bail!(
            "the gateway speaks protocol {}, this runner {PROTOCOL_VERSION}; update the runner",
            challenge.protocol
        );
    }
    if !valid_nonce(&challenge.nonce) {
        bail!("the gateway's challenge is not a nonce");
    }
    send(
        &mut tx,
        &machine.hello(&dial.machine_id, &challenge.nonce).await?,
    )
    .await?;
    send(&mut tx, &RunnerMsg::Status(machine.status().await)).await?;
    on_state("online");
    eprintln!("connected");

    let mut ping = tokio::time::interval(PING_EVERY);
    let mut status = tokio::time::interval(STATUS_EVERY);
    let mut last_heard = tokio::time::Instant::now();
    loop {
        tokio::select! {
            incoming = rx.next() => {
                last_heard = tokio::time::Instant::now();
                match incoming {
                    Some(Ok(Message::Text(t))) => match serde_json::from_str::<ServerMsg>(&t) {
                        Ok(msg) => {
                            if let Stop::Goodbye(r) = machine.handle(msg).await {
                                let _ = tx.send(Message::Close(None)).await;
                                return Ok(Stop::Goodbye(r));
                            }
                        }
                        // Unknown or malformed frames are ignored, never run:
                        // nothing in the protocol is a command.
                        Err(e) => eprintln!("ignored a message the runner does not know ({e})"),
                    },
                    Some(Ok(Message::Ping(p))) => tx.send(Message::Pong(p)).await?,
                    Some(Ok(Message::Close(_))) | None => return Ok(Stop::No),
                    Some(Ok(_)) => {}
                    Some(Err(e)) => return Err(e.into()),
                }
            }
            msg = out_rx.recv() => {
                let Some(msg) = msg else { return Ok(Stop::No) };
                if let RunnerMsg::Usage(u) = &msg {
                    machine.on_usage(machine.tool_of(&u.run_id), u).await;
                }
                send(&mut tx, &msg).await?;
            }
            _ = ping.tick() => {
                if last_heard.elapsed() > SILENCE_LIMIT { bail!("the gateway went quiet"); }
                tx.send(Message::Ping(Vec::new())).await?;
            }
            _ = status.tick() => send(&mut tx, &RunnerMsg::Status(machine.status().await)).await?,
        }
    }
}

async fn send<S>(tx: &mut S, msg: &RunnerMsg) -> Result<()>
where
    S: SinkExt<Message> + Unpin,
    S::Error: std::error::Error + Send + Sync + 'static,
{
    tx.send(Message::Text(serde_json::to_string(msg)?)).await?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn socket_urls() {
        assert_eq!(
            socket_url("https://context.lc/").unwrap(),
            "wss://context.lc/machines/socket"
        );
        assert_eq!(
            socket_url("http://127.0.0.1:8787").unwrap(),
            "ws://127.0.0.1:8787/machines/socket"
        );
        assert!(socket_url("http://example.com").is_err());
        assert!(socket_url("http://localhost.evil.com").is_err());
    }

    #[test]
    fn nonces_follow_the_schema() {
        assert!(valid_nonce(&"a".repeat(32)));
        assert!(!valid_nonce(&"a".repeat(31)));
        assert!(!valid_nonce(&"a".repeat(129)));
        assert!(!valid_nonce(&format!("{}:x", "a".repeat(40))));
    }

    /// A one-shot HTTP server that answers every upgrade with `status`.
    async fn answering(status: &'static str) -> String {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        tokio::spawn(async move {
            use tokio::io::{AsyncReadExt, AsyncWriteExt};
            while let Ok((mut s, _)) = listener.accept().await {
                let mut buf = [0u8; 4096];
                let _ = s.read(&mut buf).await;
                let _ = s
                    .write_all(format!("HTTP/1.1 {status}\r\ncontent-length: 0\r\n\r\n").as_bytes())
                    .await;
            }
        });
        format!("ws://{addr}{SOCKET_PATH}")
    }

    async fn dial_error(status: &'static str) -> anyhow::Error {
        let url = answering(status).await;
        let err = tokio_tungstenite::connect_async(url).await.unwrap_err();
        anyhow::Error::from(err)
    }

    #[tokio::test]
    async fn a_machine_the_gateway_no_longer_knows_is_gone_not_offline() {
        // 404: the workspace object removed it (a mail-only device past its time).
        assert!(gone(&dial_error("404 Not Found").await));
        // 401: the grant is unknown or revoked.
        assert!(gone(&dial_error("401 Unauthorized").await));
        // Anything else is a bad moment, and the runner dials again.
        assert!(!gone(&dial_error("503 Service Unavailable").await));
        assert!(!gone(
            &dial_error("407 Proxy Authentication Required").await
        ));
        assert!(!gone(&anyhow::anyhow!("connect timed out")));
    }

    #[test]
    fn backoff_grows_and_caps() {
        assert!(backoff(0) <= Duration::from_millis(1200));
        assert!(backoff(20) <= Duration::from_secs(70));
        assert!(backoff(20) >= Duration::from_secs(50));
    }
}
