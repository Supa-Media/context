/**
 * The desktop updater with Electron swapped for a fake.
 *
 * `updatePolicy.test.mjs` owns the state machine and `appShell.test.mjs` owns
 * menu wiring. This file owns the imperative edge between them: a person clicks
 * "Check for Updates..." and receives a definite outcome, without waiting six
 * hours and without exposing release URLs or credential-looking strings in
 * logs.
 */

import { DesktopUpdater } from "../src/main/updater.ts";

class FakeAutoUpdater {
  autoDownload = false;
  autoInstallOnAppQuit = false;
  checks = 0;
  installs = 0;
  nextCheck = Promise.resolve(null);
  listeners = new Map();

  on(event, listener) {
    const listeners = this.listeners.get(event) ?? [];
    listeners.push(listener);
    this.listeners.set(event, listeners);
  }

  emit(event, payload) {
    for (const listener of this.listeners.get(event) ?? []) listener(payload);
  }

  checkForUpdates() {
    this.checks += 1;
    return this.nextCheck;
  }

  quitAndInstall() {
    this.installs += 1;
  }
}

function harness(options = {}) {
  const fake = new FakeAutoUpdater();
  const logs = [];
  const states = [];
  let capturing = options.capturing ?? false;
  const updater = new DesktopUpdater({
    packaged: options.packaged ?? true,
    signed: options.signed ?? true,
    capturing: () => capturing,
    onStateChange: (state) => states.push(state),
    log: (message) => logs.push(message),
    now: () => options.now ?? 0,
    updater: fake,
  });
  return {
    fake,
    logs,
    states,
    updater,
    setCapturing(next) {
      capturing = next;
    },
  };
}

export async function runUpdaterBehaviorChecks(check) {
  {
    const { updater, fake } = harness();
    const result = updater.checkNow();
    check("a manual check before start reports startup rather than doing nothing", result.started === false && result.outcome.type === "not-started");
    check("a pre-start manual check does not hit the network", fake.checks === 0);
  }

  {
    const { updater, fake } = harness({ packaged: false });
    updater.start();
    const result = updater.checkNow();
    check("an unsigned or unpackaged build reports updates as unavailable", result.started === false && result.outcome.type === "unarmed");
    check("an unarmed manual check does not call electron-updater", fake.checks === 0);
  }

  {
    const { updater, fake, states } = harness();
    updater.start();
    const result = updater.checkNow();
    check("a manual check starts immediately", result.started === true && fake.checks === 1);
    check("a manual check publishes checking before the updater answers", states.includes("checking"));
    fake.emit("update-not-available");
    check("a no-update event resolves the manual check as up-to-date", (await result.outcome).type === "no-update");
    check("after a no-update answer, the state returns to idle", updater.state === "idle");
  }

  {
    const { updater, fake } = harness();
    updater.start();
    const first = updater.checkNow();
    const second = updater.checkNow();
    check("a duplicate manual check is coalesced into an already-checking outcome", second.started === false && second.outcome.type === "checking");
    check("a duplicate manual check does not start a second network request", fake.checks === 1);
    fake.emit("update-not-available");
    check("the original manual check still receives the final no-update outcome", first.started === true && (await first.outcome).type === "no-update");
  }

  {
    const { updater, fake } = harness({ capturing: true });
    updater.start();
    const result = updater.checkNow();
    fake.emit("update-available", { version: "9.9.9" });
    fake.emit("update-downloaded", { version: "9.9.9" });
    const outcome = result.started ? await result.outcome : result.outcome;
    check("a downloaded update reports the version and recording deferral", outcome.type === "downloaded" && outcome.version === "9.9.9" && outcome.deferred === true);
    check("a deferred update still refuses to install while recording", updater.install() === false && fake.installs === 0);
  }

  {
    const { updater, fake, logs } = harness();
    const raw = new Error("GET https://github.com/Supa-Media/context/releases/latest-mac.yml?token=secret failed");
    raw.name = "https://github.com/Supa-Media/context/releases/latest-mac.yml?token=name-secret";
    raw.code = "ERR_UPDATER_TOKEN";
    fake.nextCheck = Promise.reject(raw);
    updater.start();
    const result = updater.checkNow();
    const outcome = result.started ? await result.outcome : result.outcome;
    check("a thrown updater error resolves the manual check as a safe failure", outcome.type === "error");
    check(
      "updater errors are sanitized in logs",
      logs.some((line) => line.includes("ERR_UPDATER_TOKEN")) &&
        logs.every((line) => !line.includes("https://") && !line.includes("secret")),
    );
  }
}
