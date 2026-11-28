# The Lab's runner: GitHub's own runner image, plus what tex-lab-run.yml's run job
# calls beyond the actions it uses (jq, python3 and openssl seal and read its
# tokens). Node, pnpm and Claude Code come from the job's own steps.
FROM ghcr.io/actions/actions-runner:2.338.2

USER root
RUN apt-get update \
 && apt-get install -y --no-install-recommends jq python3 openssl curl git unzip xz-utils ca-certificates procps \
 && rm -rf /var/lib/apt/lists/*

USER runner
WORKDIR /home/runner
# One job, then the runner exits and the container stops. The configuration is
# GitHub's just-in-time one, good for this one runner only (src/index.ts).
CMD ["bash", "-c", "exec ./run.sh --jitconfig \"$RUNNER_JITCONFIG\""]
