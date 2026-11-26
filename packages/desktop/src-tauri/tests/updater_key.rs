//! The updater's public key in tauri.conf.json belongs to the private key the
//! release signs with (#1028). `fixtures/updater-key-check.txt.sig` was made
//! with that private key (`tauri signer sign`); if the public key were
//! replaced or mistyped, every installed app would refuse every update, so
//! this fails first. It also checks a tampered file is refused, the same check
//! the updater makes on each download.

use base64::Engine as _;
use minisign_verify::{PublicKey, Signature};

const CONFIG: &str = include_str!("../tauri.conf.json");
const FIXTURE: &[u8] = include_bytes!("fixtures/updater-key-check.txt");
const SIGNATURE: &str = include_str!("fixtures/updater-key-check.txt.sig");

fn decode(base64: &str) -> String {
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(base64.trim())
        .expect("valid base64");
    String::from_utf8(bytes).expect("minisign text is UTF-8")
}

fn configured_key() -> PublicKey {
    let config: serde_json::Value = serde_json::from_str(CONFIG).expect("tauri.conf.json parses");
    let pubkey = config["plugins"]["updater"]["pubkey"]
        .as_str()
        .expect("plugins.updater.pubkey is set");
    PublicKey::decode(&decode(pubkey)).expect("the configured key is a minisign public key")
}

fn signature() -> Signature {
    Signature::decode(&decode(SIGNATURE)).expect("the fixture's signature decodes")
}

#[test]
fn the_configured_key_verifies_the_release_keys_signature() {
    configured_key()
        .verify(FIXTURE, &signature(), false)
        .expect("tauri.conf.json's pubkey must match the release signing key");
}

#[test]
fn a_tampered_file_is_refused() {
    let mut tampered = FIXTURE.to_vec();
    tampered[0] ^= 1;
    assert!(configured_key()
        .verify(&tampered, &signature(), false)
        .is_err());
}

#[test]
fn updates_are_bound_to_their_version() {
    let config: serde_json::Value = serde_json::from_str(CONFIG).unwrap();
    let updater = &config["plugins"]["updater"];
    assert_eq!(updater["requireSignedVersion"], true);
    // Only stable releases feed the updater: GitHub's latest release is never
    // a prerelease, which is what every candidate is.
    assert_eq!(
        updater["endpoints"],
        serde_json::json!([
            "https://github.com/jamezrin/lurkloot/releases/latest/download/latest.json"
        ])
    );
    assert!(signature().trusted_comment().contains("version:"));
}
