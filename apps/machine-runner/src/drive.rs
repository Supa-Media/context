//! Running the CLI process and feeding it mail, interrupts and cancels.
//!
//! Claude Code keeps one process for the part, reading user lines on stdin:
//! mail goes in as it arrives, an interrupt is its own control request. Codex
//! reads stdin once, so each turn is a process: mail waits for the turn to end
//! and becomes the next `exec resume`, an interrupt is SIGINT then the same.
//! Both are started in their own process group so a cancel or a deadline
//! stops everything the agent started, not only the CLI.

use crate::cli::CliEvent;
use crate::protocol::{Assignment, Cli, RunnerMsg, Step, Usage};
use crate::run::{mail_text, save_record, RunInput, RunRecord};
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
        bypass: bool,
        thread: Option<String>,
        first: String,
    },
}

#[derive(Debug, Default)]
pub struct DriveOutcome {
    pub ok: bool,
    pub answer: String,
    pub error: Option<String>,
}

/// How often spent time is handed to the ledger while a part runs.
const TICK: Duration = Duration::from_secs(30);

pub async fn drive(
    d: Driver,
    a: &Assignment,
    mut inputs: mpsc::Receiver<RunInput>,
    out: &mpsc::Sender<RunnerMsg>,
    record: &mut RunRecord,
    state: &State,
    spent: mpsc::Sender<u64>,
) -> DriveOutcome {
    let deadline =
        tokio::time::Instant::now() + Duration::from_millis(a.deadline_at.saturating_sub(now_ms()));
    let mut sink = Sink {
        a,
        out,
        record,
        state,
        spent,
        last_tick: Instant::now(),
        answer: String::new(),
        usage_prev: (0, 0),
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
            bypass,
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
                bypass,
            };
            codex(spec, thread, first, &mut inputs, deadline, &mut sink).await
        }
    };
    sink.tick(true).await;
    outcome
}

struct Sink<'a> {
    a: &'a Assignment,
    out: &'a mpsc::Sender<RunnerMsg>,
    record: &'a mut RunRecord,
    state: &'a State,
    spent: mpsc::Sender<u64>,
    last_tick: Instant,
    answer: String,
    usage_prev: (u64, u64),
}

impl Sink<'_> {
    /// Handles one event; returns the turn's end when it is one.
    async fn event(&mut self, ev: CliEvent) -> Option<(bool, Option<String>)> {
        match ev {
            CliEvent::Session(id) => {
                if !id.is_empty() && id != self.record.session_id {
                    self.record.session_id = id;
                    save_record(self.state, self.record);
                }
            }
            CliEvent::Step(s) => {
                self.record.last_step = Some(
                    format!("{} {} {}", s.tool, s.action, s.target)
                        .trim()
                        .to_string(),
                );
                save_record(self.state, self.record);
                // Steps are best effort: a full queue (offline) drops them.
                let _ = self.out.try_send(RunnerMsg::Step(Step {
                    job_id: self.a.job_id.clone(),
                    part: self.a.part,
                    tool: s.tool,
                    action: s.action,
                    target: s.target,
                }));
            }
            CliEvent::Text(t) => self.answer = t,
            CliEvent::Usage {
                input,
                output,
                cache_read,
                cache_write,
                model,
            } => {
                let (input, output) = if self.a.cli == Cli::Codex {
                    let d = crate::codex::usage_delta(self.usage_prev, (input, output));
                    self.usage_prev = (input, output);
                    d
                } else {
                    (input, output)
                };
                let _ = self.out.try_send(RunnerMsg::Usage(Usage {
                    job_id: self.a.job_id.clone(),
                    part: self.a.part,
                    input_tokens: input,
                    output_tokens: output,
                    cache_read_tokens: cache_read,
                    cache_write_tokens: cache_write,
                    model,
                }));
            }
            CliEvent::Limit(l) => {
                let _ = self.out.send(RunnerMsg::Limit(l)).await;
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
        let secs = self.last_tick.elapsed().as_secs();
        if secs > 0 && (force || secs >= TICK.as_secs()) {
            self.last_tick = Instant::now();
            let _ = self.spent.send(secs).await;
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

/// Stops the CLI and everything it started.
fn kill_group(child: &mut Child) {
    #[cfg(unix)]
    if let Some(pid) = child.id() {
        // SAFETY: signalling our own child's process group.
        unsafe {
            libc::killpg(pid as i32, libc::SIGKILL);
        }
    }
    let _ = child.start_kill();
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

fn ended(error: &str) -> DriveOutcome {
    DriveOutcome {
        ok: false,
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
        return ended("spawnFailed");
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
                            stdin = None; // EOF: the CLI exits after its turn.
                        }
                    }
                }
            }
            input = inputs.recv() => match input {
                Some(RunInput::Mail(m)) => {
                    if stdin.is_some() { write_line(&mut stdin, crate::claude::user_line(&mail_text(&m))).await } else { pending.push(mail_text(&m)) }
                }
                Some(RunInput::Interrupt { reason, mail }) => {
                    if stdin.is_some() {
                        write_line(&mut stdin, crate::claude::interrupt_line(&uuid::Uuid::new_v4().to_string())).await;
                        after_interrupt = Some(interrupt_text(&reason, mail.as_ref()));
                    }
                }
                Some(RunInput::Cancel) | None => { kill_group(&mut child); let _ = child.wait().await; return ended("cancelled"); }
            },
            _ = tokio::time::sleep_until(deadline) => { kill_group(&mut child); let _ = child.wait().await; return ended("timedOut"); }
            _ = tick.tick() => sink.tick(false).await,
        }
    }
    let _ = child.wait().await;
    match last {
        Some((ok, error)) => DriveOutcome {
            ok,
            answer: std::mem::take(&mut sink.answer),
            error,
        },
        None => ended("exited"),
    }
}

pub fn interrupt_text(reason: &str, mail: Option<&crate::protocol::Mail>) -> String {
    match mail {
        Some(m) => mail_text(m),
        None => format!("Tex interrupted you: {reason}. Read this first, then continue only if it still makes sense."),
    }
}

struct CodexSpec {
    exe: PathBuf,
    cwd: PathBuf,
    runner_exe: PathBuf,
    grant_file: PathBuf,
    endpoint: String,
    network: bool,
    bypass: bool,
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
            bypass: spec.bypass,
            prompt: &prompt,
        });
        let Ok((mut child, mut lines)) = spawn(&spec.exe, &args, &spec.cwd, false) else {
            return ended("spawnFailed");
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
                    Some(RunInput::Mail(m)) => pending.push(mail_text(&m)),
                    Some(RunInput::Interrupt { reason, mail }) => { interrupted = Some(interrupt_text(&reason, mail.as_ref())); sigint(&child); }
                    Some(RunInput::Cancel) | None => { kill_group(&mut child); let _ = child.wait().await; return ended("cancelled"); }
                },
                _ = tokio::time::sleep_until(deadline) => { kill_group(&mut child); let _ = child.wait().await; return ended("timedOut"); }
                _ = tick.tick() => sink.tick(false).await,
            }
        }
        let _ = child.wait().await;
        if thread.is_none() {
            return ended("exited");
        }
        if let Some(text) = interrupted {
            prompt = text;
            continue;
        }
        match done {
            Some((true, _)) if !pending.is_empty() => prompt = pending.join("\n\n"),
            Some((ok, error)) => {
                return DriveOutcome {
                    ok,
                    answer: std::mem::take(&mut sink.answer),
                    error,
                }
            }
            None => return ended("exited"),
        }
    }
}
