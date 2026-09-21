use axum::body::Body;
use axum::http::{Request, StatusCode};
use serde_json::json;
use tower::ServiceExt;

mod common;
use common::{authed, login_as, spawn_app, upload_test_video};

/// Puts a template on `video_id` with a template payload carrying one
/// locked caption ("c1") and one changeable caption ("c2") — the shape
/// every test here needs to exercise locked-caption normalization at
/// export time. Returns the template's own id (looked up directly via SQL
/// since `PUT /api/videos/{id}/template` doesn't return one — that
/// endpoint stays the video-owner's private flow, unrelated to the
/// template-id-scoped routes under test here).
async fn put_test_template(test_app: &common::TestApp, video_id: &str) -> String {
    let payload = json!({
        "captions": [
            {
                "id": "c1",
                "startTime": 0.0,
                "endTime": 1.0,
                "text": "locked caption",
                "fontFamily": "Impact, sans-serif",
                "fontSize": 28,
                "color": "#ffffff",
                "align": "center",
                "x": 0.5,
                "y": 0.88,
                "locked": true
            },
            {
                "id": "c2",
                "startTime": 0.0,
                "endTime": 1.0,
                "text": "changeable caption",
                "fontFamily": "Impact, sans-serif",
                "fontSize": 28,
                "color": "#ffffff",
                "align": "center",
                "x": 0.5,
                "y": 0.88,
                "locked": false
            }
        ],
        "gif_range_start": 0.0,
        "gif_range_end": 1.0,
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

async fn make_template_public(test_app: &common::TestApp, template_id: &str) {
    let response = test_app
        .app
        .clone()
        .oneshot(
            authed(test_app, Request::builder())
                .method("PATCH")
                .uri(format!("/api/templates/{template_id}"))
                .header("content-type", "application/json")
                .body(Body::from(json!({ "is_public": true }).to_string()))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
}

#[tokio::test]
async fn get_template_requires_public_and_returns_the_full_shape_once_public() {
    let test_app = spawn_app().await;
    let video = upload_test_video(&test_app).await;
    let template_id = put_test_template(&test_app, video["id"].as_str().unwrap()).await;

    let private_response = test_app
        .app
        .clone()
        .oneshot(
            Request::builder()
                .uri(format!("/api/templates/{template_id}"))
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(private_response.status(), StatusCode::NOT_FOUND);

    make_template_public(&test_app, &template_id).await;

    let response = test_app
        .app
        .clone()
        .oneshot(
            Request::builder()
                .uri(format!("/api/templates/{template_id}"))
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    let body: serde_json::Value = serde_json::from_slice(
        &axum::body::to_bytes(response.into_body(), usize::MAX)
            .await
            .unwrap(),
    )
    .unwrap();
    assert_eq!(body["id"], template_id);
    assert_eq!(body["is_public"], true);
    assert_eq!(body["use_count"], 0);
    assert_eq!(body["clip_url"], format!("/api/templates/{template_id}/clip"));
    assert_eq!(
        body["thumbnail_url"],
        format!("/api/templates/{template_id}/thumbnail")
    );
    assert_eq!(body["captions"].as_array().unwrap().len(), 2);
    assert_eq!(body["width"], 320);
}

#[tokio::test]
async fn get_unknown_template_returns_404() {
    let test_app = spawn_app().await;
    let response = test_app
        .app
        .clone()
        .oneshot(
            Request::builder()
                .uri("/api/templates/00000000-0000-0000-0000-000000000000")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::NOT_FOUND);
}

#[tokio::test]
async fn set_template_public_toggles_and_is_owner_scoped() {
    let test_app = spawn_app().await;
    let video = upload_test_video(&test_app).await;
    let template_id = put_test_template(&test_app, video["id"].as_str().unwrap()).await;

    // No cookie at all.
    let unauthed = test_app
        .app
        .clone()
        .oneshot(
            Request::builder()
                .method("PATCH")
                .uri(format!("/api/templates/{template_id}"))
                .header("content-type", "application/json")
                .body(Body::from(json!({ "is_public": true }).to_string()))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(unauthed.status(), StatusCode::UNAUTHORIZED);

    // A different signed-in user — 403, not 404 (SPEC-CLOUD.md §4).
    let other_cookie = login_as(&test_app, "other@example.com").await;
    let forbidden = test_app
        .app
        .clone()
        .oneshot(
            Request::builder()
                .method("PATCH")
                .uri(format!("/api/templates/{template_id}"))
                .header("content-type", "application/json")
                .header("cookie", &other_cookie)
                .body(Body::from(json!({ "is_public": true }).to_string()))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(forbidden.status(), StatusCode::FORBIDDEN);

    make_template_public(&test_app, &template_id).await;

    let unknown = test_app
        .app
        .clone()
        .oneshot(
            authed(&test_app, Request::builder())
                .method("PATCH")
                .uri("/api/templates/00000000-0000-0000-0000-000000000000")
                .header("content-type", "application/json")
                .body(Body::from(json!({ "is_public": false }).to_string()))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(unknown.status(), StatusCode::NOT_FOUND);
}

#[tokio::test]
async fn template_clip_and_thumbnail_serve_only_once_public() {
    let test_app = spawn_app().await;
    let video = upload_test_video(&test_app).await;
    let template_id = put_test_template(&test_app, video["id"].as_str().unwrap()).await;

    let clip_before = test_app
        .app
        .clone()
        .oneshot(
            Request::builder()
                .uri(format!("/api/templates/{template_id}/clip"))
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(clip_before.status(), StatusCode::NOT_FOUND);
    let thumb_before = test_app
        .app
        .clone()
        .oneshot(
            Request::builder()
                .uri(format!("/api/templates/{template_id}/thumbnail"))
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(thumb_before.status(), StatusCode::NOT_FOUND);

    make_template_public(&test_app, &template_id).await;

    let clip_after = test_app
        .app
        .clone()
        .oneshot(
            Request::builder()
                .uri(format!("/api/templates/{template_id}/clip"))
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(clip_after.status(), StatusCode::OK);
    let thumb_after = test_app
        .app
        .clone()
        .oneshot(
            Request::builder()
                .uri(format!("/api/templates/{template_id}/thumbnail"))
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(thumb_after.status(), StatusCode::OK);
    assert_eq!(
        thumb_after.headers().get("content-type").unwrap(),
        "image/jpeg"
    );
}

#[tokio::test]
async fn exporting_from_a_public_template_stamps_lineage_normalizes_locked_captions_and_bumps_use_count() {
    let test_app = spawn_app().await;
    let video = upload_test_video(&test_app).await;
    let template_id = put_test_template(&test_app, video["id"].as_str().unwrap()).await;
    make_template_public(&test_app, &template_id).await;

    // A second user — someone who doesn't own the template at all — is
    // exactly who this path exists for (SPEC-CLOUD.md §4: "loading a
    // template to pre-fill an export has no ownership check, only the
    // usual public-sharing check").
    let other_cookie = login_as(&test_app, "template-user@example.com").await;

    let request_body = json!({
        "template_id": template_id,
        "name": "from a template",
        "captions": [
            {
                "id": "c1",
                "startTime": 0.0,
                "endTime": 1.0,
                "text": "an attempted override",
                "fontFamily": "Impact, sans-serif",
                "fontSize": 99,
                "color": "#ff0000",
                "align": "left",
                "x": 0.1,
                "y": 0.1,
                "locked": false
            },
            {
                "id": "c2",
                "startTime": 0.0,
                "endTime": 1.0,
                "text": "a real edit",
                "fontFamily": "Impact, sans-serif",
                "fontSize": 28,
                "color": "#ffffff",
                "align": "center",
                "x": 0.5,
                "y": 0.88,
                "locked": false
            }
        ],
        "gif_range_start": 0.0,
        "gif_range_end": 1.0
    });
    let create_response = test_app
        .app
        .clone()
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/api/exports")
                .header("content-type", "application/json")
                .header("cookie", &other_cookie)
                .body(Body::from(request_body.to_string()))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(create_response.status(), StatusCode::ACCEPTED);
    let accepted: serde_json::Value = serde_json::from_slice(
        &axum::body::to_bytes(create_response.into_body(), usize::MAX)
            .await
            .unwrap(),
    )
    .unwrap();
    let export_id = accepted["export_id"].as_str().unwrap().to_string();

    let progress_response = tokio::time::timeout(
        std::time::Duration::from_secs(60),
        test_app.app.clone().oneshot(
            Request::builder()
                .uri(format!("/api/exports/{export_id}/progress"))
                .header("cookie", &other_cookie)
                .body(Body::empty())
                .unwrap(),
        ),
    )
    .await
    .expect("SSE stream did not close within the timeout")
    .unwrap();
    let body_bytes = axum::body::to_bytes(progress_response.into_body(), usize::MAX)
        .await
        .unwrap();
    let body_text = String::from_utf8(body_bytes.to_vec()).unwrap();
    let events = common::parse_sse_events(&body_text);
    let (last_event, last_data) = events.last().expect("expected at least one SSE event");
    assert_eq!(last_event, "complete", "export did not complete: {events:?}");
    let gif: serde_json::Value = serde_json::from_str(last_data).unwrap();

    assert!(gif["video_id"].is_null());
    assert_eq!(gif["template_id"], template_id);

    let captions_json = gif["captions_json"].as_str().unwrap();
    let captions: serde_json::Value = serde_json::from_str(captions_json).unwrap();
    let captions = captions.as_array().unwrap();
    let c1 = captions.iter().find(|c| c["id"] == "c1").unwrap();
    // The locked caption's client-submitted override is silently
    // discarded — the stored values are the template's own.
    assert_eq!(c1["text"], "locked caption");
    assert_eq!(c1["fontSize"], 28.0);
    assert_eq!(c1["locked"], true);
    let c2 = captions.iter().find(|c| c["id"] == "c2").unwrap();
    // The changeable caption's edit passes through untouched.
    assert_eq!(c2["text"], "a real edit");

    let template_response = test_app
        .app
        .clone()
        .oneshot(
            Request::builder()
                .uri(format!("/api/templates/{template_id}"))
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    let template_body: serde_json::Value = serde_json::from_slice(
        &axum::body::to_bytes(template_response.into_body(), usize::MAX)
            .await
            .unwrap(),
    )
    .unwrap();
    assert_eq!(template_body["use_count"], 1);
}

#[tokio::test]
async fn exporting_from_a_private_template_is_rejected() {
    let test_app = spawn_app().await;
    let video = upload_test_video(&test_app).await;
    let template_id = put_test_template(&test_app, video["id"].as_str().unwrap()).await;
    // Deliberately left private.

    let request_body = json!({
        "template_id": template_id,
        "name": "should not work",
        "captions": [],
        "gif_range_start": 0.0,
        "gif_range_end": 1.0
    });
    let response = test_app
        .app
        .clone()
        .oneshot(
            authed(&test_app, Request::builder())
                .method("POST")
                .uri("/api/exports")
                .header("content-type", "application/json")
                .body(Body::from(request_body.to_string()))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::NOT_FOUND);
}

#[tokio::test]
async fn export_requires_exactly_one_of_video_id_or_template_id() {
    let test_app = spawn_app().await;
    let video = upload_test_video(&test_app).await;
    let template_id = put_test_template(&test_app, video["id"].as_str().unwrap()).await;
    make_template_public(&test_app, &template_id).await;

    let neither = json!({
        "name": "neither",
        "captions": [],
        "gif_range_start": 0.0,
        "gif_range_end": 1.0
    });
    let neither_response = test_app
        .app
        .clone()
        .oneshot(
            authed(&test_app, Request::builder())
                .method("POST")
                .uri("/api/exports")
                .header("content-type", "application/json")
                .body(Body::from(neither.to_string()))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(neither_response.status(), StatusCode::BAD_REQUEST);

    let both = json!({
        "video_id": video["id"],
        "template_id": template_id,
        "name": "both",
        "captions": [],
        "gif_range_start": 0.0,
        "gif_range_end": 1.0
    });
    let both_response = test_app
        .app
        .clone()
        .oneshot(
            authed(&test_app, Request::builder())
                .method("POST")
                .uri("/api/exports")
                .header("content-type", "application/json")
                .body(Body::from(both.to_string()))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(both_response.status(), StatusCode::BAD_REQUEST);
}
