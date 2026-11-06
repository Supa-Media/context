//! Where a job's Claude Code or Codex starts: plainly, in the person's own
//! folder, as if they had opened a terminal there and typed `claude` (owner,
//! 2026-11-04: "I want to use it as a way to run claude code remotely ... if I
//! started claude code in any directory it pretty much can do anything").
//!
//! When the job names a repository that is already under the folder, the tool
//! starts in that checkout. When it is not, the tool starts in the folder
//! itself and is told the name, so it can clone it there; a missing repo never
//! stops a run. Nothing is copied, no worktree or branch is made, and nothing
//! is removed when the run ends.

use std::path::{Path, PathBuf};

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

/// Where the tool starts, and whether the named repository was found there.
/// Always inside the allowed root: a checkout that resolves outside it is not
/// used, and the tool starts in the folder instead.
pub fn start_dir(root: &Path, folder: &Path, repo: Option<&str>) -> (PathBuf, bool) {
    match repo.and_then(|name| find_repo(root, folder, name)) {
        Some(dir) => (dir, true),
        None => (folder.to_path_buf(), false),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn repo(dir: &Path) {
        std::fs::create_dir_all(dir).unwrap();
        assert!(std::process::Command::new("git")
            .arg("-C")
            .arg(dir)
            .args(["init", "-q", "-b", "main"])
            .status()
            .unwrap()
            .success());
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

    #[test]
    fn find_repo_stays_inside_the_root() {
        let d = tempfile::tempdir().unwrap();
        let root = std::fs::canonicalize(d.path()).unwrap();
        let r = root.join("org/context");
        repo(&r);
        assert_eq!(
            find_repo(&root, &root, "Supa-Media/context"),
            Some(r.clone())
        );
        assert_eq!(find_repo(&root, &root, "other"), None);
        let elsewhere = tempfile::tempdir().unwrap();
        assert_eq!(find_repo(elsewhere.path(), &root, "context"), None);
    }

    #[test]
    fn a_named_repo_under_the_folder_is_where_the_tool_starts() {
        let d = tempfile::tempdir().unwrap();
        let root = std::fs::canonicalize(d.path()).unwrap();
        let r = root.join("context");
        repo(&r);
        assert_eq!(start_dir(&root, &root, Some("context")), (r, true));
    }

    // 2026-11-04: the only allowed folder was an empty `tex-files`, the job
    // named `context`, and all 96 parts failed "repo not found in the folder"
    // before Claude Code started. A missing repo now starts the tool in the
    // folder, where it can clone it.
    #[test]
    fn a_missing_repo_starts_the_tool_in_the_folder_instead_of_failing() {
        let d = tempfile::tempdir().unwrap();
        let root = std::fs::canonicalize(d.path()).unwrap();
        assert_eq!(
            start_dir(&root, &root, Some("context")),
            (root.clone(), false)
        );
        assert_eq!(start_dir(&root, &root, None), (root, false));
    }

    #[test]
    fn nothing_is_made_in_the_folder() {
        let d = tempfile::tempdir().unwrap();
        let root = std::fs::canonicalize(d.path()).unwrap();
        start_dir(&root, &root, Some("context"));
        assert_eq!(std::fs::read_dir(&root).unwrap().count(), 0);
    }
}
