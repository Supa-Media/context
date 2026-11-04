//! `context-machine`: lets Tex run jobs on this computer with the person's own
//! Claude Code and Codex, inside the folders and limits they set.

mod awake;
mod claude;
mod cli;
mod codex;
mod conn;
mod drive;
mod facts;
mod limits;
mod machine;
mod mcp_proxy;
mod pair;
mod protocol;
mod rules;
mod run;
mod service;
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
    #[arg(long, global = true)]
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
        /// A machine grant file (0600) handed over by the Mac app.
        #[arg(long)]
        grant_file: Option<PathBuf>,
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
    /// Print this machine's public key, for the Mac app to register.
    Identity {
        #[arg(long)]
        json: bool,
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
            status_json,
            no_keep_awake,
            name,
        } => {
            run(
                state,
                endpoint,
                grant_file,
                status_json,
                no_keep_awake,
                name,
            )
            .await
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
        Command::Identity { json } => {
            let pk = state.public_key()?;
            if json {
                println!("{}", serde_json::json!({ "publicKey": pk }));
            } else {
                println!("{pk}");
            }
            Ok(())
        }
        Command::McpProxy { .. } => unreachable!(),
    }
}

fn default_endpoint(state: &State) -> String {
    let saved = state.machine().endpoint;
    if saved.is_empty() {
        state::DEFAULT_ENDPOINT.to_string()
    } else {
        saved
    }
}

async fn run(
    state: State,
    endpoint: Option<String>,
    grant_file: Option<PathBuf>,
    status_json: bool,
    no_keep_awake: bool,
    name: Option<String>,
) -> Result<()> {
    let grant = state.grant(grant_file.as_deref())?;
    let endpoint = endpoint.unwrap_or_else(|| default_endpoint(&state));
    let swept = state.sweep_secrets();
    if swept > 0 {
        eprintln!("removed {swept} credential file(s) left by runs that did not finish");
    }
    let facts = facts::gather().await;
    let name = name
        .or_else(|| Some(state.machine().name).filter(|n| !n.is_empty()))
        .unwrap_or_else(pair::default_name);
    let (out_tx, out_rx) = tokio::sync::mpsc::channel(1000);
    let exe = std::env::current_exe()?;
    let m = machine::Machine::new(state, facts, out_tx, exe, name);

    if !no_keep_awake {
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
    let advice = m.inner.lock().await.advice;
    let watcher = m.clone();
    let on_state = move |s: &str| {
        if status_json {
            let slots = watcher
                .inner
                .try_lock()
                .map(|i| (i.rules.slots, i.running.len()))
                .unwrap_or((0, 0));
            println!(
                "{}",
                serde_json::json!({ "state": s, "slots": slots.0, "busy": slots.1, "recommended": advice.recommended, "most": advice.most })
            );
        } else {
            eprintln!("{s}");
        }
    };
    tokio::select! {
        _ = conn::run_forever(m.clone(), endpoint, grant, out_rx, on_state) => {}
        _ = shutdown() => eprintln!("stopping"),
    }
    // Running parts are killed with the process (kill_on_drop); their grant
    // files go with the guards, and the next start sweeps any left.
    Ok(())
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
    let advice = slots::advise(facts.memory_mb, facts.cpus);
    let rules = state.rules().effective(&state.local(), advice.most);
    let ledger = state.ledger();
    let now = machine::now_ms();
    let day = ledger.day_of(now, rules.utc_offset_minutes);
    let m = state.machine();
    let paired = state.grant(None).is_ok();
    let today = ledger.day(day).total_secs() / 60;
    let week = ledger.week_secs(day) / 60;
    if json {
        println!(
            "{}",
            serde_json::json!({
                "paired": paired, "name": m.name, "endpoint": m.endpoint, "service": service::is_installed(home),
                "facts": facts, "slots": rules.slots, "recommended": advice.recommended, "most": advice.most,
                "usedTodayMinutes": today, "dailyMinutes": rules.daily_minutes, "usedWeekMinutes": week, "weeklyMinutes": rules.weekly_minutes,
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
    let tool = |t: facts::ToolState| match t {
        facts::ToolState::SignedIn => "signed in",
        facts::ToolState::Installed => "installed, not signed in",
        facts::ToolState::Missing => "not installed",
    };
    println!(
        "Claude Code: {}. Codex: {}.",
        tool(facts.claude),
        tool(facts.codex)
    );
    if facts.claude != facts::ToolState::SignedIn && facts.codex != facts::ToolState::SignedIn {
        println!("Not ready: sign in to Claude Code or Codex on this machine.");
    }
    println!(
        "Slots: {} (recommended {}, most {})",
        rules.slots, advice.recommended, advice.most
    );
    println!(
        "Used today: {} of {}. This week: {} of {}.",
        hm(today),
        hm(rules.daily_minutes),
        hm(week),
        hm(rules.weekly_minutes)
    );
    if rules.folders.is_empty() {
        println!("No folders allowed yet: set them on this machine's page in Context.");
    } else {
        for f in &rules.folders {
            println!("Folder: {}", f.display());
        }
    }
    Ok(())
}

fn hm(minutes: u64) -> String {
    format!("{}h {:02}m", minutes / 60, minutes % 60)
}
