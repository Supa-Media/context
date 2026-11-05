//! `context-machine`: lets Tex run jobs on this computer with the person's own
//! Claude Code and Codex, inside the folders and limits they set.

mod awake;
mod claude;
mod cli;
mod codex;
mod conn;
mod drive;
mod facts;
mod hook;
mod install;
mod join;
mod limits;
mod machine;
mod mailbox;
mod mcp_proxy;
mod pair;
mod protocol;
mod rules;
mod run;
mod service;
mod sign_in;
mod slots;
mod state;
mod workdir;

use anyhow::{bail, Context, Result};
use clap::{Parser, Subcommand};
use state::State;
use std::path::PathBuf;
use std::time::Duration;

#[derive(Parser)]
#[command(
    name = "context-machine",
    version,
    about = "Let Tex run jobs on this computer with your own Claude Code and Codex"
)]
struct Args {
    /// The runner's own folder (default ~/.context-machine).
    #[arg(long, global = true, visible_alias = "data-dir")]
    dir: Option<PathBuf>,
    #[command(subcommand)]
    command: Command,
}

#[derive(Subcommand)]
enum Command {
    /// Pair this computer with your Context account, with a short code.
    Pair {
        #[arg(long)]
        endpoint: Option<String>,
        /// What Tex calls this computer.
        #[arg(long)]
        name: Option<String>,
    },
    /// Connect and take jobs, in the foreground.
    Run {
        #[arg(long)]
        endpoint: Option<String>,
        /// A machine grant file (0600), for the Mac app, which pairs itself.
        #[arg(long)]
        grant_file: Option<PathBuf>,
        /// The workspace object's socket (wss://), from the pairing.
        #[arg(long)]
        socket_url: Option<String>,
        /// This machine's id, from the pairing.
        #[arg(long)]
        machine_id: Option<String>,
        /// Print one JSON status line per change, for the Mac app.
        #[arg(long)]
        status_json: bool,
        /// Do not keep the machine awake (the Mac app does it itself).
        #[arg(long)]
        no_keep_awake: bool,
        #[arg(long)]
        name: Option<String>,
    },
    /// What this runner knows: pairing, tools, slots, today's use.
    Status {
        #[arg(long)]
        json: bool,
    },
    /// Install or remove the background service (launchd or systemd --user).
    Service {
        #[command(subcommand)]
        action: ServiceAction,
    },
    /// Stop the background service.
    Stop,
    /// Unpair: stop the service and delete the key, the grant and every run's files.
    Forget,
    /// Print this machine's public key (made on first use), and with --json its facts, for the Mac app to pair with.
    #[command(visible_alias = "identity")]
    Key {
        #[arg(long)]
        json: bool,
    },
    /// Join Context as a mail-only device for this session (a cloud VM): prints a code to approve with the Context
    /// `pair_device` action, and stays connected in the background.
    Join {
        #[arg(long)]
        endpoint: Option<String>,
        #[arg(long)]
        name: Option<String>,
        /// The background half: pair, then stay connected (started by `join` and the hooks).
        #[arg(long, hide = true)]
        daemon: bool,
    },
    /// What a Claude Code hook runs: SessionStart, UserPromptSubmit, PostToolUse, Stop or SessionEnd. Always exits 0.
    Hook {
        event: String,
        #[arg(long)]
        endpoint: Option<String>,
    },
    /// This device's mail.
    Mail {
        #[command(subcommand)]
        action: MailAction,
    },
    /// A stdio MCP server forwarding to Context with a run grant (Codex runs).
    #[command(hide = true)]
    McpProxy {
        #[arg(long)]
        grant_file: PathBuf,
        #[arg(long)]
        endpoint: String,
    },
}

#[derive(Subcommand)]
enum MailAction {
    /// Wait for mail, print it and exit: run it in the background, and it ends the moment mail arrives.
    /// Exits 3 with nothing printed when `--timeout` seconds pass first.
    Wait {
        #[arg(long)]
        timeout: Option<u64>,
    },
    /// Print mail not yet shown, and mark it shown.
    Read,
}

#[derive(Subcommand)]
enum ServiceAction {
    Install,
    Uninstall,
}

#[tokio::main]
async fn main() {
    let args = Args::parse();
    if let Err(e) = real_main(args).await {
        eprintln!("context-machine: {e:#}");
        std::process::exit(1);
    }
}

async fn real_main(args: Args) -> Result<()> {
    if let Command::McpProxy {
        grant_file,
        endpoint,
    } = &args.command
    {
        return mcp_proxy::run(grant_file, endpoint).await;
    }
    let state = State::open(args.dir.clone())?;
    let home = rules::home_dir().context("HOME is not set")?;
    match args.command {
        Command::Pair { endpoint, name } => {
            let endpoint = endpoint.unwrap_or_else(|| default_endpoint(&state));
            pair::pair(&state, &endpoint, &name.unwrap_or_else(pair::default_name)).await
        }
        Command::Run {
            endpoint,
            grant_file,
            socket_url,
            machine_id,
            status_json,
            no_keep_awake,
            name,
        } => {
            let opts = RunOpts {
                endpoint,
                grant_file,
                socket_url,
                machine_id,
                status_json,
                no_keep_awake,
                name,
            };
            let result = run(state, &opts).await;
            if let (Err(e), true) = (&result, status_json) {
                println!(
                    "{}",
                    serde_json::json!({ "state": "failed", "error": format!("{e:#}") })
                );
            }
            result
        }
        Command::Status { json } => status(&state, &home, json).await,
        Command::Service {
            action: ServiceAction::Install,
        } => {
            if state.grant(None).is_err() {
                bail!("pair first: `context-machine pair`");
            }
            let exe = std::env::current_exe()?;
            println!("{}", service::install(&exe, &home, &state.dir)?);
            Ok(())
        }
        Command::Service {
            action: ServiceAction::Uninstall,
        } => {
            println!("{}", service::uninstall(&home)?);
            Ok(())
        }
        Command::Stop => {
            println!("{}", service::stop()?);
            Ok(())
        }
        Command::Forget => {
            if service::is_installed(&home) {
                println!("{}", service::uninstall(&home)?);
            }
            state.forget()?;
            println!("Forgot this machine's key and grant. Remove it in Context too if it is still listed.");
            Ok(())
        }
        Command::Key { json } => {
            let pk = state.public_key()?;
            if json {
                let mut facts = facts::gather().await;
                facts.repos = None;
                println!("{}", serde_json::json!({ "publicKey": pk, "facts": facts }));
            } else {
                println!("{pk}");
            }
            Ok(())
        }
        Command::Join {
            endpoint,
            name,
            daemon,
        } => {
            let endpoint = endpoint.unwrap_or_else(|| default_endpoint(&state));
            let name = name.unwrap_or_else(|| hook::device_name(&serde_json::Value::Null));
            if daemon {
                return join::daemon(state, &endpoint, &name).await;
            }
            match join::ensure(&state, &endpoint, &name).await? {
                join::Joined::Pairing { code } => println!("Approve this device from the session's Context connection: manage action pair_device, code {code}"),
                join::Joined::Paired { machine_id } => println!("Joined as device {machine_id}."),
            }
            Ok(())
        }
        Command::Hook { event, endpoint } => {
            let endpoint = endpoint.unwrap_or_else(|| default_endpoint(&state));
            if let Some(event) = hook::Event::parse(&event) {
                if let Err(e) = hook::run(&state, event, &endpoint).await {
                    eprintln!("context-machine hook: {e:#}");
                }
            }
            // A hook never fails the session.
            Ok(())
        }
        Command::Mail {
            action: MailAction::Read,
        } => {
            let mail = mailbox::take_unread(&state)?;
            if !mail.is_empty() {
                println!(
                    "{}",
                    mailbox::words(
                        &mail,
                        &state.machine().machine_id,
                        &hook::wait_command(&state)
                    )
                );
            }
            Ok(())
        }
        Command::Mail {
            action: MailAction::Wait { timeout },
        } => mail_wait(&state, timeout).await,
        Command::McpProxy { .. } => unreachable!(),
    }
}

/// Waits for this device's mail and prints it; exit 3 on a timeout. Its pid is kept so the hooks know one is waiting.
async fn mail_wait(state: &State, timeout: Option<u64>) -> Result<()> {
    let waiter = state.dir.join("mail").join("waiter.pid");
    state::make_private_dir(&state.dir.join("mail"))?;
    state::write_private(&waiter, std::process::id().to_string().as_bytes())?;
    let deadline = timeout.map(|t| tokio::time::Instant::now() + Duration::from_secs(t));
    let got = loop {
        let mail = mailbox::take_unread(state)?;
        if !mail.is_empty() {
            break Some(mail);
        }
        if deadline.is_some_and(|d| tokio::time::Instant::now() > d) {
            break None;
        }
        tokio::time::sleep(Duration::from_millis(200)).await;
    };
    if std::fs::read_to_string(&waiter).ok().as_deref() == Some(&std::process::id().to_string()) {
        let _ = std::fs::remove_file(&waiter);
    }
    match got {
        Some(mail) => {
            println!(
                "{}",
                mailbox::words(
                    &mail,
                    &state.machine().machine_id,
                    &hook::wait_command(state)
                )
            );
            Ok(())
        }
        None => std::process::exit(3),
    }
}

fn default_endpoint(state: &State) -> String {
    if let Some(e) = std::env::var("CONTEXT_MACHINE_ENDPOINT")
        .ok()
        .filter(|e| !e.is_empty())
    {
        return e;
    }
    let saved = state.machine().endpoint;
    if saved.is_empty() {
        state::DEFAULT_ENDPOINT.to_string()
    } else {
        saved
    }
}

#[derive(Default)]
pub(crate) struct RunOpts {
    pub endpoint: Option<String>,
    pub grant_file: Option<PathBuf>,
    pub socket_url: Option<String>,
    pub machine_id: Option<String>,
    pub status_json: bool,
    pub no_keep_awake: bool,
    pub name: Option<String>,
}

/// The socket to dial: the flag, else the one saved at pairing, else the
/// endpoint's. Only `wss://` (or a loopback `ws://` for tests).
fn dial_url(opts: &RunOpts, saved: &state::Machine, endpoint: &str) -> Result<String> {
    let url = match opts
        .socket_url
        .clone()
        .or_else(|| Some(saved.socket_url.clone()).filter(|u| !u.is_empty()))
    {
        Some(u) => u,
        None => return conn::socket_url(endpoint),
    };
    let loopback = ["ws://127.0.0.1:", "ws://localhost:"]
        .iter()
        .any(|p| url.starts_with(p));
    if !url.starts_with("wss://") && !loopback {
        bail!("the socket address must be wss://");
    }
    Ok(url)
}

pub(crate) async fn run(state: State, opts: &RunOpts) -> Result<()> {
    let say = |line: serde_json::Value| {
        if opts.status_json {
            println!("{line}");
        }
    };
    say(serde_json::json!({ "state": "starting" }));
    let grant = state.grant(opts.grant_file.as_deref())?;
    let saved = state.machine();
    let machine_id = opts
        .machine_id
        .clone()
        .unwrap_or_else(|| saved.machine_id.clone());
    if !protocol::valid_id(&machine_id) {
        bail!("no machine id: pair first, or pass --machine-id");
    }
    let endpoint = opts
        .endpoint
        .clone()
        .unwrap_or_else(|| default_endpoint(&state));
    let dial = conn::Dial {
        socket_url: dial_url(opts, &saved, &endpoint)?,
        grant,
        machine_id,
    };
    let swept = state.sweep_secrets();
    if swept > 0 {
        eprintln!("removed {swept} credential file(s) left by runs that did not finish");
    }
    let facts = facts::gather().await;
    let name = opts
        .name
        .clone()
        .or_else(|| Some(saved.name.clone()).filter(|n| !n.is_empty()))
        .unwrap_or_else(pair::default_name);
    let (out_tx, out_rx) = tokio::sync::mpsc::channel(1000);
    let exe = std::env::current_exe()?;
    let m = machine::Machine::new(state.clone(), facts, out_tx, exe, name);

    if !opts.no_keep_awake {
        tokio::spawn(awake::keep_awake_while_plugged_in());
    }
    // Sign-ins change: look again every ten minutes.
    let refresh = m.clone();
    tokio::spawn(async move {
        loop {
            tokio::time::sleep(Duration::from_secs(600)).await;
            let f = facts::gather().await;
            refresh.inner.lock().await.facts = f;
        }
    });
    // One status line per change: online, offline, paused or notReady.
    let (conn_tx, conn_rx) = tokio::sync::watch::channel("offline".to_string());
    // Stopped before `run` returns, so a closing "failed" line is always the
    // last one: left running, it could print one more "offline" after it.
    let status_task = opts
        .status_json
        .then(|| tokio::spawn(status_lines(m.clone(), conn_rx)));
    let on_state = move |s: &str| {
        let _ = conn_tx.send(s.to_string());
        eprintln!("{s}");
    };
    let ended: Result<()> = tokio::select! {
        reason = conn::run_forever(m.clone(), dial, out_rx, on_state) => {
            use protocol::GoodbyeReason::*;
            match reason {
                Revoked => {
                    // The grant is dead: delete it so nothing tries it again.
                    let _ = std::fs::remove_file(state.dir.join("grant"));
                    Err(anyhow::anyhow!("this machine was disconnected in Context; run `context-machine pair` to connect it again"))
                }
                Replaced => Err(anyhow::anyhow!("another runner connected as this machine")),
                BadSignature => Err(anyhow::anyhow!("the gateway did not accept this machine's key; run `context-machine pair` again")),
                Protocol => Err(anyhow::anyhow!("the gateway did not understand this runner; update it")),
            }
        }
        _ = shutdown() => { eprintln!("stopping"); Ok(()) }
    };
    if let Some(task) = status_task {
        task.abort();
        let _ = task.await;
    }
    ended?;
    // Running parts are killed with the process (kill_on_drop); their grant
    // files go with the guards, and the next start sweeps any left.
    Ok(())
}

async fn status_lines(m: machine::Machine, mut conn: tokio::sync::watch::Receiver<String>) {
    let mut last = String::new();
    loop {
        let st = m.status().await;
        let (slots, most, recommended) = {
            let i = m.inner.lock().await;
            (i.rules.limits.slots, i.slots.most, i.slots.recommended)
        };
        let online = conn.borrow().clone();
        let state = match (online.as_str(), st.not_ready) {
            ("online", Some(protocol::NotReady::Paused)) => "paused",
            ("online", Some(_)) => "notReady",
            (s, _) => {
                if s == "online" {
                    "online"
                } else {
                    "offline"
                }
            }
        };
        let line = serde_json::json!({
            "state": state, "notReady": st.not_ready, "busy": st.busy, "slots": slots,
            "recommended": recommended, "most": most, "pausedUntil": st.paused_until, "freeMemoryMb": st.free_memory_mb,
        });
        let key =
            serde_json::json!([state, st.not_ready, st.busy, slots, st.paused_until]).to_string();
        if key != last {
            println!("{line}");
            last = key;
        }
        tokio::select! {
            _ = conn.changed() => {}
            _ = tokio::time::sleep(Duration::from_secs(5)) => {}
        }
    }
}

async fn shutdown() {
    #[cfg(unix)]
    {
        let mut term = tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())
            .expect("signal handler");
        tokio::select! {
            _ = tokio::signal::ctrl_c() => {}
            _ = term.recv() => {}
        }
    }
    #[cfg(not(unix))]
    let _ = tokio::signal::ctrl_c().await;
}

async fn status(state: &State, home: &std::path::Path, json: bool) -> Result<()> {
    let facts = facts::gather().await;
    let advice = slots::advise(facts.memory_mb, facts.cores);
    let rules = rules::effective(&state.rules(), &state.local(), advice.most);
    let offset = limits::utc_offset_minutes(rules.limits.time_zone.as_deref());
    let ledger = state.ledger();
    let day = ledger.day_of(machine::now_ms(), offset);
    let m = state.machine();
    let paired = state.grant(None).is_ok();
    let today = ledger.day(day).total_ms() / 60_000;
    let week = ledger.week_ms(day) / 60_000;
    let (day_limit, week_limit) = (rules.limits.day_ms / 60_000, rules.limits.week_ms / 60_000);
    if json {
        println!(
            "{}",
            serde_json::json!({
                "paired": paired, "machineId": m.machine_id, "name": m.name, "endpoint": m.endpoint, "service": service::is_installed(home),
                "facts": facts, "slots": rules.limits.slots, "recommended": advice.recommended, "most": advice.most,
                "usedTodayMinutes": today, "dayMinutes": day_limit, "usedWeekMinutes": week, "weekMinutes": week_limit,
                "folders": rules.folders,
            })
        );
        return Ok(());
    }
    println!(
        "{}",
        if paired {
            format!("Paired as {} with {}", m.name, m.endpoint)
        } else {
            "Not paired. Run `context-machine pair`.".into()
        }
    );
    println!(
        "Service: {}",
        if service::is_installed(home) {
            "installed"
        } else {
            "not installed"
        }
    );
    let tool = |name: &str| match facts.tools.iter().find(|t| t.name == name) {
        Some(t) if t.signed_in => "signed in",
        Some(t) if t.installed => "installed, not signed in",
        _ => "not installed",
    };
    println!("Claude Code: {}. Codex: {}.", tool("claude"), tool("codex"));
    if !facts::ready(&facts, protocol::Tool::Claude) && !facts::ready(&facts, protocol::Tool::Codex)
    {
        println!("Not ready: sign in to Claude Code or Codex on this machine.");
    }
    println!(
        "Slots: {} (recommended {}, most {})",
        rules.limits.slots, advice.recommended, advice.most
    );
    println!(
        "Used today: {} of {}. This week: {} of {}.",
        hm(today),
        hm(day_limit),
        hm(week),
        hm(week_limit)
    );
    if rules.folders.is_empty() {
        println!("No folders allowed yet: set them on this machine's page in Context.");
    } else {
        for f in &rules.folders {
            println!("Folder: {f}");
        }
    }
    Ok(())
}

fn hm(minutes: u64) -> String {
    format!("{}h {:02}m", minutes / 60, minutes % 60)
}
