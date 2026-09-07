#!/usr/bin/env bash
# Redacts the one line electron-builder prints on every signed macOS build,
# unconditionally, at "info" level and with no flag to silence it:
#
#   signing file=… identityName=Developer ID Application: <company> (<team id>) identityHash=<sha1>
#
# `MacPackager.doSign()` in app-builder-lib logs that subject itself — the same
# one the certificate preflight in deploy-desktop.yml reads and deliberately
# never prints — so it reaches the log through a dependency rather than this
# repository's own code. This script is the one place that redacts it, read
# from stdin and written to stdout: `deploy-desktop.yml` pipes the Build
# step's combined output through it, and
# `apps/desktop/test/packaging.test.mjs` runs it directly against the exact
# line shape captured from a real signed run (with fake values) — the same
# process both places rely on, so the two cannot drift apart the way an
# inline `sed` copied into a test string once already did.
#
# ## Why this is `.*` and not `[^\n]*`
#
# The version this replaces used `[^\n]*` between `identityName=` and
# ` identityHash=`, on the theory that "not a newline" is the widest match
# sed can make within one line. It shipped invisibly broken: GNU sed (every
# developer machine, and this very workflow's own Linux-hosted checks)
# extends `\n` inside a bracket expression to mean an actual newline
# character, so `[^\n]*` there really did mean "the rest of the line". BSD
# sed — `/usr/bin/sed` on the `macos-latest` runner this workflow actually
# signs on — does not carry that GNU extension; POSIX leaves `\n` inside
# `[...]` unspecified, and BSD's regex library resolves it to the literal
# letter `n`. So on the one platform this ever runs on for a signed build,
# `[^\n]*` meant "any character that is not the letter n" — which stops at
# the very first `n` in "Developer ID Applicatio[n]", well short of
# ` identityHash=`, and the whole pattern fails to match. A `sed` substitution
# that cannot match a line leaves it untouched, so the identity and team id
# went through twice, unredacted, into a run's public log.
#
# `.` needs no such extension on either sed: within a single line of the
# pattern space (nothing here reads multiple lines with `N`), it matches any
# character, the same way, everywhere. There is exactly one
# ` identityHash=<hex>` per line this ever sees, so greedy `.*` backtracking
# to the only place the rest of the pattern can match lands on the right text
# regardless of engine.
set -euo pipefail
sed -E 's/(identityName=).*( identityHash=)[0-9A-Fa-f]+/\1[redacted]\2[redacted]/'
