//! Public templates (pass 2, see `0016_public_templates.sql`) — the "use a
//! template" surface: `routes::templates`. Flow A's own save/overwrite
//! (`PUT /api/videos/{id}/template`) is covered by `videos_api.rs`; this
//! file covers browsing (mine/others), visibility enforcement, the
//! lightweight rename/publish toggle, owner-only delete, and flow B's
//! template-sourced export.

use axum::body::Body;
use axum::http::{Request, StatusCode};
use serde_json::json;
use tower::ServiceExt;

mod common;
use common::{authed, login_as, parse_sse_events, spawn_app, upload_test_video};

/// Uploads a video and saves a named template against it (flow A), owned
/// by `test_app`'s default owner. Returns the created template's own id.
async fn put_test_template(test_app: &common::TestApp, name: &str, is_public: bool) -> String {
    let video = upload_test_video(test_app).await;
    let video_id = video["id"].as_str().unwrap();
    let payload = json!({
        "name": name,
        "is_public": is_public,
        "captions": [{
            "id": "c1",
            "startTime": 0.0,
            "endTime": 1.0,
            "text": "hello",
            "fontFamily": "Impact, sans-serif",
            "fontSize": 28,
            "color": "#ffffff",
            "align": "center",
            "x": 0.5,
            "y": 0.88
        }],
        "gif_range_start": 0.0,
        "gif_range_end": 1.5,
        "width": 320,
        "height": 240
    });
    let response = test_app
        .app
        .clone()
        .oneshot(
            authed(test_app, Request::builder())
                .method("PUT")
                .uri(format!("/api/videos/{video_id}/template"))
                .header("content-type", "application/json")
                .body(Body::from(payload.to_string()))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);

    sqlx::query_scalar("SELECT id FROM templates WHERE video_id = $1")
        .bind(video_id)
        .fetch_one(&test_app.pool)
        .await
        .unwrap()
}

async fn get_json(test_app: &common::TestApp, cookie: &str, uri: &str) -> (StatusCode, serde_json::Value) {
    let response = test_app
        .app
        .clone()
        .oneshot(
            Request::builder()
                .uri(uri)
                .header("cookie", cookie)
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    let status = response.status();
    let bytes = axum::body::to_bytes(response.into_body(), usize::MAX).await.unwrap();
    let value = if bytes.is_empty() {
        serde_json::Value::Null
    } else {
        serde_json::from_slice(&bytes).unwrap_or(serde_json::Value::Null)
    };
    (status, value)
}

#[tokio::test]
async fn list_mine_and_others_scoping() {
    let test_app = spawn_app().await;
    let owner_cookie = test_app.owner_cookie.clone();
    let private_id = put_test_template(&test_app, "Owner's private", false).await;
    let public_id = put_test_template(&test_app, "Owner's public", true).await;

    let (status, mine) = get_json(&test_app, &owner_cookie, "/api/templates/mine").await;
    assert_eq!(status, StatusCode::OK);
    let mine_ids: Vec<&str> = mine.as_array().unwrap().iter().map(|t| t["id"].as_str().unwrap()).collect();
    assert!(mine_ids.contains(&private_id.as_str()));
    assert!(mine_ids.contains(&public_id.as_str()));

    let viewer_cookie = login_as(&test_app, "viewer@example.com").await;
    let (status, others) = get_json(&test_app, &viewer_cookie, "/api/templates/others").await;
    assert_eq!(status, StatusCode::OK);
    let others_ids: Vec<&str> = others.as_array().unwrap().iter().map(|t| t["id"].as_str().unwrap()).collect();
    assert!(others_ids.contains(&public_id.as_str()), "public template should appear under others");
    assert!(
        !others_ids.contains(&private_id.as_str()),
        "private template should never appear under others"
    );

    // The viewer's own "mine" is empty — they haven't saved anything.
    let (status, viewer_mine) = get_json(&test_app, &viewer_cookie, "/api/templates/mine").await;
    assert_eq!(status, StatusCode::OK);
    assert!(viewer_mine.as_array().unwrap().is_empty());
}

#[tokio::test]
async fn get_one_enforces_public_or_owner_visibility() {
    let test_app = spawn_app().await;
    let owner_cookie = test_app.owner_cookie.clone();
    let private_id = put_test_template(&test_app, "Private one", false).await;
    let public_id = put_test_template(&test_app, "Public one", true).await;
    let viewer_cookie = login_as(&test_app, "viewer@example.com").await;

    let (status, _) = get_json(&test_app, &viewer_cookie, &format!("/api/templates/{private_id}")).await;
    assert_eq!(status, StatusCode::NOT_FOUND, "a non-owner must not be able to read a private template");

    let (status, body) = get_json(&test_app, &viewer_cookie, &format!("/api/templates/{public_id}")).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body["is_own"], false);
    assert!(body["owner_handle"].is_null() || body["owner_handle"].is_string());

    // The owner can always read their own, public or not.
    let (status, body) = get_json(&test_app, &owner_cookie, &format!("/api/templates/{private_id}")).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body["is_own"], true);
}

/// Regression test: the clip a template serves (`get_clip`) is trimmed to
/// start at 0 (`routes::videos::save_template`'s `ffmpeg::trim_video`
/// call), but the captions stored in `payload_json` are authored in the
/// *source video's* absolute timeline (flow A's own re-fill needs them
/// that way). `to_detail` must rebase them by `gif_range_start` before
/// handing them to flow B — otherwise every caption shows `gif_range_start`
/// seconds later than it should against the (already 0-based) clip.
#[tokio::test]
async fn get_one_rebases_captions_to_the_trimmed_clips_own_timeline() {
    let test_app = spawn_app().await;
    let video = upload_test_video(&test_app).await;
    let video_id = video["id"].as_str().unwrap();
    let payload = json!({
        "name": "Offset template",
        "is_public": false,
        "captions": [{
            "id": "c1",
            "startTime": 1.5,
            "endTime": 2.0,
            "text": "hello",
            "fontFamily": "Impact, sans-serif",
            "fontSize": 28,
            "color": "#ffffff",
            "align": "center",
            "x": 0.5,
            "y": 0.88
        }],
        // Trimmed to start 1.0s into the source video — the clip itself
        // will start at 0 and run for 1.5s.
        "gif_range_start": 1.0,
        "gif_range_end": 2.5,
        "width": 320,
        "height": 240
    });
    let response = test_app
        .app
        .clone()
        .oneshot(
            authed(&test_app, Request::builder())
                .method("PUT")
                .uri(format!("/api/videos/{video_id}/template"))
                .header("content-type", "application/json")
                .body(Body::from(payload.to_string()))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    let template_id: String = sqlx::query_scalar("SELECT id FROM templates WHERE video_id = $1")
        .bind(video_id)
        .fetch_one(&test_app.pool)
        .await
        .unwrap();

    let owner_cookie = test_app.owner_cookie.clone();
    let (status, body) = get_json(&test_app, &owner_cookie, &format!("/api/templates/{template_id}")).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body["duration_seconds"], 1.5);
    let captions = body["captions"].as_array().unwrap();
    assert_eq!(captions.len(), 1);
    // 1.5 - 1.0 = 0.5, 2.0 - 1.0 = 1.0 — relative to the clip's own start,
    // not the source video's.
    assert_eq!(captions[0]["startTime"], 0.5);
    assert_eq!(captions[0]["endTime"], 1.0);
}

#[tokio::test]
async fn patch_renames_and_toggles_public_without_touching_saved_content() {
    let test_app = spawn_app().await;
    let owner_cookie = test_app.owner_cookie.clone();
    let template_id = put_test_template(&test_app, "Original name", false).await;

    let saved_at_before: String = sqlx::query_scalar("SELECT saved_at FROM templates WHERE id = $1")
        .bind(&template_id)
        .fetch_one(&test_app.pool)
        .await
        .unwrap();

    let patch_body = json!({ "name": "Renamed", "is_public": true });
    let response = test_app
        .app
        .clone()
        .oneshot(
            authed(&test_app, Request::builder())
                .method("PATCH")
                .uri(format!("/api/templates/{template_id}"))
                .header("content-type", "application/json")
                .body(Body::from(patch_body.to_string()))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    let body: serde_json::Value = serde_json::from_slice(
        &axum::body::to_bytes(response.into_body(), usize::MAX).await.unwrap(),
    )
    .unwrap();
    assert_eq!(body["name"], "Renamed");
    assert_eq!(body["is_public"], true);

    let saved_at_after: String = sqlx::query_scalar("SELECT saved_at FROM templates WHERE id = $1")
        .bind(&template_id)
        .fetch_one(&test_app.pool)
        .await
        .unwrap();
    assert_eq!(
        saved_at_before, saved_at_after,
        "rename/publish must not touch saved_at/payload_json — no re-trim/re-save"
    );

    // A non-owner can't do this at all.
    let viewer_cookie = login_as(&test_app, "viewer@example.com").await;
    let response = test_app
        .app
        .clone()
        .oneshot(
            Request::builder()
                .method("PATCH")
                .uri(format!("/api/templates/{template_id}"))
                .header("content-type", "application/json")
                .header("cookie", &viewer_cookie)
                .body(Body::from(json!({ "name": "hijacked" }).to_string()))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::NOT_FOUND);
    let _ = owner_cookie;
}

#[tokio::test]
async fn delete_is_owner_only() {
    let test_app = spawn_app().await;
    let template_id = put_test_template(&test_app, "Doomed", true).await;
    let viewer_cookie = login_as(&test_app, "viewer@example.com").await;

    let response = test_app
        .app
        .clone()
        .oneshot(
            Request::builder()
                .method("DELETE")
                .uri(format!("/api/templates/{template_id}"))
                .header("cookie", &viewer_cookie)
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::NOT_FOUND, "a non-owner can't delete someone else's template");

    let response = test_app
        .app
        .clone()
        .oneshot(
            authed(&test_app, Request::builder())
                .method("DELETE")
                .uri(format!("/api/templates/{template_id}"))
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::NO_CONTENT);

    let exists: Option<String> = sqlx::query_scalar("SELECT id FROM templates WHERE id = $1")
        .bind(&template_id)
        .fetch_optional(&test_app.pool)
        .await
        .unwrap();
    assert!(exists.is_none());
}

#[tokio::test]
async fn asset_routes_enforce_the_same_visibility_as_get_one() {
    let test_app = spawn_app().await;
    let private_id = put_test_template(&test_app, "Private clip", false).await;
    let viewer_cookie = login_as(&test_app, "viewer@example.com").await;

    for suffix in ["clip", "thumbnail", "filmstrip.jpg", "meta"] {
        let response = test_app
            .app
            .clone()
            .oneshot(
                Request::builder()
                    .uri(format!("/api/templates/{private_id}/{suffix}"))
                    .header("cookie", &viewer_cookie)
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(
            response.status(),
            StatusCode::NOT_FOUND,
            "/{suffix} should 404 for a non-owner on a private template",
        );
    }

    // The owner can fetch every asset of their own private template.
    for suffix in ["clip", "thumbnail", "filmstrip.jpg", "meta"] {
        let response = test_app
            .app
            .clone()
            .oneshot(
                authed(&test_app, Request::builder())
                    .uri(format!("/api/templates/{private_id}/{suffix}"))
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK, "owner should be able to fetch /{suffix}");
    }
}

/// Flow B, end to end: exporting from a template (not owned by the caller)
/// produces a gif with `template_id` lineage, no `video_id`, and a range/
/// dimensions that exactly match the template's own saved values — proof
/// the server derives these itself rather than trusting the request (which
/// has no such fields to begin with).
#[tokio::test]
async fn template_export_creates_a_gif_with_lineage_and_locked_dimensions() {
    let test_app = spawn_app().await;
    let public_id = put_test_template(&test_app, "Shared template", true).await;
    let viewer_cookie = login_as(&test_app, "viewer@example.com").await;

    let export_body = json!({
        "name": "remixed by viewer",
        "captions": [{
            "id": "c1",
            "startTime": 0.0,
            "endTime": 1.0,
            "text": "viewer's own words",
            "fontFamily": "Impact, sans-serif",
            "fontSize": 28,
            "color": "#ffffff",
            "align": "center",
            "x": 0.5,
            "y": 0.88
        }]
    });
    let create_response = test_app
        .app
        .clone()
        .oneshot(
            Request::builder()
                .method("POST")
                .uri(format!("/api/templates/{public_id}/exports"))
                .header("content-type", "application/json")
                .header("cookie", &viewer_cookie)
                .body(Body::from(export_body.to_string()))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(create_response.status(), StatusCode::ACCEPTED);
    let accepted: serde_json::Value = serde_json::from_slice(
        &axum::body::to_bytes(create_response.into_body(), usize::MAX).await.unwrap(),
    )
    .unwrap();
    let export_id = accepted["export_id"].as_str().unwrap().to_string();
    // put_test_template saved width=320, height=240 (see the comment
    // below) — no real export Lambda runs in tests, so simulate its
    // "done" callbacks before opening progress (gifiac#32's terminal-
    // replay path).
    common::complete_export_job(&test_app, &export_id, 320, 240).await;

    let progress_response = tokio::time::timeout(
        std::time::Duration::from_secs(60),
        test_app.app.clone().oneshot(
            Request::builder()
                .uri(format!("/api/exports/{export_id}/progress"))
                .header("cookie", &viewer_cookie)
                .body(Body::empty())
                .unwrap(),
        ),
    )
    .await
    .expect("SSE stream did not close within the timeout")
    .unwrap();
    let body_bytes = tokio::time::timeout(
        std::time::Duration::from_secs(60),
        axum::body::to_bytes(progress_response.into_body(), usize::MAX),
    )
    .await
    .expect("reading the SSE body did not finish within the timeout")
    .unwrap();
    let body_text = String::from_utf8(body_bytes.to_vec()).unwrap();
    let events = parse_sse_events(&body_text);
    let (last_event, last_data) = events.last().expect("expected at least one SSE event");
    assert_eq!(last_event, "complete", "template export did not complete: {events:?}");
    let gif: serde_json::Value = serde_json::from_str(last_data).unwrap();

    assert_eq!(gif["template_id"], public_id);
    assert!(gif["video_id"].is_null(), "flow B must never stamp video_id");
    // put_test_template saved gif_range_start=0.0, gif_range_end=1.5,
    // width=320, height=240 — the export must reproduce that clip
    // duration/size exactly, not whatever `run_pipeline` would otherwise
    // derive.
    assert_eq!(gif["gif_range_start"], 0.0);
    assert_eq!(gif["gif_range_end"], 1.5);
    assert_eq!(gif["width"], 320);
    assert_eq!(gif["height"], 240);
}

#[tokio::test]
async fn template_export_from_a_private_template_you_dont_own_returns_404() {
    let test_app = spawn_app().await;
    let private_id = put_test_template(&test_app, "Private template", false).await;
    let viewer_cookie = login_as(&test_app, "viewer@example.com").await;

    let export_body = json!({ "name": "should not work", "captions": [] });
    let response = test_app
        .app
        .clone()
        .oneshot(
            Request::builder()
                .method("POST")
                .uri(format!("/api/templates/{private_id}/exports"))
                .header("content-type", "application/json")
                .header("cookie", &viewer_cookie)
                .body(Body::from(export_body.to_string()))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::NOT_FOUND);
}

/// Flow A stamps template lineage onto the gif that produced the template
/// too, not just gifs later started *from* it (flow B) — the gif that made
/// a template possible in the first place should offer "Remix this GIF"
/// just as much as any of its descendants.
#[tokio::test]
async fn flow_a_export_with_save_as_template_stamps_lineage_to_the_new_template() {
    let test_app = spawn_app().await;
    let video = upload_test_video(&test_app).await;
    let video_id = video["id"].as_str().unwrap();

    let export_body = json!({
        "video_id": video_id,
        "name": "flow a, with a template",
        "save_as_template": true,
        "template_name": "also saved",
        "captions": [],
        "gif_range_start": 0.0,
        "gif_range_end": 1.0
    });
    let create_response = test_app
        .app
        .clone()
        .oneshot(
            authed(&test_app, Request::builder())
                .method("POST")
                .uri("/api/exports")
                .header("content-type", "application/json")
                .body(Body::from(export_body.to_string()))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(create_response.status(), StatusCode::ACCEPTED);
    let accepted: serde_json::Value = serde_json::from_slice(
        &axum::body::to_bytes(create_response.into_body(), usize::MAX).await.unwrap(),
    )
    .unwrap();
    let export_id = accepted["export_id"].as_str().unwrap().to_string();
    common::complete_export_job(
        &test_app,
        &export_id,
        video["width"].as_i64().unwrap(),
        video["height"].as_i64().unwrap(),
    )
    .await;

    let progress_response = tokio::time::timeout(
        std::time::Duration::from_secs(60),
        test_app.app.clone().oneshot(
            authed(&test_app, Request::builder())
                .uri(format!("/api/exports/{export_id}/progress"))
                .body(Body::empty())
                .unwrap(),
        ),
    )
    .await
    .unwrap()
    .unwrap();
    let body_bytes = tokio::time::timeout(
        std::time::Duration::from_secs(60),
        axum::body::to_bytes(progress_response.into_body(), usize::MAX),
    )
    .await
    .unwrap()
    .unwrap();
    let body_text = String::from_utf8(body_bytes.to_vec()).unwrap();
    let events = parse_sse_events(&body_text);
    let (last_event, last_data) = events.last().unwrap();
    assert_eq!(last_event, "complete");
    let gif: serde_json::Value = serde_json::from_str(last_data).unwrap();
    assert!(
        gif["template_id"].is_string(),
        "flow A with save_as_template checked must stamp the new template's id onto the gif"
    );
}
