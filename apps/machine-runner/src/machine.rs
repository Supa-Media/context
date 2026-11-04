//! The runner's state while it is up: the effective rules, the ledger, the
//! running parts, and what to do with each message from the gateway.
//!
//! Lives across reconnects. A dropped socket does not stop a running part;
//! its steps queue, its result is kept on disk until the job object acks it,
//! and the next hello lists it so the job resumes rather than restarts.

use crate::facts::{Facts, ToolState};
use crate::limits::Ledger;
use crate::protocol::*;
use crate::rules::{self, Rules, Snapshot};
use crate::run::{self, PartContext, RunInput};
use crate::slots::SlotAdvice;
use crate::state::{write_private, State};
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Arc;
use tokio::sync::{mpsc, Mutex};

pub struct Running {
    pub tx: mpsc::Sender<RunInput>,
}

pub struct Inner {
    pub rules: Rules,
    pub ledger: Ledger,
    pub running: HashMap<String, Running>,
    pub facts: Facts,
    pub advice: SlotAdvice,
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

impl Machine {
    pub fn new(
        state: State,
        facts: Facts,
        out: mpsc::Sender<RunnerMsg>,
        runner_exe: PathBuf,
        name: String,
    ) -> Machine {
        let advice = crate::slots::advise(facts.memory_mb, facts.cpus);
        let rules = state.rules().effective(&state.local(), advice.most);
        let ledger = state.ledger();
        Machine {
            inner: Arc::new(Mutex::new(Inner {
                rules,
                ledger,
                running: HashMap::new(),
                facts,
                advice,
            })),
            state,
            out,
            runner_exe,
            name,
        }
    }

    pub async fn hello(&self, nonce: &str) -> anyhow::Result<RunnerMsg> {
        let inner = self.inner.lock().await;
        let mut running = vec![];
        for entry in std::fs::read_dir(self.state.runs_dir())
            .into_iter()
            .flatten()
            .flatten()
        {
            let job = entry.file_name().to_string_lossy().to_string();
            if let Some(r) = run::load_record(&self.state, &job) {
                let alive = inner.running.contains_key(&job);
                if alive || run::result_path(&self.state, &job).exists() {
                    running.push(RunningPart {
                        job_id: job,
                        part: r.part,
                        session_id: r.session_id,
                        last_step: r.last_step,
                        alive,
                    });
                }
            }
        }
        Ok(RunnerMsg::Hello(Hello {
            version: PROTOCOL_VERSION,
            runner: format!("context-machine {}", env!("CARGO_PKG_VERSION")),
            signature: self.state.sign(nonce)?,
            public_key: self.state.public_key()?,
            facts: inner.facts.clone(),
            slots: inner.advice,
            free_memory_mb: crate::facts::memory().available_mb,
            running,
        }))
    }

    /// Results the job object has not acked yet, sent again after each hello.
    pub fn unacked_results(&self) -> Vec<RunnerMsg> {
        std::fs::read_dir(self.state.runs_dir())
            .into_iter()
            .flatten()
            .flatten()
            .filter_map(|e| std::fs::read(e.path().join("result.json")).ok())
            .filter_map(|b| serde_json::from_slice::<PartResult>(&b).ok())
            .map(RunnerMsg::Result)
            .collect()
    }

    pub async fn status(&self) -> Status {
        let inner = self.inner.lock().await;
        let now = now_ms();
        let day = inner.ledger.day_of(now, inner.rules.utc_offset_minutes);
        Status {
            slots: inner.rules.slots,
            busy: inner.running.len() as u32,
            paused_until: [Cli::Claude, Cli::Codex]
                .iter()
                .filter_map(|c| inner.ledger.paused_until_ms(*c))
                .filter(|u| *u > now)
                .min(),
            free_memory_mb: crate::facts::memory().available_mb,
            used_today_minutes: inner.ledger.day(day).total_secs() / 60,
            used_week_minutes: inner.ledger.week_secs(day) / 60,
        }
    }

    pub async fn handle(&self, msg: ServerMsg) {
        match msg {
            ServerMsg::Challenge(_) | ServerMsg::Ping => {}
            ServerMsg::Settings(s) => {
                let _ = self.state.save_rules(&s.rules);
                let mut inner = self.inner.lock().await;
                inner.rules = s.rules.effective(&self.state.local(), inner.advice.most);
            }
            ServerMsg::Assign(a) => self.assign(a).await,
            ServerMsg::Message(m) => self.input(&m.job_id, RunInput::Mail(m.mail)).await,
            ServerMsg::Interrupt(i) => {
                self.input(
                    &i.job_id,
                    RunInput::Interrupt {
                        reason: i.reason,
                        mail: i.mail,
                    },
                )
                .await
            }
            ServerMsg::Cancel(c) => self.input(&c.job_id, RunInput::Cancel).await,
            ServerMsg::Release(c) => self.release(c.job_id).await,
            ServerMsg::Ack(a) => {
                if rules::valid_job_id(&a.job_id) {
                    let path = run::result_path(&self.state, &a.job_id);
                    if std::fs::read(&path)
                        .ok()
                        .and_then(|b| serde_json::from_slice::<PartResult>(&b).ok())
                        .is_some_and(|r| r.part == a.part)
                    {
                        let _ = std::fs::remove_file(path);
                    }
                }
            }
        }
    }

    async fn input(&self, job_id: &str, input: RunInput) {
        let tx = self
            .inner
            .lock()
            .await
            .running
            .get(job_id)
            .map(|r| r.tx.clone());
        if let Some(tx) = tx {
            let _ = tx.send(input).await;
        }
    }

    async fn release(&self, job_id: String) {
        if !rules::valid_job_id(&job_id) || self.inner.lock().await.running.contains_key(&job_id) {
            return;
        }
        let Some(rec) = run::load_record(&self.state, &job_id) else {
            return;
        };
        let released = crate::workdir::release(&rec.root, &job_id).await;
        let (kept, branch) = match released {
            Ok(crate::workdir::Released::Kept(b)) => (true, b),
            _ => (false, None),
        };
        let _ = std::fs::remove_dir_all(self.state.run_dir(&job_id));
        let _ = self
            .out
            .send(RunnerMsg::Released {
                job_id,
                kept,
                branch,
            })
            .await;
    }

    async fn assign(&self, a: Assignment) {
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
                running_job_ids: &ids,
                available_mb: crate::facts::memory().available_mb,
                claude_ready: inner.facts.claude == ToolState::SignedIn,
                codex_ready: inner.facts.codex == ToolState::SignedIn,
                ledger: &inner.ledger,
            },
        );
        let root = match checked {
            Ok(root) => root,
            Err(reason) => {
                drop(inner);
                eprintln!("job {}: refused ({reason:?})", a.job_id);
                let _ = self
                    .out
                    .send(RunnerMsg::Refused {
                        job_id: a.job_id,
                        part: a.part,
                        reason,
                    })
                    .await;
                return;
            }
        };
        if !a.own {
            let day = inner.ledger.day_of(now, inner.rules.utc_offset_minutes);
            inner.ledger.count_others_run(day);
            let _ = self.state.save_ledger(&inner.ledger);
        }
        let (tx, rx) = mpsc::channel(32);
        inner.running.insert(a.job_id.clone(), Running { tx });
        let ctx = PartContext {
            state: self.state.clone(),
            rules: inner.rules.clone(),
            machine_name: self.name.clone(),
            runner_exe: self.runner_exe.clone(),
            out: self.out.clone(),
        };
        drop(inner);

        eprintln!(
            "job {}: part {} started with {}",
            a.job_id,
            a.part,
            a.cli.name()
        );
        let me = self.clone();
        tokio::spawn(async move { me.run(ctx, a, root, rx).await });
    }

    async fn run(
        self,
        ctx: PartContext,
        a: Assignment,
        root: PathBuf,
        rx: mpsc::Receiver<RunInput>,
    ) {
        let (spent_tx, mut spent_rx) = mpsc::channel::<u64>(8);
        let me = self.clone();
        let own = a.own;
        let cli = a.cli;
        let counter = tokio::spawn(async move {
            while let Some(secs) = spent_rx.recv().await {
                let mut inner = me.inner.lock().await;
                let day = inner
                    .ledger
                    .day_of(now_ms(), inner.rules.utc_offset_minutes);
                inner.ledger.add_time(day, secs, own);
                let _ = me.state.save_ledger(&inner.ledger);
            }
        });
        let job_id = a.job_id.clone();
        let result = run::run_part(ctx, a, root, rx, spent_tx).await;
        let _ = counter.await;
        if result.error.as_deref() == Some("planLimit") {
            let mut inner = self.inner.lock().await;
            inner.ledger.pause(cli, now_ms() + 60 * 60_000);
            let _ = self.state.save_ledger(&inner.ledger);
        }
        if let Ok(bytes) = serde_json::to_vec(&result) {
            let _ = write_private(&run::result_path(&self.state, &job_id), &bytes);
        }
        self.inner.lock().await.running.remove(&job_id);
        eprintln!(
            "job {job_id}: part {} ended ({})",
            result.part,
            result.error.as_deref().unwrap_or("ok")
        );
        let _ = self.out.send(RunnerMsg::Result(result)).await;
        let status = self.status().await;
        let _ = self.out.send(RunnerMsg::Status(status)).await;
    }

    /// A plan-limit signal from a CLI: pause new work until the reset it
    /// names when the plan is used up, or nearly.
    pub async fn on_limit(&self, l: &LimitSignal) {
        let near = l.status == "rejected"
            || (l.status == "warning" && l.utilization.unwrap_or(0.0) >= PAUSE_AT);
        if let (true, Some(reset)) = (near, l.resets_at) {
            let mut inner = self.inner.lock().await;
            if inner.rules.pause_near_plan {
                inner.ledger.pause(l.cli, reset * 1000);
                let _ = self.state.save_ledger(&inner.ledger);
            }
        }
    }
}

/// How used a plan window must be before the machine stops taking work.
/// Claude Code warns from 75%; pausing there would idle a machine for days on
/// a weekly window, so the runner waits for 95% or a rejection.
pub const PAUSE_AT: f64 = 0.95;
