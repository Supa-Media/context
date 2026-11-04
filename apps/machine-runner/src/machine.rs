//! The runner's state while it is up: the effective rules, the ledger, the
//! running runs, and what to do with each message from the gateway.
//!
//! Lives across reconnects. A dropped socket does not stop a running run; its
//! steps queue, its result is kept on disk, and the next hello lists it so the
//! job resumes rather than restarts. The `welcome` that answers the hello says
//! which runs the workspace object still wants; the runner cancels the rest.

use crate::limits::{utc_offset_minutes, Ledger};
use crate::protocol::*;
use crate::rules::{self, Refused, Snapshot};
use crate::run::{self, RunContext, RunInput};
use crate::state::{write_private, State};
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Arc;
use tokio::sync::{mpsc, Mutex};

pub struct Inner {
    pub rules: Rules,
    pub ledger: Ledger,
    pub running: HashMap<String, mpsc::Sender<RunInput>>,
    pub facts: MachineFacts,
    pub slots: SlotCounts,
    pub utc_offset_minutes: i32,
}

#[derive(Clone)]
pub struct Machine {
    pub state: State,
    pub inner: Arc<Mutex<Inner>>,
    pub out: mpsc::Sender<RunnerMsg>,
    pub runner_exe: PathBuf,
    pub name: String,
}

pub fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// What a goodbye means for the runner.
#[derive(Debug, PartialEq, Eq)]
pub enum Stop {
    /// Keep dialling.
    No,
    /// Do not reconnect, for this reason.
    Goodbye(GoodbyeReason),
}

impl Machine {
    pub fn new(
        state: State,
        facts: MachineFacts,
        out: mpsc::Sender<RunnerMsg>,
        runner_exe: PathBuf,
        name: String,
    ) -> Machine {
        let slots = crate::slots::advise(facts.memory_mb, facts.cores);
        let rules = rules::effective(&state.rules(), &state.local(), slots.most);
        let utc = utc_offset_minutes(rules.limits.time_zone.as_deref());
        let ledger = state.ledger();
        Machine {
            inner: Arc::new(Mutex::new(Inner {
                rules,
                ledger,
                running: HashMap::new(),
                facts,
                slots,
                utc_offset_minutes: utc,
            })),
            state,
            out,
            runner_exe,
            name,
        }
    }

    /// Runs this runner still holds: running, or finished with a result kept.
    fn held_runs(&self, inner: &Inner) -> Vec<HeldRun> {
        let mut held = vec![];
        for entry in std::fs::read_dir(self.state.runs_dir())
            .into_iter()
            .flatten()
            .flatten()
        {
            let id = entry.file_name().to_string_lossy().to_string();
            let Some(r) = run::load_record(&self.state, &id) else {
                continue;
            };
            let alive = inner.running.contains_key(&id);
            if alive || run::result_path(&self.state, &id).exists() {
                held.push(HeldRun {
                    run_id: id,
                    alive,
                    session: Some(r.session).filter(|s| !s.is_empty()),
                    last_step: Some(r.last_step),
                });
            }
        }
        held.sort_by_key(|h| !h.alive);
        held.truncate(8);
        held
    }

    pub async fn hello(&self, machine_id: &str, nonce: &str) -> anyhow::Result<RunnerMsg> {
        let inner = self.inner.lock().await;
        let mut facts = inner.facts.clone();
        facts.repos = Some(crate::facts::repos_in(&inner.rules.folders)).filter(|r| !r.is_empty());
        Ok(RunnerMsg::Hello(Box::new(Hello {
            protocol: PROTOCOL_VERSION,
            machine_id: machine_id.to_string(),
            signature: self.state.sign(&hello_signing_text(machine_id, nonce))?,
            runner: env!("CARGO_PKG_VERSION").to_string(),
            facts,
            slots: inner.slots,
            runs: self.held_runs(&inner),
        })))
    }

    pub async fn status(&self) -> Status {
        let inner = self.inner.lock().await;
        let now = now_ms();
        let free = crate::facts::memory().available_mb;
        let tools: Vec<ToolFact> = inner
            .facts
            .tools
            .iter()
            .filter(|t| t.name == "claude" || t.name == "codex")
            .cloned()
            .collect();
        let any_installed = tools.iter().any(|t| t.installed);
        let any_ready = [Tool::Claude, Tool::Codex]
            .iter()
            .any(|t| inner.rules.tools.contains(t) && crate::facts::ready(&inner.facts, *t));
        let paused_until = [Tool::Claude, Tool::Codex]
            .iter()
            .filter_map(|t| inner.ledger.paused_until_ms(*t))
            .filter(|u| *u > now)
            .min();
        let not_ready = if !any_installed {
            Some(NotReady::NoTool)
        } else if !any_ready {
            Some(NotReady::SignedOut)
        } else if free < crate::slots::MIN_FREE_MB {
            Some(NotReady::Memory)
        } else if paused_until.is_some() && inner.rules.limits.pause_near_plan_limit {
            Some(NotReady::Paused)
        } else {
            None
        };
        Status {
            ready: not_ready.is_none(),
            not_ready,
            busy: inner.running.len() as u32,
            free_memory_mb: free,
            paused_until,
            tools: Some(tools),
        }
    }

    async fn set_rules(&self, rules: Rules) {
        let _ = self.state.save_rules(&rules);
        let mut inner = self.inner.lock().await;
        inner.rules = rules::effective(&rules, &self.state.local(), inner.slots.most);
        inner.utc_offset_minutes = utc_offset_minutes(inner.rules.limits.time_zone.as_deref());
    }

    pub async fn handle(&self, msg: ServerMsg) -> Stop {
        match msg {
            ServerMsg::Challenge(_) => {}
            ServerMsg::Welcome(w) => {
                let mut m = self.state.machine();
                if m.machine_id != w.machine_id || w.name.as_ref().is_some_and(|n| *n != m.name) {
                    m.machine_id = w.machine_id.clone();
                    if let Some(n) = w.name.clone() {
                        m.name = n;
                    }
                    let _ = self.state.save_machine(&m);
                }
                self.set_rules(w.rules).await;
                self.keep_only(&w.keep_runs).await;
            }
            ServerMsg::Rules(r) => self.set_rules(r.rules).await,
            ServerMsg::Assign(a) => self.assign(*a).await,
            ServerMsg::Message(m) => {
                let run_id = m.run_id.clone();
                self.input(&run_id, RunInput::Mail(m)).await;
            }
            ServerMsg::Interrupt(i) => {
                let run_id = i.run_id.clone();
                self.input(&run_id, RunInput::Interrupt(i)).await;
            }
            ServerMsg::Cancel(c) => {
                if !self.input(&c.run_id, RunInput::Cancel).await {
                    // Nothing running by that id: forget any held result too.
                    self.forget_run(&c.run_id);
                }
            }
            ServerMsg::Goodbye(g) => return Stop::Goodbye(g.reason),
        }
        Stop::No
    }

    /// After a welcome: cancel runs the workspace object no longer wants,
    /// forget their records, and send again the results it still wants.
    async fn keep_only(&self, keep: &[String]) {
        let held = {
            let inner = self.inner.lock().await;
            self.held_runs(&inner)
        };
        for h in held {
            if keep.contains(&h.run_id) {
                if !h.alive {
                    if let Some(r) = std::fs::read(run::result_path(&self.state, &h.run_id))
                        .ok()
                        .and_then(|b| serde_json::from_slice::<RunResult>(&b).ok())
                    {
                        let _ = self.out.send(RunnerMsg::Result(r)).await;
                    }
                }
            } else if h.alive {
                self.input(&h.run_id, RunInput::Cancel).await;
            } else {
                self.forget_run(&h.run_id);
            }
        }
    }

    fn forget_run(&self, run_id: &str) {
        if valid_id(run_id) {
            let _ = std::fs::remove_dir_all(self.state.run_dir(run_id));
        }
    }

    /// Hands an input to a running run; false when no run has that id.
    async fn input(&self, run_id: &str, input: RunInput) -> bool {
        let tx = self.inner.lock().await.running.get(run_id).cloned();
        match tx {
            Some(tx) => tx.send(input).await.is_ok(),
            None => false,
        }
    }

    async fn assign(&self, a: Assign) {
        let mut inner = self.inner.lock().await;
        let ids: Vec<String> = inner.running.keys().cloned().collect();
        let now = now_ms();
        inner.ledger.clear_expired(now);
        let checked = rules::check(
            &inner.rules,
            &a,
            &Snapshot {
                now_ms: now,
                running: inner.running.len() as u32,
                running_runs: &ids,
                available_mb: crate::facts::memory().available_mb,
                claude_ready: crate::facts::ready(&inner.facts, Tool::Claude),
                codex_ready: crate::facts::ready(&inner.facts, Tool::Codex),
                ledger: &inner.ledger,
                utc_offset_minutes: inner.utc_offset_minutes,
            },
        );
        let root = match checked {
            Ok(root) => root,
            Err(Refused { code, until }) => {
                drop(inner);
                eprintln!("run {}: refused ({code:?})", a.run_id);
                let _ = self
                    .out
                    .send(RunnerMsg::Refuse(Refuse {
                        run_id: a.run_id,
                        code,
                        until,
                    }))
                    .await;
                return;
            }
        };
        if !a.from_owner {
            let day = inner.ledger.day_of(now, inner.utc_offset_minutes);
            inner.ledger.count_others_run(day);
            let _ = self.state.save_ledger(&inner.ledger);
        }
        let (tx, rx) = mpsc::channel(32);
        inner.running.insert(a.run_id.clone(), tx);
        let local = self.state.local();
        let ctx = RunContext {
            state: self.state.clone(),
            trusted_repos: inner.rules.trusted_repos.clone().unwrap_or_default(),
            allowed_commands: rules::allowed_commands(&local),
            machine_name: self.name.clone(),
            runner_exe: self.runner_exe.clone(),
            out: self.out.clone(),
        };
        drop(inner);
        let _ = self
            .out
            .send(RunnerMsg::Accept(Accept {
                run_id: a.run_id.clone(),
            }))
            .await;
        eprintln!(
            "run {}: job {} part {} started with {}",
            a.run_id,
            a.job_id,
            a.part,
            a.tool.name()
        );
        let me = self.clone();
        tokio::spawn(async move { me.run(ctx, a, root, rx).await });
    }

    async fn run(self, ctx: RunContext, a: Assign, root: PathBuf, rx: mpsc::Receiver<RunInput>) {
        let (spent_tx, mut spent_rx) = mpsc::channel::<run::Spent>(8);
        let me = self.clone();
        let own = a.from_owner;
        let counter = tokio::spawn(async move {
            while let Some((ms, tokens)) = spent_rx.recv().await {
                let mut inner = me.inner.lock().await;
                let day = inner.ledger.day_of(now_ms(), inner.utc_offset_minutes);
                inner.ledger.add_time(day, ms, own);
                inner.ledger.add_tokens(day, tokens);
                let _ = me.state.save_ledger(&inner.ledger);
            }
        });
        let run_id = a.run_id.clone();
        let tool = a.tool;
        let result = run::run(ctx, a, root, rx, spent_tx).await;
        let _ = counter.await;
        if result.error.as_deref() == Some("planLimit") {
            let mut inner = self.inner.lock().await;
            inner.ledger.pause(tool, now_ms() + 60 * 60_000);
            let _ = self.state.save_ledger(&inner.ledger);
        }
        if let Ok(bytes) = serde_json::to_vec(&result) {
            let _ = write_private(&run::result_path(&self.state, &run_id), &bytes);
        }
        self.inner.lock().await.running.remove(&run_id);
        eprintln!("run {run_id}: ended {:?}", result.outcome);
        let _ = self.out.send(RunnerMsg::Result(result)).await;
        let status = self.status().await;
        let _ = self.out.send(RunnerMsg::Status(status)).await;
    }

    /// A plan signal from a tool: pause new work until the reset it names
    /// when the plan is used up, or nearly.
    pub async fn on_usage(&self, tool_of_run: Option<Tool>, u: &Usage) {
        let near = u.plan_limited == Some(true) || u.plan_utilization.unwrap_or(0.0) >= PAUSE_AT;
        if let (true, Some(reset), Some(tool)) = (near, u.plan_resets_at, tool_of_run) {
            let mut inner = self.inner.lock().await;
            if inner.rules.limits.pause_near_plan_limit {
                inner.ledger.pause(tool, reset);
                let _ = self.state.save_ledger(&inner.ledger);
            }
        }
    }

    pub fn tool_of(&self, run_id: &str) -> Option<Tool> {
        run::load_record(&self.state, run_id).and_then(|r| r.tool)
    }
}

/// How used a plan window must be before the machine stops taking work.
/// Claude Code warns from 75%; pausing there would idle a machine for days on
/// a weekly window, so the runner waits for 95% or a rejection.
pub const PAUSE_AT: f64 = 0.95;
