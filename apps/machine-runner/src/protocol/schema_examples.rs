//! Every example in `packages/shared/src/machineProtocol.examples.json`, read
//! into these types and written back unchanged. The gateway's test validates
//! the same examples against the schema, so a shape that drifts on either side
//! fails one of the two.

use super::*;
use serde::de::DeserializeOwned;
use serde_json::Value;

const EXAMPLES: &str =
    include_str!("../../../../packages/shared/src/machineProtocol.examples.json");

fn round_trip<T: DeserializeOwned + Serialize>(v: &Value) {
    let parsed: T =
        serde_json::from_value(v.clone()).unwrap_or_else(|e| panic!("does not read {v}: {e}"));
    assert_eq!(
        &serde_json::to_value(&parsed).unwrap(),
        v,
        "does not write back the same"
    );
}

fn examples() -> Value {
    serde_json::from_str(EXAMPLES).unwrap()
}

#[test]
fn every_server_frame_round_trips() {
    let all = examples();
    let frames = all["server"].as_array().unwrap();
    for f in frames {
        round_trip::<ServerMsg>(f);
    }
    // One of each kind, so a kind added to the schema cannot go unread here.
    let kinds: std::collections::BTreeSet<_> =
        frames.iter().map(|f| f["type"].as_str().unwrap()).collect();
    assert_eq!(
        kinds.into_iter().collect::<Vec<_>>(),
        [
            "assign",
            "cancel",
            "challenge",
            "goodbye",
            "interrupt",
            "mail",
            "message",
            "rules",
            "signIn",
            "welcome"
        ]
    );
}

#[test]
fn every_runner_frame_round_trips() {
    let all = examples();
    let frames = all["runner"].as_array().unwrap();
    for f in frames {
        round_trip::<RunnerMsg>(f);
    }
    let kinds: std::collections::BTreeSet<_> =
        frames.iter().map(|f| f["type"].as_str().unwrap()).collect();
    assert_eq!(
        kinds.into_iter().collect::<Vec<_>>(),
        [
            "accept",
            "hello",
            "refuse",
            "result",
            "session",
            "signInState",
            "status",
            "step",
            "usage"
        ]
    );
}

#[test]
fn every_pairing_body_round_trips() {
    let all = examples();
    let p = &all["pairing"];
    round_trip::<PairStart>(&p["PairStart"]);
    round_trip::<PairStarted>(&p["PairStarted"]);
    round_trip::<PairPoll>(&p["PairPoll"]);
    round_trip::<PairStatus>(&p["PairStatus"]);
    assert_eq!(
        p.as_object().unwrap().len(),
        4,
        "a pairing body was added to the examples"
    );
}

#[test]
fn a_field_the_schema_does_not_have_is_refused() {
    let mut f = examples()["server"][0].clone();
    f["extra"] = Value::Bool(true);
    assert!(serde_json::from_value::<ServerMsg>(f).is_err());
}
