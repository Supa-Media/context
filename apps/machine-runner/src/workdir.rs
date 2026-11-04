//! Where a job works: a fresh git worktree or an empty scratch folder, always
//! under the allowed folder, never in the person's own checkout or their home.
//!
//! A run starts clean so it never executes hooks or MCP servers a cloned repo
//! brought with it unless the owner trusted that repo (`claude.rs`). Parts of
//! one job share the folder, so the session resumes where it left off. When
//! the job is released, a worktree with no new commits and no changes is
//! removed with its branch; one with work in it is kept for the person.

use crate::protocol::Workdir;
use anyhow::{bail, Context, Result};
use std::path::{Path, PathBuf};
use tokio::process::Command;

/// The folder all job folders live in, inside an allowed folder.
pub const WORK_DIR_NAME: &str = ".context-machine-work";

pub fn job_dir(root: &Path, job_id: &str) -> PathBuf {
    root.join(WORK_DIR_NAME).join(job_id)
}

pub fn branch_name(job_id: &str) -> String {
    format!("tex/{}", job_id.replace(':', "-"))
}

/// Makes (or finds again, for a later part) the job's folder.
pub async fn prepare(root: &Path, folder: &Path, job_id: &str, kind: Workdir) -> Result<PathBuf> {
    let dir = job_dir(root, job_id);
    if dir.exists() {
        return Ok(dir);
    }
    tokio::fs::create_dir_all(dir.parent().unwrap()).await?;
    match kind {
        Workdir::Scratch => {
            tokio::fs::create_dir_all(&dir).await?;
        }
        Workdir::Worktree => {
            let top = git(folder, &["rev-parse", "--show-toplevel"])
                .await
                .context("the folder is not a git repository")?;
            let top = PathBuf::from(top.trim());
            let top = std::fs::canonicalize(&top)?;
            if !top.starts_with(root) {
                bail!("the repository reaches outside the allowed folder");
            }
            exclude_work_dir(&top).await;
            git(
                &top,
                &[
                    "worktree",
                    "add",
                    "-b",
                    &branch_name(job_id),
                    &dir.display().to_string(),
                    "HEAD",
                ],
            )
            .await?;
        }
    }
    Ok(dir)
}

/// When the allowed folder is the repository itself, keep the job folders out
/// of `git status`.
async fn exclude_work_dir(top: &Path) {
    let Ok(common) = git(top, &["rev-parse", "--git-common-dir"]).await else {
        return;
    };
    let common = top.join(common.trim());
    let exclude = common.join("info").join("exclude");
    let line = format!("/{WORK_DIR_NAME}/");
    let current = tokio::fs::read_to_string(&exclude)
        .await
        .unwrap_or_default();
    if !current.lines().any(|l| l.trim() == line) {
        let _ = tokio::fs::create_dir_all(exclude.parent().unwrap()).await;
        let _ = tokio::fs::write(
            &exclude,
            format!(
                "{current}{}{line}\n",
                if current.ends_with('\n') || current.is_empty() {
                    ""
                } else {
                    "\n"
                }
            ),
        )
        .await;
    }
}

/// What release did with the folder.
#[derive(Debug, PartialEq, Eq)]
pub enum Released {
    Removed,
    /// Kept because it holds work, on this branch.
    Kept(Option<String>),
    Missing,
}

/// The job is over: remove its folder unless it holds work.
pub async fn release(root: &Path, job_id: &str) -> Result<Released> {
    let dir = job_dir(root, job_id);
    if !dir.exists() {
        return Ok(Released::Missing);
    }
    if dir.join(".git").exists() {
        let branch = branch_name(job_id);
        let dirty = !git(&dir, &["status", "--porcelain"])
            .await?
            .trim()
            .is_empty();
        let ahead = git(
            &dir,
            &[
                "rev-list",
                "--count",
                "HEAD",
                "--not",
                "--remotes",
                "--exclude",
                &format!("refs/heads/{branch}"),
                "--branches",
            ],
        )
        .await
        .map(|n| n.trim() != "0")
        .unwrap_or(true);
        if dirty || ahead {
            return Ok(Released::Kept(Some(branch)));
        }
        git(
            &dir,
            &["worktree", "remove", "--force", &dir.display().to_string()],
        )
        .await?;
        let _ = git(root, &["branch", "-D", &branch]).await;
        return Ok(Released::Removed);
    }
    let empty = std::fs::read_dir(&dir)
        .map(|mut d| d.next().is_none())
        .unwrap_or(true);
    if empty {
        tokio::fs::remove_dir_all(&dir).await?;
        return Ok(Released::Removed);
    }
    Ok(Released::Kept(None))
}

async fn git(dir: &Path, args: &[&str]) -> Result<String> {
    let out = Command::new("git")
        .arg("-C")
        .arg(dir)
        .args(args)
        .stdin(std::process::Stdio::null())
        .output()
        .await?;
    if !out.status.success() {
        bail!("git {} failed", args.first().unwrap_or(&""));
    }
    Ok(String::from_utf8_lossy(&out.stdout).to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    async fn repo(dir: &Path) {
        for args in [
            vec!["init", "-q", "-b", "main"],
            vec![
                "-c",
                "user.email=t@example.com",
                "-c",
                "user.name=t",
                "commit",
                "-q",
                "--allow-empty",
                "-m",
                "init",
            ],
        ] {
            assert!(Command::new("git")
                .arg("-C")
                .arg(dir)
                .args(&args)
                .status()
                .await
                .unwrap()
                .success());
        }
    }

    #[tokio::test]
    async fn a_worktree_is_made_under_the_allowed_folder_and_removed_when_clean() {
        let d = tempfile::tempdir().unwrap();
        let root = std::fs::canonicalize(d.path()).unwrap();
        let r = root.join("repo");
        std::fs::create_dir_all(&r).unwrap();
        repo(&r).await;
        let wt = prepare(&r, &r, "job_1", Workdir::Worktree).await.unwrap();
        assert!(wt.starts_with(&r) && wt.join(".git").exists());
        let status = git(&r, &["status", "--porcelain"]).await.unwrap();
        assert!(
            status.trim().is_empty(),
            "work dir shows in git status: {status}"
        );
        // A second part finds the same folder.
        assert_eq!(
            prepare(&r, &r, "job_1", Workdir::Worktree).await.unwrap(),
            wt
        );
        assert_eq!(release(&r, "job_1").await.unwrap(), Released::Removed);
        assert!(!wt.exists());
    }

    #[tokio::test]
    async fn a_worktree_with_work_is_kept() {
        let d = tempfile::tempdir().unwrap();
        let r = std::fs::canonicalize(d.path()).unwrap();
        repo(&r).await;
        let wt = prepare(&r, &r, "job_2", Workdir::Worktree).await.unwrap();
        std::fs::write(wt.join("new.txt"), "x").unwrap();
        assert_eq!(
            release(&r, "job_2").await.unwrap(),
            Released::Kept(Some("tex/job_2".into()))
        );
    }

    #[tokio::test]
    async fn a_repository_reaching_outside_the_allowed_folder_is_refused() {
        let d = tempfile::tempdir().unwrap();
        let top = std::fs::canonicalize(d.path()).unwrap();
        repo(&top).await;
        let inner = top.join("sub");
        std::fs::create_dir_all(&inner).unwrap();
        // The allowed folder is a subfolder, but the repository is its parent.
        assert!(prepare(&inner, &inner, "job_3", Workdir::Worktree)
            .await
            .is_err());
    }

    #[tokio::test]
    async fn scratch_folders() {
        let d = tempfile::tempdir().unwrap();
        let r = d.path();
        let s = prepare(r, r, "job_4", Workdir::Scratch).await.unwrap();
        assert!(s.is_dir());
        assert_eq!(release(r, "job_4").await.unwrap(), Released::Removed);
        let s = prepare(r, r, "job_5", Workdir::Scratch).await.unwrap();
        std::fs::write(s.join("out.md"), "x").unwrap();
        assert_eq!(release(r, "job_5").await.unwrap(), Released::Kept(None));
    }
}
