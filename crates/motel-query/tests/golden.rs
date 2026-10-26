//! Golden text for the answers agents read most. On a mismatch the test prints the actual
//! text between `----- actual <name>` markers; copy it into `tests/golden/<name>.txt`.

mod common;

use common::*;
use motel_query::{Answer, WhyArgs};

fn check(name: &str, actual: &str) {
    let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("tests/golden")
        .join(format!("{name}.txt"));
    let expected = std::fs::read_to_string(&path).unwrap_or_default();
    if expected != actual {
        println!("----- actual {name}\n{actual}----- end {name}");
        panic!("golden mismatch: {}", path.display());
    }
}

#[test]
fn golden_why_findings() {
    let f = seeded("golden-why");
    check("why", &f.query().why(&WhyArgs::default()).unwrap().text());
}

#[test]
fn golden_why_empty() {
    let f = seeded("golden-why-empty");
    let q = f.query();
    let quiet = q
        .why(&WhyArgs {
            service: Some("batch".to_owned()),
            ..Default::default()
        })
        .unwrap()
        .text();
    let unknown = q
        .why(&WhyArgs {
            service: Some("apii".to_owned()),
            ..Default::default()
        })
        .unwrap()
        .text();
    let e = empty("golden-empty-store");
    let store_empty = e.query().why(&WhyArgs::default()).unwrap().text();
    check(
        "why_empty",
        &format!("$ motel why batch\n{quiet}\n$ motel why apii\n{unknown}\n$ motel why   # empty store\n{store_empty}"),
    );
}

#[test]
fn golden_show_trace() {
    let f = seeded("golden-trace");
    check(
        "show_trace",
        &f.query().show(&hex(&T1), false).unwrap().text(),
    );
}

#[test]
fn golden_show_crash() {
    let f = seeded("golden-crash");
    check(
        "show_crash",
        &f.query().show("e:ev.2", false).unwrap().text(),
    );
}

#[test]
fn golden_show_run() {
    let f = seeded("golden-run");
    check(
        "show_run",
        &f.query().show("run:last", false).unwrap().text(),
    );
}
