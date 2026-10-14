// Automatic linking of this app to the restaurant (2026-10-14, „casa simplu”).
//
// The owner presses „Configurează casa de marcat” in the web admin
// (Setări → Casa de marcat) INSIDE this app. The admin page — logged in as
// an administrator — asks the server for a fresh enrolment code
// (POST /api/fiscal-bridge/enroll: 8 characters, single use, 10 minutes)
// and hands it to `window.desktopBridge.fiscal.link(code)`. The `desktop`
// plugin command `fiscal_link` then runs exactly what step 2 of the guide
// ran by hand: claim → fiscal_bridge_run → protocol config → reconnect.
//
// Security (see also desktop_plugin.rs::fiscal_link and shell/mod.rs):
//   * the command accepts ONLY an enrolment code (validated here); a device
//     token or anything longer is refused before any network call;
//   * the server validates the code as before (unknown → 404, expired → 410,
//     single use);
//   * the permission is granted at runtime to the configured tenant origin
//     only, never to every *.360booking.ro page, and the command checks the
//     calling page's origin again;
//   * no other fiscal command becomes reachable from the web page.
//
// This file holds the pure parts (no Tauri types) so they are unit-tested
// on their own.

use std::sync::Mutex;

use serde::Serialize;
use url::Url;

/// What the claim needs: the server, the code. The default server is the one
/// the guide uses (`DEFAULT_SERVER` in fiscal-guide/api.ts).
pub const DEFAULT_SERVER: &str = "https://360booking.ro";

/// Path of the admin page with „Casa de marcat” on the tenant site.
pub const ADMIN_FISCAL_PATH: &str = "/admin/restaurant/fiscal";

/// Query flag: the admin page starts the automatic link by itself
/// („Reîncearcă legarea” in the guide window).
pub const AUTO_LINK_QUERY: &str = "casa=leaga";

/// Normalises an enrolment code typed or passed by the page: "abcd-1234",
/// "ABCD 1234", "ABCD1234" → "ABCD-1234". Anything that is not exactly 8
/// letters/digits is refused — in particular a device token (64 chars).
pub fn normalise_enrollment_code(raw: &str) -> Option<String> {
    if raw.len() > 16 {
        return None;
    }
    let mut s = String::with_capacity(8);
    for c in raw.trim().chars() {
        if c == '-' || c == ' ' {
            continue;
        }
        if !c.is_ascii_alphanumeric() {
            return None;
        }
        s.push(c.to_ascii_uppercase());
    }
    if s.len() != 8 {
        return None;
    }
    Some(format!("{}-{}", &s[..4], &s[4..]))
}

fn same_origin(a: &Url, b: &Url) -> bool {
    a.scheme() == b.scheme()
        && a.host_str() == b.host_str()
        && a.port_or_known_default() == b.port_or_known_default()
}

/// True when `page` is a page of the configured tenant site (same scheme,
/// host and port). A local page (tauri.localhost) or another 360booking
/// subdomain is NOT the tenant.
pub fn is_tenant_page(page: &Url, tenant: &Url) -> bool {
    matches!(page.scheme(), "https" | "http") && same_origin(page, tenant)
}

/// Capability pattern for exactly the tenant origin ("https://host[:port]");
/// Tauri matches every path of that origin.
pub fn capability_pattern(origin: &Url) -> String {
    let mut p = format!("{}://{}", origin.scheme(), origin.host_str().unwrap_or_default());
    if let Some(port) = origin.port() {
        p.push_str(&format!(":{port}"));
    }
    p
}

/// Admin page that starts the automatic link by itself.
pub fn auto_link_url(tenant: &Url) -> Option<Url> {
    let mut u = tenant.join(ADMIN_FISCAL_PATH).ok()?;
    u.set_query(Some(AUTO_LINK_QUERY));
    Some(u)
}

/// A provider the claim can announce (never the simulator / empty).
pub fn printer_model_for_claim(provider: Option<&str>) -> String {
    match provider.map(str::trim) {
        Some(p) if !p.is_empty() && p != "simulator" => p.to_string(),
        _ => "datecs_dp25".to_string(),
    }
}

/// Plain-Romanian reason for a failed link (the raw error stays in the log).
pub fn explain_link_error(raw: &str) -> String {
    let l = raw.to_ascii_lowercase();
    if l.contains("not found") || l.contains("404") {
        "Codul de legare nu mai e valabil. Apasă din nou „Configurează casa de marcat”.".into()
    } else if l.contains("expired") || l.contains("410") {
        "Codul de legare a expirat. Apasă din nou „Configurează casa de marcat”.".into()
    } else if l.contains("post ") || l.contains("dns") || l.contains("connect") || l.contains("timed out") {
        "Nu am putut ajunge la server. Verifică internetul și încearcă din nou.".into()
    } else {
        format!("Legarea nu a reușit: {raw}")
    }
}

/// Last automatic link, shown by the guide window as the „Legare” line.
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct LinkState {
    /// "linking" | "ok" | "error"
    pub state: String,
    pub at: u64,
    pub error: Option<String>,
    pub bridge_id: Option<String>,
}

static LINK: Mutex<Option<LinkState>> = Mutex::new(None);

pub fn set_state(s: LinkState) {
    *LINK.lock().unwrap_or_else(|e| e.into_inner()) = Some(s);
}

pub fn state() -> Option<LinkState> {
    LINK.lock().unwrap_or_else(|e| e.into_inner()).clone()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn code_is_normalised() {
        assert_eq!(normalise_enrollment_code("abcd-2345").as_deref(), Some("ABCD-2345"));
        assert_eq!(normalise_enrollment_code(" ABCD2345 ").as_deref(), Some("ABCD-2345"));
        assert_eq!(normalise_enrollment_code("AB CD-23 45").as_deref(), Some("ABCD-2345"));
    }

    #[test]
    fn only_codes_are_accepted() {
        assert_eq!(normalise_enrollment_code(""), None);
        assert_eq!(normalise_enrollment_code("ABCD-234"), None);
        assert_eq!(normalise_enrollment_code("ABCD-23456"), None);
        assert_eq!(normalise_enrollment_code("ABCD_2345"), None);
        assert_eq!(normalise_enrollment_code("ABCD-23é5"), None);
        // a device token (token_urlsafe(48) = 64 chars) is never a code
        let token = "Zq3v9kP0xY7mN2bL5cR8tW1aS4dF6gH0jK3lQ9wE2rT5yU8iO1pA4sD7fG0hJ3kL";
        assert_eq!(normalise_enrollment_code(token), None);
        assert_eq!(normalise_enrollment_code(&token[..12]), None);
    }

    #[test]
    fn tenant_page_must_be_the_configured_origin() {
        let tenant = Url::parse("https://pizza.360booking.ro/").unwrap();
        let ok = Url::parse("https://pizza.360booking.ro/admin/restaurant/fiscal?casa=leaga").unwrap();
        assert!(is_tenant_page(&ok, &tenant));
        for bad in [
            "https://other.360booking.ro/admin/restaurant/fiscal",
            "https://360booking.ro/admin/restaurant/fiscal",
            "http://pizza.360booking.ro/admin",
            "https://pizza.360booking.ro:8443/admin",
            "https://pizza.360booking.ro.evil.com/admin",
            "http://tauri.localhost/?shell=fiscal",
            "tauri://localhost/",
        ] {
            assert!(!is_tenant_page(&Url::parse(bad).unwrap(), &tenant), "{bad}");
        }
        let custom = Url::parse("https://pos.restaurant-x.ro/").unwrap();
        assert!(is_tenant_page(&Url::parse("https://pos.restaurant-x.ro/admin").unwrap(), &custom));
    }

    #[test]
    fn capability_pattern_is_the_bare_origin() {
        assert_eq!(
            capability_pattern(&Url::parse("https://pizza.360booking.ro/").unwrap()),
            "https://pizza.360booking.ro"
        );
        assert_eq!(
            capability_pattern(&Url::parse("http://localhost:8000/").unwrap()),
            "http://localhost:8000"
        );
    }

    #[test]
    fn auto_link_page() {
        let u = auto_link_url(&Url::parse("https://pizza.360booking.ro/").unwrap()).unwrap();
        assert_eq!(u.as_str(), "https://pizza.360booking.ro/admin/restaurant/fiscal?casa=leaga");
    }

    #[test]
    fn claim_model_never_simulator() {
        assert_eq!(printer_model_for_claim(None), "datecs_dp25");
        assert_eq!(printer_model_for_claim(Some("simulator")), "datecs_dp25");
        assert_eq!(printer_model_for_claim(Some(" ")), "datecs_dp25");
        assert_eq!(printer_model_for_claim(Some("datecs_dp25")), "datecs_dp25");
        assert_eq!(printer_model_for_claim(Some("datecs_fp700")), "datecs_fp700");
    }

    #[test]
    fn link_errors_are_plain_romanian() {
        assert!(explain_link_error("Configuration error: enrollment code not found: {}").contains("nu mai e valabil"));
        assert!(explain_link_error("enrollment code expired").contains("expirat"));
        assert!(explain_link_error("POST https://360booking.ro/api/fiscal-bridge/claim: error sending request").contains("internetul"));
    }

    #[test]
    fn state_roundtrip() {
        let s = LinkState { state: "ok".into(), at: 1, error: None, bridge_id: Some("b".into()) };
        set_state(s.clone());
        assert_eq!(state(), Some(s));
    }
}
