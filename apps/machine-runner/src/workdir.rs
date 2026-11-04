//! Where a job works: a fresh git worktree or an empty scratch folder, always
//! under the allowed folder, never in the person's own checkout or their home.
//!
//! A run starts clean so it never executes hooks or MCP servers a cloned repo
//! brought with it unless the owner trusted that repo (`claude.rs`). Parts of
//! one job share the folder, so the session resumes where it left off. When
//! a run ends, a worktree with no new commits and no changes is
//! removed with its branch; one with work in it is kept for the person.

use anyhow::{bail, Context, Result};
use std::path::{Path, PathBuf};
use tokio::process::Command;

/// The folder all job folders live in, inside an allowed folder.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Workdir {
    Worktree,
    Scratch,
}

/// `owner/name` from a repository's origin remote, for the facts and for
/// finding the repo an assignment names.
pub fn origin_repo(dir: &Path) -> Option<String> {
    let out = std::process::Command::new("git")
        .arg("-C")
        .arg(dir)
        .args(["remote", "get-url", "origin"])
        .stdin(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .output()
        .ok()?;
    repo_from_url(String::from_utf8_lossy(&out.stdout).trim())
}

/// `git@github.com:Supa-Media/context.git` and
/// `https://github.com/Supa-Media/context` are both `Supa-Media/context`.
pub fn repo_from_url(url: &str) -> Option<String> {
    let path = url.trim_end_matches('/').trim_end_matches(".git");
    let mut parts = path.rsplit(['/', ':']);
    let name = parts.next()?;
    let owner = parts.next()?;
    (!name.is_empty() && !owner.is_empty() && !owner.contains('@'))
        .then(|| format!("{owner}/{name}"))
}

/// The repository an assignment names, under its folder: the folder itself or
/// one or two levels down, matched by origin (`owner/name`) or folder name.
/// Only ever inside the allowed root.
pub fn find_repo(root: &Path, folder: &Path, repo: &str) -> Option<PathBuf> {
    let short = repo.rsplit('/').next().unwrap_or(repo);
    let matches = |dir: &Path| {
        dir.join(".git").exists()
            && (origin_repo(dir).is_some_and(|o| o.eq_ignore_ascii_case(repo))
                || dir
                    .file_name()
                    .is_some_and(|n| n.to_string_lossy().eq_ignore_ascii_case(short)))
    };
    let mut queue = vec![(folder.to_path_buf(), 0)];
    while let Some((dir, depth)) = queue.pop() {
        if matches(&dir) {
            let real = std::fs::canonicalize(&dir).ok()?;
            return real.starts_with(root).then_some(real);
        }
        if depth < 2 {
            for e in std::fs::read_dir(&dir).into_iter().flatten().flatten() {
                let p = e.path();
                if p.is_dir() && !e.file_name().to_string_lossy().starts_with('.') {
                    queue.push((p, depth + 1));
                }
            }
        }
    }
    None
}

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
            let branch = branch_name(job_id);
            let at = dir.display().to_string();
            // A branch left from an earlier part is picked up again.
            if git(&top, &["worktree", "add", "-b", &branch, &at, "HEAD"])
                .await
                .is_err()
            {
                git(&top, &["worktree", "add", &at, &branch]).await?;
            }
            // Where the job started, so release can tell whether it made commits.
            if let (Ok(base), Ok(gd)) = (
                git(&dir, &["rev-parse", "HEAD"]).await,
                git(&dir, &["rev-parse", "--absolute-git-dir"]).await,
            ) {
                let _ =
                    tokio::fs::write(PathBuf::from(gd.trim()).join(BASE_FILE), base.trim()).await;
            }
        }
    }
    Ok(dir)
}

const BASE_FILE: &str = "context-machine-base";

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
pub async fn settle(root: &Path, job_id: &str) -> Result<Released> {
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
        let base = match git(&dir, &["rev-parse", "--absolute-git-dir"]).await {
            Ok(gd) => tokio::fs::read_to_string(PathBuf::from(gd.trim()).join(BASE_FILE))
                .await
                .unwrap_or_default(),
            Err(_) => String::new(),
        };
        // No recorded start: keep it, rather than guess and lose work.
        let ahead = base.trim().is_empty()
            || git(
                &dir,
                &["rev-list", "--count", &format!("{}..HEAD", base.trim())],
            )
            .await
            .map(|n| n.trim() != "0")
            .unwrap_or(true);
        if dirty || ahead {
            return Ok(Released::Kept(Some(branch)));
        }
        // The branch lives in the repository, which may sit below the root.
        let common = git(
            &dir,
            &["rev-parse", "--path-format=absolute", "--git-common-dir"],
        )
        .await?;
        let repo_git = PathBuf::from(common.trim());
        git(
            &dir,
            &["worktree", "remove", "--force", &dir.display().to_string()],
        )
        .await?;
        let _ = git_in(&repo_git, &["branch", "-D", &branch]).await;
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
    run_git(Command::new("git").arg("-C").arg(dir), args).await
}

async fn git_in(git_dir: &Path, args: &[&str]) -> Result<String> {
    run_git(Command::new("git").arg("--git-dir").arg(git_dir), args).await
}

async fn run_git(cmd: &mut Command, args: &[&str]) -> Result<String> {
    let out = cmd
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
        assert_eq!(settle(&r, "job_1").await.unwrap(), Released::Removed);
        assert!(!wt.exists());
    }

    #[tokio::test]
    async fn a_repo_below_the_root_loses_its_branch_too() {
        let d = tempfile::tempdir().unwrap();
        let root = std::fs::canonicalize(d.path()).unwrap();
        let r = root.join("code/repo");
        std::fs::create_dir_all(&r).unwrap();
        repo(&r).await;
        prepare(&root, &r, "job_b", Workdir::Worktree)
            .await
            .unwrap();
        assert_eq!(settle(&root, "job_b").await.unwrap(), Released::Removed);
        let branches = git(&r, &["branch", "--list", "tex/*"]).await.unwrap();
        assert!(branches.trim().is_empty(), "branch left behind: {branches}");
        // A later part makes it again.
        prepare(&root, &r, "job_b", Workdir::Worktree)
            .await
            .unwrap();
    }

    #[tokio::test]
    async fn a_worktree_with_work_is_kept() {
        let d = tempfile::tempdir().unwrap();
        let r = std::fs::canonicalize(d.path()).unwrap();
        repo(&r).await;
        let wt = prepare(&r, &r, "job_2", Workdir::Worktree).await.unwrap();
        std::fs::write(wt.join("new.txt"), "x").unwrap();
        assert_eq!(
            settle(&r, "job_2").await.unwrap(),
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

    #[test]
    fn repo_names_from_remotes() {
        assert_eq!(
            repo_from_url("git@github.com:Supa-Media/context.git").as_deref(),
            Some("Supa-Media/context")
        );
        assert_eq!(
            repo_from_url("https://github.com/Supa-Media/context/").as_deref(),
            Some("Supa-Media/context")
        );
        assert_eq!(repo_from_url("context"), None);
    }

    #[tokio::test]
    async fn find_repo_stays_inside_the_root() {
        let d = tempfile::tempdir().unwrap();
        let root = std::fs::canonicalize(d.path()).unwrap();
        let r = root.join("org/context");
        std::fs::create_dir_all(&r).unwrap();
        repo(&r).await;
        assert_eq!(
            find_repo(&root, &root, "Supa-Media/context"),
            Some(r.clone())
        );
        assert_eq!(find_repo(&root, &root, "other"), None);
        let elsewhere = tempfile::tempdir().unwrap();
        assert_eq!(find_repo(elsewhere.path(), &root, "context"), None);
    }

    #[tokio::test]
    async fn scratch_folders() {
        let d = tempfile::tempdir().unwrap();
        let r = d.path();
        let s = prepare(r, r, "job_4", Workdir::Scratch).await.unwrap();
        assert!(s.is_dir());
        assert_eq!(settle(r, "job_4").await.unwrap(), Released::Removed);
        let s = prepare(r, r, "job_5", Workdir::Scratch).await.unwrap();
        std::fs::write(s.join("out.md"), "x").unwrap();
        assert_eq!(settle(r, "job_5").await.unwrap(), Released::Kept(None));
    }
}
