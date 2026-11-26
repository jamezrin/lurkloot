//! The access token that locks this launch's `serve` (#1024). One fresh
//! random token per app launch, passed to `serve` in its environment and to
//! the app UI through sessionStorage, so nothing else on the machine can use
//! the API and the app never has to ask for it.

/// The sessionStorage key the app UI reads its token from
/// (`TOKEN_STORAGE_KEY` in packages/app-ui/src/api.ts).
pub const TOKEN_STORAGE_KEY: &str = "lurkloot.app.serveToken";

/// The variable `serve` reads its token from (`SERVE_TOKEN_ENV` in
/// packages/cli/src/runtime/controlPlane.ts).
pub const SERVE_TOKEN_ENV: &str = "LURKLOOT_SERVE_TOKEN";

/// 32 random bytes from the OS, as 64 hex characters.
pub fn generate_token() -> String {
    let mut bytes = [0u8; 32];
    getrandom::fill(&mut bytes).expect("the OS random number generator is unavailable");
    bytes.iter().map(|byte| format!("{byte:02x}")).collect()
}

/// The script run in the window's main frame before each page loads. It hands
/// the token to the page only on a plain-HTTP loopback origin, which is where
/// serve runs; the navigation guard keeps the window on serve's own origin, so
/// no other page loads there. The token is never logged.
pub fn token_script(token: &str) -> String {
    let key = serde_json::to_string(TOKEN_STORAGE_KEY).expect("a string serializes");
    let value = serde_json::to_string(token).expect("a string serializes");
    // Tells the app UI it runs in the desktop app, which opens Twitch's
    // sign-in in a window of its own (#1026).
    let host = serde_json::to_string(crate::twitch_sign_in::DESKTOP_HOST_PROPERTY)
        .expect("a string serializes");
    format!(
        r#"(function () {{
  var loc = window.location;
  if (loc.protocol !== "http:") return;
  if (loc.hostname !== "127.0.0.1" && loc.hostname !== "localhost" && loc.hostname !== "[::1]") return;
  try {{ window.sessionStorage.setItem({key}, {value}); }} catch (error) {{}}
  Object.defineProperty(window, {host}, {{ value: Object.freeze({{ twitchSignInWindow: true }}) }});
}})();"#
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tokens_are_long_random_and_hex() {
        let first = generate_token();
        let second = generate_token();
        assert_eq!(first.len(), 64);
        assert!(first.chars().all(|c| c.is_ascii_hexdigit()));
        assert_ne!(first, second);
    }

    #[test]
    fn the_script_writes_the_app_ui_key_on_loopback_only() {
        let script = token_script("abc123");
        assert!(script.contains(r#"setItem("lurkloot.app.serveToken", "abc123")"#));
        assert!(script.contains(r#"loc.protocol !== "http:""#));
        assert!(script.contains(r#"loc.hostname !== "127.0.0.1""#));
        assert!(script.contains(
            r#"Object.defineProperty(window, "lurklootDesktop", { value: Object.freeze({ twitchSignInWindow: true }) });"#
        ));
    }

    #[test]
    fn the_script_quotes_the_token_as_a_string() {
        let script = token_script("\"); alert(1); (\"");
        assert!(script.contains(r#""\"); alert(1); (\"""#));
    }
}
