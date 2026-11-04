//! The one outbound socket to the workspace object.
//!
//! The runner only dials out: nothing listens on the machine, and a laptop
//! behind any router works. Every connect proves the machine holds its key by
//! signing the gateway's fresh challenge, so a copied grant without the key is
//! useless. When the socket drops, running parts carry on and the runner dials
//! again with backoff.

use crate::machine::Machine;
use crate::protocol::{RunnerMsg, ServerMsg};
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

/// Runs until the process is stopped. `on_state` hears "online"/"offline".
pub async fn run_forever(
    machine: Machine,
    endpoint: String,
    grant: String,
    mut out_rx: mpsc::Receiver<RunnerMsg>,
    on_state: impl Fn(&str),
) {
    let mut attempt = 0u32;
    loop {
        match connect_once(&machine, &endpoint, &grant, &mut out_rx, &on_state).await {
            Ok(()) => attempt = 0,
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
    endpoint: &str,
    grant: &str,
    out_rx: &mut mpsc::Receiver<RunnerMsg>,
    on_state: &impl Fn(&str),
) -> Result<()> {
    let mut req = socket_url(endpoint)?.into_client_request()?;
    req.headers_mut().insert(
        "authorization",
        format!("Bearer {grant}")
            .parse()
            .context("grant has characters a header cannot carry")?,
    );
    req.headers_mut().insert(
        "user-agent",
        format!("context-machine/{}", env!("CARGO_PKG_VERSION")).parse()?,
    );
    let (ws, _) = tokio::time::timeout(
        Duration::from_secs(20),
        tokio_tungstenite::connect_async(req),
    )
    .await
    .context("connect timed out")??;
    let (mut tx, mut rx) = ws.split();

    let nonce = loop {
        let msg = tokio::time::timeout(CHALLENGE_WAIT, rx.next())
            .await
            .context("no challenge from the gateway")?;
        match msg {
            Some(Ok(Message::Text(t))) => {
                if let Ok(ServerMsg::Challenge(c)) = serde_json::from_str::<ServerMsg>(&t) {
                    break c.nonce;
                }
            }
            Some(Ok(_)) => continue,
            Some(Err(e)) => return Err(e.into()),
            None => bail!("closed before the challenge"),
        }
    };
    if nonce.len() < 16 || nonce.len() > 512 {
        bail!("the gateway's challenge is not a nonce");
    }
    send(&mut tx, &machine.hello(&nonce).await?).await?;
    for r in machine.unacked_results() {
        send(&mut tx, &r).await?;
    }
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
                        Ok(ServerMsg::Ping) => send(&mut tx, &RunnerMsg::Pong).await?,
                        Ok(msg) => machine.handle(msg).await,
                        // Unknown kinds are ignored, never run: nothing in the
                        // protocol is a command.
                        Err(e) => eprintln!("ignored a message the runner does not know ({e})"),
                    },
                    Some(Ok(Message::Ping(p))) => tx.send(Message::Pong(p)).await?,
                    Some(Ok(Message::Close(_))) | None => return Ok(()),
                    Some(Ok(_)) => {}
                    Some(Err(e)) => return Err(e.into()),
                }
            }
            msg = out_rx.recv() => {
                let Some(msg) = msg else { return Ok(()) };
                if let RunnerMsg::Limit(l) = &msg { machine.on_limit(l).await; }
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
    fn backoff_grows_and_caps() {
        assert!(backoff(0) <= Duration::from_millis(1200));
        assert!(backoff(20) <= Duration::from_secs(70));
        assert!(backoff(20) >= Duration::from_secs(50));
    }
}
