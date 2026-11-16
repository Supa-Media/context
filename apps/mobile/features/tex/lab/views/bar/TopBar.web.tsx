/**
 * The decluttered top bar's menus (mockup https://claude.ai/artifact/W21NekNf2vtnFLXXzAmp7N, approved by Dev2
 * 2026-11-16: "much cleaner"): one version picker that holds the versions, a new version, rename, Promote and how a
 * draft's changes are drawn; the Dev set score and a split ▶ Run Dev set whose menu picks the models; and ⋯ for the
 * look and the sync state. Everything here is also a tex_dev action (list, create, rename, promote, run, runs).
 */
import { emit, isMain, lab, newVersion, openVersion, set } from "../../engine/state";
import { isLive, live } from "../../engine/live";
import { promoteVersion, useLab } from "../../store";
import { scoreWords, setRunsUi, useRunsUi } from "../../engine/labRuns";
import { setLabTheme, THEMES, useLabTheme } from "../../theme.web";
import { ChangeToggles, LiveChanges } from "../LiveChanges.web";
import { StagePill, useRuns, useStartRun } from "../runs/Runs.web";
import { Pop } from "./Pop.web";

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
          ▶ Run<span className="hide-s"> Dev set</span>
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
