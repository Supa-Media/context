//! Running the tool's process and feeding it mail, interrupts and cancels.
//!
//! Claude Code keeps one process for the run, reading user lines on stdin:
//! mail goes in as it arrives, an interrupt is its own control request. Codex
//! reads stdin once, so each turn is a process: mail waits for the turn to end
//! and becomes the next `exec resume`, an interrupt is SIGINT then the same.
//! Both start in their own process group so a cancel or a deadline stops
//! everything the agent started, not only the tool.

use crate::cli::CliEvent;
use crate::protocol::{
    Assign, Outcome, RunnerMsg, Said, SaidKind, Session, Step, TokenUsage, Tool, Usage,
};
use crate::run::{deliver_text, interrupt_text, save_record, RunInput, RunRecord, Spent};
use crate::state::State;
use std::path::PathBuf;
use std::process::Stdio;
use std::time::{Duration, Instant};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::{Child, ChildStdin, Command};
use tokio::sync::mpsc;

pub enum Driver {
    Claude {
        exe: PathBuf,
        args: Vec<String>,
        cwd: PathBuf,
        first: String,
    },
    Codex {
        exe: PathBuf,
        cwd: PathBuf,
        runner_exe: PathBuf,
        grant_file: PathBuf,
        endpoint: String,
        network: bool,
        read_only: bool,
        thread: Option<String>,
        first: String,
    },
}

#[derive(Debug)]
pub struct DriveOutcome {
    pub outcome: Outcome,
    pub answer: String,
    pub error: Option<String>,
}

/// How often spent time is handed to the ledger while a run goes.
const TICK: Duration = Duration::from_secs(30);

pub async fn drive(
    d: Driver,
    a: &Assign,
    mut inputs: mpsc::Receiver<RunInput>,
    out: &mpsc::Sender<RunnerMsg>,
    record: &mut RunRecord,
    state: &State,
    spent: mpsc::Sender<Spent>,
) -> DriveOutcome {
    let deadline =
        tokio::time::Instant::now() + Duration::from_millis(a.deadline.saturating_sub(now_ms()));
    let mut sink = Sink {
        a,
        out,
        record,
        state,
        spent,
        started: Instant::now(),
        last_tick: Instant::now(),
        answer: String::new(),
        tokens: TokenUsage::default(),
        codex_prev: (0, 0),
        unreported_tokens: 0,
    };
    let outcome = match d {
        Driver::Claude {
            exe,
            args,
            cwd,
            first,
        } => claude(exe, args, cwd, first, &mut inputs, deadline, &mut sink).await,
        Driver::Codex {
            exe,
            cwd,
            runner_exe,
            grant_file,
            endpoint,
            network,
            read_only,
            thread,
            first,
        } => {
            let spec = CodexSpec {
                exe,
                cwd,
                runner_exe,
                grant_file,
                endpoint,
                network,
                read_only,
            };
            codex(spec, thread, first, &mut inputs, deadline, &mut sink).await
        }
    };
    sink.tick(true).await;
    outcome
}

struct Sink<'a> {
    a: &'a Assign,
    out: &'a mpsc::Sender<RunnerMsg>,
    record: &'a mut RunRecord,
    state: &'a State,
    spent: mpsc::Sender<Spent>,
    started: Instant,
    last_tick: Instant,
    answer: String,
    tokens: TokenUsage,
    codex_prev: (u64, u64),
    unreported_tokens: u64,
}

impl Sink<'_> {
    fn usage(&self) -> Usage {
        Usage {
            run_id: self.a.run_id.clone(),
            wall_ms: self.started.elapsed().as_millis() as u64,
            tokens: Some(self.tokens.clone()),
            ..Default::default()
        }
    }

    /// The tool's words or thinking, for the chat's history: numbered with the steps, cut to what a frame carries,
    /// and best effort like a step (a full queue, offline, drops it).
    fn said(&mut self, kind: SaidKind, text: &str) {
        let text: String = text.trim().chars().take(4000).collect();
        if text.is_empty() {
            return;
        }
        self.record.last_step += 1;
        save_record(self.state, self.record);
        let _ = self.out.try_send(RunnerMsg::Said(Said {
            run_id: self.a.run_id.clone(),
            seq: self.record.last_step,
            kind,
            text,
            at: now_ms(),
        }));
    }

    /// Handles one event; returns the turn's end when it is one.
    async fn event(&mut self, ev: CliEvent) -> Option<(bool, Option<String>)> {
        match ev {
            CliEvent::Session(id) => {
                if !id.is_empty() && id != self.record.session {
                    self.record.session = id.clone();
                    save_record(self.state, self.record);
                    let _ = self
                        .out
                        .send(RunnerMsg::Session(Session {
                            run_id: self.a.run_id.clone(),
                            session: id,
                        }))
                        .await;
                }
            }
            CliEvent::Step(s) => {
                self.record.last_step += 1;
                save_record(self.state, self.record);
                let some = |v: String| Some(v).filter(|v| !v.is_empty());
                // Steps are best effort: a full queue (offline) drops them.
                let _ = self.out.try_send(RunnerMsg::Step(Step {
                    run_id: self.a.run_id.clone(),
                    seq: self.record.last_step,
                    tool: s.tool,
                    action: some(s.action),
                    target: some(s.target),
                    at: now_ms(),
                }));
            }
            CliEvent::Text(t) => {
                self.said(SaidKind::Text, &t);
                self.answer = t;
            }
            CliEvent::Thinking(t) => self.said(SaidKind::Thinking, &t),
            CliEvent::Usage {
                input,
                output,
                cache_read,
                cache_write,
                ..
            } => {
                let (input, output) = if self.a.tool == Tool::Codex {
                    let d = crate::codex::usage_delta(self.codex_prev, (input, output));
                    self.codex_prev = (input, output);
                    d
                } else {
                    (input, output)
                };
                let add = |v: &mut Option<u64>, n: u64| *v = Some(v.unwrap_or(0) + n);
                add(&mut self.tokens.input, input);
                add(&mut self.tokens.output, output);
                add(&mut self.tokens.cache_read, cache_read);
                add(&mut self.tokens.cache_write, cache_write);
                self.unreported_tokens += input + output;
                let _ = self.out.try_send(RunnerMsg::Usage(self.usage()));
            }
            CliEvent::Limit(l) => {
                let mut u = self.usage();
                u.plan_limited = Some(l.status == "rejected");
                u.plan_resets_at = l.resets_at.map(|s| s * 1000);
                u.plan_utilization = l.utilization.map(|x| x.clamp(0.0, 1.0));
                u.plan_window = l.window.map(|w| w.chars().take(32).collect());
                let _ = self.out.send(RunnerMsg::Usage(u)).await;
            }
            CliEvent::TurnDone { ok, text, error } => {
                if !text.trim().is_empty() {
                    self.answer = text;
                }
                return Some((ok, error));
            }
        }
        None
    }

    async fn tick(&mut self, force: bool) {
        let ms = self.last_tick.elapsed().as_millis() as u64;
        if ms > 0 && (force || ms >= TICK.as_millis() as u64) {
            self.last_tick = Instant::now();
            let _ = self
                .spent
                .send((ms, std::mem::take(&mut self.unreported_tokens)))
                .await;
        }
    }

    fn finish(&mut self, ok: bool, error: Option<String>) -> DriveOutcome {
        let outcome = match (ok, error.as_deref()) {
            (true, _) => Outcome::Finished,
            (false, Some("planLimit")) => Outcome::Limit,
            _ => Outcome::Failed,
        };
        DriveOutcome {
            outcome,
            answer: std::mem::take(&mut self.answer),
            error,
        }
    }
}

fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

fn spawn(
    exe: &PathBuf,
    args: &[String],
    cwd: &PathBuf,
    stdin: bool,
) -> std::io::Result<(Child, mpsc::Receiver<String>)> {
    let mut cmd = Command::new(exe);
    cmd.args(args)
        .current_dir(cwd)
        .stdin(if stdin { Stdio::piped() } else { Stdio::null() })
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .kill_on_drop(true);
    #[cfg(unix)]
    cmd.process_group(0);
    let mut child = cmd.spawn()?;
    let stdout = child.stdout.take().expect("piped stdout");
    let (tx, rx) = mpsc::channel(256);
    tokio::spawn(async move {
        let mut lines = BufReader::new(stdout).lines();
        while let Ok(Some(line)) = lines.next_line().await {
            if tx.send(line).await.is_err() {
                break;
            }
        }
    });
    Ok((child, rx))
}

/// Stops the tool and everything it started.
async fn kill_group(child: &mut Child) {
    #[cfg(unix)]
    if let Some(pid) = child.id() {
        // SAFETY: signalling our own child's process group.
        unsafe {
            libc::killpg(pid as i32, libc::SIGKILL);
        }
    }
    let _ = child.start_kill();
    let _ = child.wait().await;
}

fn sigint(child: &Child) {
    #[cfg(unix)]
    if let Some(pid) = child.id() {
        // SAFETY: signalling our own child.
        unsafe {
            libc::kill(pid as i32, libc::SIGINT);
        }
    }
}

async fn write_line(stdin: &mut Option<ChildStdin>, line: String) {
    if let Some(s) = stdin.as_mut() {
        if s.write_all(format!("{line}\n").as_bytes()).await.is_err() || s.flush().await.is_err() {
            *stdin = None;
        }
    }
}

fn ended(outcome: Outcome, error: &str) -> DriveOutcome {
    DriveOutcome {
        outcome,
        answer: String::new(),
        error: Some(error.into()),
    }
}

async fn claude(
    exe: PathBuf,
    args: Vec<String>,
    cwd: PathBuf,
    first: String,
    inputs: &mut mpsc::Receiver<RunInput>,
    deadline: tokio::time::Instant,
    sink: &mut Sink<'_>,
) -> DriveOutcome {
    let Ok((mut child, mut lines)) = spawn(&exe, &args, &cwd, true) else {
        return ended(Outcome::Failed, "the tool did not start");
    };
    let mut stdin = child.stdin.take();
    write_line(&mut stdin, crate::claude::user_line(&first)).await;
    let mut pending: Vec<String> = vec![];
    let mut after_interrupt: Option<String> = None;
    let mut last: Option<(bool, Option<String>)> = None;
    let mut tick = tokio::time::interval(TICK);
    loop {
        tokio::select! {
            line = lines.recv() => {
                let Some(line) = line else { break };
                for ev in crate::claude::parse(&line) {
                    if let Some(done) = sink.event(ev).await {
                        if let Some(text) = after_interrupt.take() {
                            // The interrupted turn ended; the same session reads the message next.
                            write_line(&mut stdin, crate::claude::user_line(&text)).await;
                        } else if !pending.is_empty() {
                            write_line(&mut stdin, crate::claude::user_line(&pending.join("\n\n"))).await;
                            pending.clear();
                        } else {
                            last = Some(done);
                            stdin = None; // EOF: the tool exits after its turn.
                        }
                    }
                }
            }
            input = inputs.recv() => match input {
                Some(RunInput::Mail(m)) => {
                    if stdin.is_some() { write_line(&mut stdin, crate::claude::user_line(&deliver_text(&m))).await } else { pending.push(deliver_text(&m)) }
                }
                Some(RunInput::Interrupt(i)) => {
                    if stdin.is_some() {
                        write_line(&mut stdin, crate::claude::interrupt_line(&i.message_id)).await;
                        after_interrupt = Some(interrupt_text(&i));
                    }
                }
                Some(RunInput::Cancel) | None => { kill_group(&mut child).await; return ended(Outcome::Cancelled, "cancelled"); }
            },
            _ = tokio::time::sleep_until(deadline) => { kill_group(&mut child).await; return ended(Outcome::Limit, "the run reached its deadline"); }
            _ = tick.tick() => sink.tick(false).await,
        }
    }
    let _ = child.wait().await;
    match last {
        Some((ok, error)) => sink.finish(ok, error),
        None => ended(Outcome::Failed, "the tool exited without an answer"),
    }
}

struct CodexSpec {
    exe: PathBuf,
    cwd: PathBuf,
    runner_exe: PathBuf,
    grant_file: PathBuf,
    endpoint: String,
    network: bool,
    read_only: bool,
}

async fn codex(
    spec: CodexSpec,
    mut thread: Option<String>,
    first: String,
    inputs: &mut mpsc::Receiver<RunInput>,
    deadline: tokio::time::Instant,
    sink: &mut Sink<'_>,
) -> DriveOutcome {
    let mut prompt = first;
    let mut tick = tokio::time::interval(TICK);
    loop {
        let args = crate::codex::args(&crate::codex::CodexPlan {
            workdir: &spec.cwd,
            resume_thread: thread.as_deref(),
            runner_exe: &spec.runner_exe,
            grant_file: &spec.grant_file,
            endpoint: &spec.endpoint,
            network: spec.network,
            read_only: spec.read_only,
            prompt: &prompt,
        });
        let Ok((mut child, mut lines)) = spawn(&spec.exe, &args, &spec.cwd, false) else {
            return ended(Outcome::Failed, "the tool did not start");
        };
        let mut pending: Vec<String> = vec![];
        let mut interrupted: Option<String> = None;
        let mut done: Option<(bool, Option<String>)> = None;
        loop {
            tokio::select! {
                line = lines.recv() => {
                    let Some(line) = line else { break };
                    for ev in crate::codex::parse(&line) {
                        if let CliEvent::Session(id) = &ev { thread = Some(id.clone()); }
                        if let Some(d) = sink.event(ev).await { done = Some(d); }
                    }
                }
                input = inputs.recv() => match input {
                    Some(RunInput::Mail(m)) => pending.push(deliver_text(&m)),
                    Some(RunInput::Interrupt(i)) => { interrupted = Some(interrupt_text(&i)); sigint(&child); }
                    Some(RunInput::Cancel) | None => { kill_group(&mut child).await; return ended(Outcome::Cancelled, "cancelled"); }
                },
                _ = tokio::time::sleep_until(deadline) => { kill_group(&mut child).await; return ended(Outcome::Limit, "the run reached its deadline"); }
                _ = tick.tick() => sink.tick(false).await,
            }
        }
        let _ = child.wait().await;
        if thread.is_none() {
            return ended(Outcome::Failed, "the tool exited before starting a session");
        }
        if let Some(text) = interrupted {
            prompt = text;
            continue;
        }
        match done {
            Some((true, _)) if !pending.is_empty() => prompt = pending.join("\n\n"),
            Some((ok, error)) => return sink.finish(ok, error),
            None => return ended(Outcome::Failed, "the tool exited without an answer"),
        }
    }
}
