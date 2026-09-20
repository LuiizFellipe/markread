//! Update notifications: compare this build's version against the latest
//! published GitHub release.

use std::time::Duration;

use semver::Version;
use serde::Serialize;
use tauri::AppHandle;

const RELEASES_API: &str =
    "https://api.github.com/repos/LuiizFellipe/markread/releases/latest";
const RELEASES_PAGE: &str = "https://github.com/LuiizFellipe/markread/releases/tag/";
const REQUEST_TIMEOUT: Duration = Duration::from_secs(10);

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateInfo {
    pub available: bool,
    pub current_version: String,
    pub latest_version: String,
    pub release_url: Option<String>,
}

/// The API response is not trusted content: only a URL pointing at this
/// project's releases page is ever handed to the frontend/opener.
fn trusted_release_url(raw: Option<&str>) -> Option<String> {
    raw.filter(|u| u.starts_with(RELEASES_PAGE))
        .map(str::to_string)
}

/// Compare the running version with the latest release tag. Unparseable tags
/// resolve to "no update" so a renamed tag can never turn the checker into a
/// nag.
fn compare(
    current: &Version,
    latest_tag: Option<&str>,
    release_url: Option<String>,
) -> UpdateInfo {
    let latest = latest_tag.and_then(|tag| Version::parse(tag.strip_prefix('v').unwrap_or(tag)).ok());
    match latest {
        Some(latest) => UpdateInfo {
            available: latest > *current,
            current_version: current.to_string(),
            latest_version: latest.to_string(),
            release_url,
        },
        None => UpdateInfo {
            available: false,
            current_version: current.to_string(),
            latest_version: current.to_string(),
            release_url: None,
        },
    }
}

/// Query the latest GitHub release. The public API needs no auth (60 req/h
/// per IP — one check per app launch is far below that). Transport errors
/// surface to the caller (only manual checks display them).
fn fetch_latest(current: &Version) -> Result<UpdateInfo, String> {
    let user_agent = format!("markread/{}", current);
    let response = ureq::get(RELEASES_API)
        .set("User-Agent", user_agent.as_str())
        .set("Accept", "application/vnd.github+json")
        .timeout(REQUEST_TIMEOUT)
        .call()
        .map_err(|e| format!("update check failed: {e}"))?;
    let body: serde_json::Value = response
        .into_json()
        .map_err(|e| format!("invalid update response: {e}"))?;

    Ok(compare(
        current,
        body["tag_name"].as_str(),
        trusted_release_url(body["html_url"].as_str()),
    ))
}

/// The version comes from `package_info` — the same source as the About
/// dialog and the installers — so the comparison baseline cannot diverge
/// from what users actually run.
#[tauri::command]
pub async fn check_for_updates(app: AppHandle) -> Result<UpdateInfo, String> {
    let current = app.package_info().version.clone();
    // The network round-trip runs on a blocking thread so the async runtime
    // (and the UI) never waits on it.
    tauri::async_runtime::spawn_blocking(move || fetch_latest(&current))
        .await
        .map_err(|e| format!("update check failed: {e}"))?
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn current_version_is_valid_semver() {
        assert!(Version::parse(env!("CARGO_PKG_VERSION")).is_ok());
    }

    #[test]
    fn newer_tag_flags_update() {
        let current = Version::new(0, 1, 0);
        let info = compare(&current, Some("v0.2.0"), None);
        assert!(info.available);
        assert_eq!(info.latest_version, "0.2.0");
        assert_eq!(info.current_version, "0.1.0");
    }

    #[test]
    fn equal_or_older_tag_does_not_flag() {
        let current = Version::new(0, 2, 0);
        assert!(!compare(&current, Some("v0.2.0"), None).available);
        assert!(!compare(&current, Some("v0.1.0"), None).available);
    }

    #[test]
    fn malformed_tag_resolves_to_no_update() {
        let info = compare(&Version::new(0, 1, 0), Some("not-a-version"), None);
        assert!(!info.available);
        assert_eq!(info.latest_version, "0.1.0");
        assert_eq!(info.release_url, None);
    }

    #[test]
    fn foreign_release_url_is_dropped() {
        assert_eq!(trusted_release_url(Some("https://evil.example.com/phish")), None);
        assert_eq!(
            trusted_release_url(Some(
                "https://github.com/LuiizFellipe/markread/releases/tag/v0.2.0"
            )),
            Some("https://github.com/LuiizFellipe/markread/releases/tag/v0.2.0".to_string())
        );
    }
}
