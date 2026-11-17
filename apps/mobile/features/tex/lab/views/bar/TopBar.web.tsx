/**
 * The decluttered top bar's menus (mockup https://claude.ai/artifact/W21NekNf2vtnFLXXzAmp7N, approved by Dev2
 * 2026-11-16: "much cleaner"): one version picker that holds the versions, a new version, rename, Promote and how a
 * draft's changes are drawn; the Dev set score and a split ▶ Run Dev set whose menu picks the models; and ⋯ for the
 * look and the sync state. Everything here is also a tex_dev action (list, create, rename, promote, run, runs, code).
 */
import { useMutation, useQuery } from "convex/react";
import { api } from "@context/convex/_generated/api";
import { emit, isMain, lab, newVersion, openVersion, PLAY_SPEEDS, set, setSpeed, toast, type PlaySpeed } from "../../engine/state";
import { isLive, live } from "../../engine/live";
import { promoteVersion, useLab } from "../../store";
import { codeWords, scoreWords, setRunsUi, useRunsUi } from "../../engine/labRuns";
import { setLabTheme, THEMES, useLabTheme } from "../../theme.web";
import { ChangeToggles, LiveChanges } from "../LiveChanges.web";
import { StagePill, useRuns, useStartRun } from "../runs/Runs.web";
import { Pop } from "./Pop.web";
import { PromoteClashes } from "./PromoteClashes.web";

function Svg({ d, className = "i", style }: { d: string; className?: string; style?: React.CSSProperties }) {
  return <svg className={className} viewBox="0 0 24 24" style={style} dangerouslySetInnerHTML={{ __html: d }} />;
}

/** The version open, and every version, a new one, rename and Promote, in one menu. */
export function VersionMenu() {
  const s = useLab();
  const main = isMain();
  const unsaved = !main && !s.versions.some((v) => v.id === s.cur.id);
  return (
    <Pop
      id="verBtn"
      title="Versions"
      button={
        <>
          <Svg d='<path d="M6 4v10a4 4 0 0 0 4 4h8"/><circle cx="18" cy="18" r="1.6"/>' />
          <span id="verName">{s.cur.name}</span>
          <span className="car">▾</span>
        </>
      }
    >
      {(close) => (
        <div className="vmenu">
          <div className="mh">Versions</div>
          <div id="verList">
            {s.versions.map((v) => (
              <button
                key={v.id}
                className="mi"
                data-ver={v.id}
                aria-current={v.id === s.cur.id}
                onClick={() => {
                  openVersion(v.id);
                  close();
                }}
              >
                <span className="nm">{v.id === s.cur.id ? s.cur.name : v.name}</span>
                {v.id === "main" ? <span className="tag">live</span> : v.results?.length ? <span className="meta">{v.results.length + " run" + (v.results.length > 1 ? "s" : "")}</span> : null}
              </button>
            ))}
            {unsaved ? (
              <button className="mi" aria-current="true">
                <span className="nm">{s.cur.name}</span>
                <span className="meta">not saved</span>
              </button>
            ) : null}
          </div>
          <button
            className="mi"
            id="sideNewVer"
            onClick={() => {
              newVersion();
              close();
            }}
          >
            ＋ New version from main
          </button>
          <hr />
          {main ? (
            <div className="mnote">main is what Tex runs now. Make a new version to change it.</div>
          ) : (
            <>
              <label className="mrow">
                <span className="small muted">Name</span>
                <input
                  id="verRename"
                  className="vren"
                  aria-label="Version name"
                  spellCheck={false}
                  key={s.cur.id}
                  defaultValue={s.cur.name}
                  onChange={(e) => {
                    s.cur.name = e.target.value.trim() || s.cur.name;
                    set({ dirty: true });
                  }}
                />
              </label>
              <button
                className="mi"
                id="promoteBtn"
                disabled={s.dirty || s.cur.promote?.state === "asked"}
                title={s.cur.promote?.state === "refused" ? "Refused: " + (s.cur.promote.why ?? "") : s.dirty ? "Save first" : "Open the pull request that makes this version Tex's config"}
                onClick={() => void promoteVersion()}
              >
                {s.cur.promote?.state === "asked" ? "Promote asked" : "Promote"}
                <span className="meta">opens its pull request</span>
              </button>
              {s.cur.promote?.state === "opened" && s.cur.promote.pr ? (
                <a className="mi" id="promotePr" href={s.cur.promote.pr} target="_blank" rel="noreferrer">
                  Its pull request ↗
                </a>
              ) : null}
              <PromoteClashes key={`${s.cur.id}:${s.cur.promote?.state}:${s.cur.promote?.clashes?.length ?? 0}`} promote={s.cur.promote} dirty={s.dirty} onDone={close} />
              {s.view === "canvas" ? (
                <>
                  <hr />
                  <ChangeToggles />
                </>
              ) : null}
              {isLive() ? (
                <div className="mchanges">
                  <LiveChanges />
                </div>
              ) : null}
            </>
          )}
          <hr />
          <div className="mnote">{isLive() ? `rev ${live.rev} · ${s.dirty || live.inflight ? "saving" : "saved as you edit"}` : s.sync}</div>
        </div>
      )}
    </Pop>
  );
}

const SPEED_WORDS: Record<PlaySpeed, [string, string]> = {
  0.25: ["¼×", "Quarter speed"],
  0.5: ["½×", "Half speed"],
  1: ["1×", "Real time"],
  2: ["2×", "Twice as fast"],
  4: ["4×", "Four times as fast"],
};

/** The play speed of every playback and each new text, kept for the session (`lab.speed`); Tex itself runs at real speed. */
export function SpeedMenu() {
  const s = useLab();
  return (
    <Pop
      id="speedBtn"
      title="Play speed for every playback, kept for this session"
      button={
        <>
          <Svg d='<circle cx="12" cy="13" r="7"/><path d="M12 13l3-3M10 3h4"/>' />
          <span className="nm" id="speedName">
            {SPEED_WORDS[s.speed][0]}
          </span>
          <span className="car">▾</span>
        </>
      }
    >
      {(close) => (
        <div className="vmenu" id="speedMenu">
          <div className="mh">Play speed</div>
          {PLAY_SPEEDS.map((v) => (
            <button
              key={v}
              className="mi"
              data-speed={v}
              aria-current={v === s.speed}
              onClick={() => {
                setSpeed(v);
                close();
              }}
            >
              <span className="nm">{SPEED_WORDS[v][0]}</span>
              <span className="meta">
                {SPEED_WORDS[v][1]}
                {v === s.speed ? " ✓" : ""}
              </span>
            </button>
          ))}
          <hr />
          <div className="mnote">Every playback and each new text you send plays at this speed until you change it. Tex itself always runs at real speed.</div>
        </div>
      )}
    </Pop>
  );
}

/** The Dev set score of the version open (its runs in Testing), and ▶ Run Dev set with the models in its menu. */
export function RunSplit() {
  const runs = useRuns(lab.cur.id);
  const ui = useRunsUi();
  const go = useStartRun("lab");
  const dev = runs.find((r) => r.kind === "dev");
  const openRuns = (run?: string) => {
    setRunsUi({ open: true, ver: lab.cur.id, ...(run ? { run } : {}) });
    set({ mode: "testing", sel: null });
  };
  return (
    <span className="labrun" id="labRun">
      {dev ? (
        <button className="score" id="labOpenRuns" title="Last Dev set run on this version: open its details" onClick={() => openRuns(dev.id)}>
          {dev.stage === "done" ? <b>{scoreWords(dev)}</b> : <StagePill r={dev} />}
          <small>Dev set</small>
        </button>
      ) : null}
      <span className="split">
        <button className="primary" id="labRunDev" title="Runs every Dev set unit test on GitHub on this version" onClick={() => void go("dev", {}, lab.cur.id)}>
          ▶<span className="hide-xs"> Run</span><span className="hide-s"> Dev set</span>
        </button>
        <Pop id="runMore" label="Run options" className="primary more" right button={<span aria-hidden="true">▾</span>}>
          {(close) => (
            <div className="vmenu" id="runModels">
              <div className="mh">Models</div>
              <button className="mi" data-models="gw" aria-current={ui.models === "gw"} onClick={() => (setRunsUi({ models: "gw" }), close())}>
                As live Tex <span className="meta">AI gateway</span>
              </button>
              <button className="mi" data-models="cc" aria-current={ui.models === "cc"} onClick={() => (setRunsUi({ models: "cc" }), close())}>
                Claude Code token <span className="meta">GitHub</span>
              </button>
              <hr />
              <CodeField />
              <hr />
              <button className="mi" id="labAllRuns" onClick={() => (close(), openRuns())}>
                All runs <span className="meta">{runs.length}</span>
              </button>
            </div>
          )}
        </Pop>
      </span>
    </span>
  );
}

/**
 * The code a draft's runs check out (Dev2, 2026-11-16: "when we run things it should run on the PRs code instead of
 * main"): a pull request (#3401 or its address) or a branch of this repository, or main when empty. Main itself always
 * runs main's code. `tex_dev` `code` sets the same.
 */
export function CodeField() {
  const id = lab.cur.id;
  const main = id === "main";
  const asked = useQuery(api.functions.texLabRuns.codeFor, main ? "skip" : { versionId: id }) as unknown;
  const code = typeof asked === "string" ? asked : null;
  const setCode = useMutation(api.functions.texLabRuns.setCode);
  const save = async (raw: string) => {
    if (raw.trim() === (code ?? "")) return;
    try {
      const out = await setCode({ versionId: id, code: raw.trim() });
      toast(out.code ? `Runs of this draft now check out ${out.code}` : "Runs of this draft are back on main's code");
    } catch (e) {
      toast(e instanceof Error ? e.message.replace(/^.*Uncaught ConvexError: /, "").replace(/\n[\s\S]*$/, "") : "The code wasn't set");
    }
  };
  return (
    <>
      <div className="mh">Code</div>
      {main ? (
        <div className="mnote" id="labCode">
          main's code. A draft can run on a pull request's code.
        </div>
      ) : (
        <label className="mnote" style={{ display: "flex", flexDirection: "column", gap: 4 }}>
          <input
            id="labCode"
            className="vren"
            aria-label="Pull request or branch to run on"
            placeholder="main, #3401 or a branch"
            spellCheck={false}
            key={id + ":" + (code ?? "")}
            defaultValue={code ?? ""}
            onKeyDown={(e) => {
              if (e.key === "Enter") void save((e.target as HTMLInputElement).value);
            }}
            onBlur={(e) => void save(e.target.value)}
          />
          <span id="labCodeNow">{codeWords(code ?? null)}</span>
        </label>
      )}
    </>
  );
}

const THEME_WORD = { auto: "Auto", light: "Light", dark: "Dark" } as const;

/** ⋯: the look (auto, light, dark) and what is saved and shared. */
export function MoreMenu() {
  const s = useLab();
  const theme = useLabTheme();
  return (
    <Pop id="moreBtn" label="More" className="ib" right button={<Svg d='<circle cx="5" cy="12" r="1.3"/><circle cx="12" cy="12" r="1.3"/><circle cx="19" cy="12" r="1.3"/>' />}>
      {() => (
        <div className="vmenu">
          <div className="mh">Look</div>
          <div className="seg" id="themeToggle" role="radiogroup" aria-label="Look">
            {THEMES.map((t) => (
              <button
                key={t}
                data-theme-pick={t}
                role="radio"
                aria-checked={theme === t}
                onClick={() => {
                  setLabTheme(t);
                  emit();
                }}
              >
                {THEME_WORD[t]}
              </button>
            ))}
          </div>
          <hr />
          <div className="mnote" id="syncState">
            {s.sync}
          </div>
        </div>
      )}
    </Pop>
  );
}
