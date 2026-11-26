//! The line `lurkloot serve --ready-json` prints once its control plane
//! listens: `{"event":"ready","url":"http://127.0.0.1:49152/"}`. Other output
//! can reach stdout too (a transport's helper process shares it), so every
//! line is tried and only one that parses as a ready event counts.

use url::{Host, Url};

/// The serve URL a ready line names, when the line is one and the URL is a
/// plain-HTTP loopback address with a port. Anything else is refused: the
/// window only ever opens serve on this machine.
pub fn parse_ready_line(line: &str) -> Option<Url> {
    #[derive(serde::Deserialize)]
    struct Ready {
        event: String,
        url: String,
    }
    let ready: Ready = serde_json::from_str(line.trim()).ok()?;
    if ready.event != "ready" {
        return None;
    }
    let url = Url::parse(&ready.url).ok()?;
    if url.scheme() != "http" || url.port().is_none() || !is_loopback(&url) {
        return None;
    }
    if !url.username().is_empty() || url.password().is_some() {
        return None;
    }
    Some(url)
}

/// Whether the URL's host is this machine's loopback interface.
pub fn is_loopback(url: &Url) -> bool {
    match url.host() {
        Some(Host::Ipv4(ip)) => ip.is_loopback(),
        Some(Host::Ipv6(ip)) => ip.is_loopback(),
        Some(Host::Domain(domain)) => domain.eq_ignore_ascii_case("localhost"),
        None => false,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_the_ready_line() {
        let url = parse_ready_line(r#"{"event":"ready","url":"http://127.0.0.1:49152/"}"#).unwrap();
        assert_eq!(url.as_str(), "http://127.0.0.1:49152/");
        assert!(
            parse_ready_line("  {\"event\":\"ready\",\"url\":\"http://[::1]:8420/\"}\r\n")
                .is_some()
        );
    }

    #[test]
    fn ignores_other_output() {
        for line in [
            "",
            "lurkloot serve listening on http://127.0.0.1:8420/",
            r#"{"event":"started","url":"http://127.0.0.1:8420/"}"#,
            r#"{"event":"ready"}"#,
            r#"[1,2,3]"#,
            "{not json",
        ] {
            assert_eq!(parse_ready_line(line), None, "{line}");
        }
    }

    #[test]
    fn refuses_a_url_off_this_machine_or_without_a_port() {
        for url in [
            "https://127.0.0.1:8420/",
            "http://192.168.1.4:8420/",
            "http://example.com:8420/",
            "http://127.0.0.1/",
            "http://user:pass@127.0.0.1:8420/",
            "file:///etc/passwd",
            "javascript:alert(1)",
        ] {
            let line = serde_json::json!({ "event": "ready", "url": url }).to_string();
            assert_eq!(parse_ready_line(&line), None, "{url}");
        }
    }
}
