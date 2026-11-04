//! The runner's own folder: its key, its grant, its rules and what it spent.
//!
//! `~/.context-machine` (or `$CONTEXT_MACHINE_DIR`), mode 0700. Secrets in it
//! (the machine's private key, the machine grant, each run's grant) are files
//! created 0600 and never put in argv, the environment or a log. A run's
//! grant files are deleted when the part ends, and any left by a crash are
//! swept at the next start.

use crate::limits::Ledger;
use crate::protocol::Rules;
use crate::rules::LocalLimits;
use anyhow::{bail, Context, Result};
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use base64::Engine;
use ed25519_dalek::{Signer, SigningKey};
use serde::{de::DeserializeOwned, Deserialize, Serialize};
use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};

/// The gateway. `context.lc` itself is the app's router, which does not carry
/// the machine routes (it answered `POST /machines/pair` with 405).
pub const DEFAULT_ENDPOINT: &str = "https://mcp.context.lc";

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Machine {
    pub machine_id: String,
    pub endpoint: String,
    pub name: String,
    /// Where the workspace object listens, from the approved pairing.
    pub socket_url: String,
}

#[derive(Clone)]
pub struct State {
    pub dir: PathBuf,
}

impl State {
    pub fn open(dir_override: Option<PathBuf>) -> Result<State> {
        let dir = match dir_override
            .or_else(|| std::env::var_os("CONTEXT_MACHINE_DIR").map(PathBuf::from))
        {
            Some(d) => d,
            None => crate::rules::home_dir()
                .context("HOME is not set")?
                .join(".context-machine"),
        };
        make_private_dir(&dir)?;
        make_private_dir(&dir.join("runs"))?;
        Ok(State { dir })
    }

    pub fn runs_dir(&self) -> PathBuf {
        self.dir.join("runs")
    }

    pub fn run_dir(&self, job_id: &str) -> PathBuf {
        self.runs_dir().join(job_id)
    }

    /// The machine's key pair, made on first use. The private half never
    /// leaves this file.
    pub fn signing_key(&self) -> Result<SigningKey> {
        let path = self.dir.join("key");
        if let Ok(raw) = fs::read(&path) {
            check_private(&path)?;
            let bytes: [u8; 32] = URL_SAFE_NO_PAD
                .decode(String::from_utf8_lossy(&raw).trim())
                .ok()
                .and_then(|b| b.try_into().ok())
                .context(
                    "the machine key file is damaged; run `context-machine forget` and pair again",
                )?;
            return Ok(SigningKey::from_bytes(&bytes));
        }
        let key = SigningKey::generate(&mut rand::rngs::OsRng);
        write_private(&path, URL_SAFE_NO_PAD.encode(key.to_bytes()).as_bytes())?;
        Ok(key)
    }

    pub fn public_key(&self) -> Result<String> {
        Ok(URL_SAFE_NO_PAD.encode(self.signing_key()?.verifying_key().to_bytes()))
    }

    pub fn sign(&self, nonce: &str) -> Result<String> {
        Ok(URL_SAFE_NO_PAD.encode(self.signing_key()?.sign(nonce.as_bytes()).to_bytes()))
    }

    pub fn grant(&self, grant_file: Option<&Path>) -> Result<String> {
        let path = grant_file
            .map(Path::to_path_buf)
            .unwrap_or_else(|| self.dir.join("grant"));
        check_private(&path).with_context(|| {
            format!(
                "no machine grant at {}; run `context-machine pair`",
                path.display()
            )
        })?;
        let g = fs::read_to_string(&path)?.trim().to_string();
        if g.is_empty() {
            bail!("the machine grant file is empty; run `context-machine pair`");
        }
        Ok(g)
    }

    pub fn save_grant(&self, grant: &str) -> Result<()> {
        write_private(&self.dir.join("grant"), grant.as_bytes())
    }

    pub fn machine(&self) -> Machine {
        self.read_json("machine.json").unwrap_or_default()
    }

    pub fn save_machine(&self, m: &Machine) -> Result<()> {
        self.write_json("machine.json", m)
    }

    pub fn rules(&self) -> Rules {
        self.read_json("rules.json").unwrap_or_default()
    }

    pub fn save_rules(&self, r: &Rules) -> Result<()> {
        self.write_json("rules.json", r)
    }

    pub fn local(&self) -> LocalLimits {
        self.read_json("local.json").unwrap_or_default()
    }

    pub fn ledger(&self) -> Ledger {
        self.read_json("ledger.json").unwrap_or_default()
    }

    pub fn save_ledger(&self, l: &Ledger) -> Result<()> {
        self.write_json("ledger.json", l)
    }

    /// Removes the key, the grant and every run's files: this machine is no
    /// longer paired. Spending history goes too.
    pub fn forget(&self) -> Result<()> {
        for name in ["grant", "key", "machine.json", "rules.json", "ledger.json"] {
            let _ = fs::remove_file(self.dir.join(name));
        }
        let _ = fs::remove_dir_all(self.runs_dir());
        Ok(())
    }

    /// Deletes grant files left by runs that never finished (a crash, a
    /// power cut). A `finally` cannot reach those.
    pub fn sweep_secrets(&self) -> usize {
        let mut removed = 0;
        for entry in fs::read_dir(self.runs_dir())
            .into_iter()
            .flatten()
            .flatten()
        {
            for secret in SECRET_FILES {
                if fs::remove_file(entry.path().join(secret)).is_ok() {
                    removed += 1;
                }
            }
        }
        removed
    }

    fn read_json<T: DeserializeOwned>(&self, name: &str) -> Option<T> {
        serde_json::from_slice(&fs::read(self.dir.join(name)).ok()?).ok()
    }

    fn write_json<T: Serialize>(&self, name: &str, v: &T) -> Result<()> {
        write_private(&self.dir.join(name), &serde_json::to_vec_pretty(v)?)
    }
}

/// Files in a run folder that hold a credential.
pub const SECRET_FILES: &[&str] = &["grant", "mcp.json"];

pub fn make_private_dir(dir: &Path) -> Result<()> {
    fs::create_dir_all(dir).with_context(|| format!("cannot create {}", dir.display()))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(dir, fs::Permissions::from_mode(0o700))?;
    }
    Ok(())
}

/// Writes a file that only this user can read, atomically: created 0600 under
/// a temporary name, then renamed, so it is never readable by others even for
/// a moment and never half-written.
pub fn write_private(path: &Path, bytes: &[u8]) -> Result<()> {
    let tmp = path.with_extension(format!("tmp-{}", std::process::id()));
    let _ = fs::remove_file(&tmp);
    let mut opts = fs::OpenOptions::new();
    opts.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        opts.mode(0o600);
    }
    let mut f = opts
        .open(&tmp)
        .with_context(|| format!("cannot write {}", tmp.display()))?;
    f.write_all(bytes)?;
    f.sync_all()?;
    fs::rename(&tmp, path)?;
    Ok(())
}

/// Refuses a secret file that others could read.
pub fn check_private(path: &Path) -> Result<()> {
    let meta = fs::metadata(path)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        if meta.permissions().mode() & 0o077 != 0 {
            bail!(
                "{} can be read by other users; it must be mode 0600",
                path.display()
            );
        }
    }
    let _ = meta;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn secrets_are_written_0600_and_checked() {
        let d = tempfile::tempdir().unwrap();
        let s = State::open(Some(d.path().join("s"))).unwrap();
        s.save_grant("g-123").unwrap();
        assert_eq!(s.grant(None).unwrap(), "g-123");
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = fs::metadata(s.dir.join("grant"))
                .unwrap()
                .permissions()
                .mode();
            assert_eq!(mode & 0o777, 0o600);
            assert_eq!(
                fs::metadata(&s.dir).unwrap().permissions().mode() & 0o777,
                0o700
            );
            fs::set_permissions(s.dir.join("grant"), fs::Permissions::from_mode(0o644)).unwrap();
            assert!(s.grant(None).is_err());
        }
    }

    #[test]
    fn the_key_is_stable_and_signs() {
        let d = tempfile::tempdir().unwrap();
        let s = State::open(Some(d.path().to_path_buf())).unwrap();
        let pk = s.public_key().unwrap();
        assert_eq!(pk, s.public_key().unwrap());
        let sig = URL_SAFE_NO_PAD.decode(s.sign("nonce").unwrap()).unwrap();
        let vk = s.signing_key().unwrap().verifying_key();
        let sig = ed25519_dalek::Signature::from_slice(&sig).unwrap();
        assert!(vk.verify_strict(b"nonce", &sig).is_ok());
        assert!(vk.verify_strict(b"other", &sig).is_err());
    }

    #[test]
    fn the_sweep_removes_grants_left_by_a_crash() {
        let d = tempfile::tempdir().unwrap();
        let s = State::open(Some(d.path().to_path_buf())).unwrap();
        make_private_dir(&s.run_dir("job")).unwrap();
        write_private(&s.run_dir("job").join("grant"), b"x").unwrap();
        write_private(&s.run_dir("job").join("mcp.json"), b"x").unwrap();
        write_private(&s.run_dir("job").join("state.json"), b"{}").unwrap();
        assert_eq!(s.sweep_secrets(), 2);
        assert!(s.run_dir("job").join("state.json").exists());
    }

    #[test]
    fn forget_removes_the_key_and_grant() {
        let d = tempfile::tempdir().unwrap();
        let s = State::open(Some(d.path().to_path_buf())).unwrap();
        s.public_key().unwrap();
        s.save_grant("g").unwrap();
        s.forget().unwrap();
        assert!(!s.dir.join("key").exists() && !s.dir.join("grant").exists());
    }
}
