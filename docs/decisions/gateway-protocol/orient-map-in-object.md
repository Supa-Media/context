# Gateway protocol: each workspace draws orient's map in its own object

**Decided 2026-11-03**, for Dev's "every read under 0.1 s". Orient's median
was about 880 ms. A trip to a workspace object took 20 to 50 ms. Most of the
time was the gateway itself:
- it asked each workspace for every path the reader may see (a megabyte of
  JSON for 10,000 notes);
- it drew every workspace's map on its one thread, one after another;
- it then asked again for the folder notes and the built-in jobs.

### The rule

Where a workspace's notes live in its object (home `object`), the gateway asks
it for the finished map: `ws.orient.survey`
(`apps/mcp/src/workspaceStore/orientSurvey.js`). The object:
- judges its rows for that reader exactly as `ws.rows.manifest` does
  (`manifestPage` over `judgeFor`);
- draws the map with the same code the gateway used (`orient/surveyOf.js`
  `surveyLocally`);
- answers the folder descriptions and jobs from its own facts, judged as
  `ws.facts` judges them;
- sends only the map.

The workspaces of one orient draw theirs side by side.

The object answers `{served: false}`, and the gateway draws the map itself as
before, when:
- the object holds no rules for the reader;
- the notes do not live in the object yet;
- the listing would take more than one page;
- a mark says a change is still coming.

### What a simplification would cost

- **Sending paths again** puts the megabyte, the parse and the drawing back on
  the gateway's one thread.
- **Drawing with different code in the object** lets the two maps drift.
- **Judging with anything but `judgeFor`** lets a map name a note its reader
  could not open.

`apps/mcp/test/orientSurveyInObject.test.mjs` checks three things for a team
reader and for the owner:
- the object's map equals the map the gateway draws from the same object's
  listing and facts;
- a team reader's map names nothing private;
- `surveyOf` takes the object's map when it is served and draws its own when
  it is not.
