use axum::body::Body;
use axum::http::{Request, StatusCode};
use serde_json::json;
use tower::ServiceExt;

mod common;
use common::{authed, create_gif, login_as, login_as_admin, spawn_app, upload_test_video};

/// Puts a bare template on a fresh video, owned by `test_app`'s default
/// owner, and returns its own id (looked up via SQL — same reason
/// `templates_api.rs`'s own helper does, `PUT /api/videos/{id}/template`
/// doesn't return one).
async fn put_test_template(test_app: &common::TestApp) -> String {
    let video = upload_test_video(test_app).await;
    let video_id = video["id"].as_str().unwrap();
    let payload = json!({
        "captions": [],
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

/// Looks a user up in `GET /api/admin/users` by email and returns its id —
/// every admin test needs a real id to act on, and the users listing is
/// the only way this API surface exposes one.
async fn find_user_id(test_app: &common::TestApp, admin_cookie: &str, email: &str) -> String {
    let response = test_app
        .app
        .clone()
        .oneshot(
            Request::builder()
                .uri("/api/admin/users")
                .header("cookie", admin_cookie)
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    let users: serde_json::Value = serde_json::from_slice(
        &axum::body::to_bytes(response.into_body(), usize::MAX)
            .await
            .unwrap(),
    )
    .unwrap();
    users
        .as_array()
        .unwrap()
        .iter()
        .find(|u| u["email"] == email)
        .unwrap()["id"]
        .as_str()
        .unwrap()
        .to_string()
}

#[tokio::test]
async fn admin_routes_require_auth_and_admin_role() {
    let test_app = spawn_app().await;

    let no_cookie = test_app
        .app
        .clone()
        .oneshot(
            Request::builder()
                .uri("/api/admin/users")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(no_cookie.status(), StatusCode::UNAUTHORIZED);

    // `owner_cookie` is a plain, non-admin user (SPEC-CLOUD.md §7: no
    // auto-promotion) — every admin route must reject it with 403.
    let non_admin = test_app
        .app
        .clone()
        .oneshot(
            authed(&test_app, Request::builder())
                .uri("/api/admin/users")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(non_admin.status(), StatusCode::FORBIDDEN);
}

#[tokio::test]
async fn admin_can_list_users_with_gif_count_stats() {
    let test_app = spawn_app().await;
    let admin_cookie = login_as_admin(&test_app, "admin@example.com").await;
    let _other_cookie = login_as(&test_app, "member@example.com").await;
    create_gif(&test_app, "an owner gif", "").await;

    let response = test_app
        .app
        .clone()
        .oneshot(
            Request::builder()
                .uri("/api/admin/users")
                .header("cookie", &admin_cookie)
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    let users: serde_json::Value = serde_json::from_slice(
        &axum::body::to_bytes(response.into_body(), usize::MAX)
            .await
            .unwrap(),
    )
    .unwrap();
    let users = users.as_array().unwrap();
    // spawn_app's default owner, the admin itself, and this test's member.
    assert_eq!(users.len(), 3);
    let owner_row = users.iter().find(|u| u["email"] == "owner@example.com").unwrap();
    assert_eq!(owner_row["gif_count"], 1);
    let member_row = users.iter().find(|u| u["email"] == "member@example.com").unwrap();
    assert_eq!(member_row["gif_count"], 0);
    assert!(member_row["latest_gif_at"].is_null());
}

#[tokio::test]
async fn disabling_a_user_revokes_their_session_immediately() {
    let test_app = spawn_app().await;
    let admin_cookie = login_as_admin(&test_app, "admin@example.com").await;
    let target_cookie = login_as(&test_app, "target@example.com").await;
    let target_id = find_user_id(&test_app, &admin_cookie, "target@example.com").await;

    // Still valid before disabling.
    let before = test_app
        .app
        .clone()
        .oneshot(
            Request::builder()
                .uri("/api/gifs")
                .header("cookie", &target_cookie)
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(before.status(), StatusCode::OK);

    let disable_response = test_app
        .app
        .clone()
        .oneshot(
            Request::builder()
                .method("PATCH")
                .uri(format!("/api/admin/users/{target_id}"))
                .header("content-type", "application/json")
                .header("cookie", &admin_cookie)
                .body(Body::from(json!({ "disabled": true }).to_string()))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(disable_response.status(), StatusCode::OK);
    let body: serde_json::Value = serde_json::from_slice(
        &axum::body::to_bytes(disable_response.into_body(), usize::MAX)
            .await
            .unwrap(),
    )
    .unwrap();
    assert_eq!(body["disabled"], true);

    // The session that was valid a moment ago is gone now.
    let after = test_app
        .app
        .clone()
        .oneshot(
            Request::builder()
                .uri("/api/gifs")
                .header("cookie", &target_cookie)
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(after.status(), StatusCode::UNAUTHORIZED);
}

#[tokio::test]
async fn re_enabling_a_user_clears_the_flag() {
    let test_app = spawn_app().await;
    let admin_cookie = login_as_admin(&test_app, "admin@example.com").await;
    let _target_cookie = login_as(&test_app, "target@example.com").await;
    let target_id = find_user_id(&test_app, &admin_cookie, "target@example.com").await;

    for disabled in [true, false] {
        let response = test_app
            .app
            .clone()
            .oneshot(
                Request::builder()
                    .method("PATCH")
                    .uri(format!("/api/admin/users/{target_id}"))
                    .header("content-type", "application/json")
                    .header("cookie", &admin_cookie)
                    .body(Body::from(json!({ "disabled": disabled }).to_string()))
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
        assert_eq!(body["disabled"], disabled);
    }
}

#[tokio::test]
async fn setting_disabled_for_an_unknown_user_returns_404() {
    let test_app = spawn_app().await;
    let admin_cookie = login_as_admin(&test_app, "admin@example.com").await;

    let response = test_app
        .app
        .clone()
        .oneshot(
            Request::builder()
                .method("PATCH")
                .uri("/api/admin/users/00000000-0000-0000-0000-000000000000")
                .header("content-type", "application/json")
                .header("cookie", &admin_cookie)
                .body(Body::from(json!({ "disabled": true }).to_string()))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::NOT_FOUND);
}

#[tokio::test]
async fn admin_can_list_delete_and_unpublish_another_users_gif() {
    let test_app = spawn_app().await;
    let admin_cookie = login_as_admin(&test_app, "admin@example.com").await;
    let gif = create_gif(&test_app, "someone else's gif", "").await;
    let owner_id = find_user_id(&test_app, &admin_cookie, "owner@example.com").await;
    let gif_id = gif["id"].as_str().unwrap();

    let list_response = test_app
        .app
        .clone()
        .oneshot(
            Request::builder()
                .uri(format!("/api/admin/users/{owner_id}/gifs"))
                .header("cookie", &admin_cookie)
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(list_response.status(), StatusCode::OK);
    let gifs: serde_json::Value = serde_json::from_slice(
        &axum::body::to_bytes(list_response.into_body(), usize::MAX)
            .await
            .unwrap(),
    )
    .unwrap();
    assert_eq!(gifs.as_array().unwrap().len(), 1);

    // Make it public first, so unpublish has something to actually undo.
    test_app
        .app
        .clone()
        .oneshot(
            authed(&test_app, Request::builder())
                .method("PATCH")
                .uri(format!("/api/gifs/{gif_id}"))
                .header("content-type", "application/json")
                .body(Body::from(json!({ "is_public": true }).to_string()))
                .unwrap(),
        )
        .await
        .unwrap();

    let unpublish_response = test_app
        .app
        .clone()
        .oneshot(
            Request::builder()
                .method("POST")
                .uri(format!("/api/admin/gifs/{gif_id}/unpublish"))
                .header("cookie", &admin_cookie)
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(unpublish_response.status(), StatusCode::OK);
    let unpublished: serde_json::Value = serde_json::from_slice(
        &axum::body::to_bytes(unpublish_response.into_body(), usize::MAX)
            .await
            .unwrap(),
    )
    .unwrap();
    assert_eq!(unpublished["is_public"], false);

    let delete_response = test_app
        .app
        .clone()
        .oneshot(
            Request::builder()
                .method("DELETE")
                .uri(format!("/api/admin/gifs/{gif_id}"))
                .header("cookie", &admin_cookie)
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(delete_response.status(), StatusCode::NO_CONTENT);

    // Gone even from the owner's own (owner-scoped) view.
    let get_response = test_app
        .app
        .clone()
        .oneshot(
            authed(&test_app, Request::builder())
                .uri(format!("/api/gifs/{gif_id}"))
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(get_response.status(), StatusCode::NOT_FOUND);
}

#[tokio::test]
async fn admin_can_list_and_delete_another_users_template() {
    let test_app = spawn_app().await;
    let admin_cookie = login_as_admin(&test_app, "admin@example.com").await;
    let template_id = put_test_template(&test_app).await;
    let owner_id = find_user_id(&test_app, &admin_cookie, "owner@example.com").await;

    let list_response = test_app
        .app
        .clone()
        .oneshot(
            Request::builder()
                .uri(format!("/api/admin/users/{owner_id}/templates"))
                .header("cookie", &admin_cookie)
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(list_response.status(), StatusCode::OK);
    let templates: serde_json::Value = serde_json::from_slice(
        &axum::body::to_bytes(list_response.into_body(), usize::MAX)
            .await
            .unwrap(),
    )
    .unwrap();
    let templates = templates.as_array().unwrap();
    assert_eq!(templates.len(), 1);
    assert_eq!(templates[0]["id"], template_id);

    // SPEC-CLOUD.md §10: put_test_template's PUT already backed the
    // template's clip/thumbnail/filmstrip up to S3 — confirm they're
    // there before the admin delete below removes them.
    let template_uuid = uuid::Uuid::parse_str(&template_id).unwrap();
    let scratch = tempfile::tempdir().unwrap();
    for (key, label) in [
        (gifiac_backend::paths::template_clip_object_key(&template_uuid), "clip"),
        (
            gifiac_backend::paths::template_thumbnail_object_key(&template_uuid),
            "thumbnail",
        ),
        (
            gifiac_backend::paths::template_filmstrip_object_key(&template_uuid),
            "filmstrip",
        ),
    ] {
        test_app
            .template_assets_storage
            .download_file(&key, &scratch.path().join(label))
            .await
            .unwrap_or_else(|e| panic!("expected template {label} backed up to S3 at {key}: {e}"));
    }

    let delete_response = test_app
        .app
        .clone()
        .oneshot(
            Request::builder()
                .method("DELETE")
                .uri(format!("/api/admin/templates/{template_id}"))
                .header("cookie", &admin_cookie)
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(delete_response.status(), StatusCode::NO_CONTENT);

    let after_delete: Option<String> = sqlx::query_scalar("SELECT id FROM templates WHERE id = $1")
        .bind(&template_id)
        .fetch_optional(&test_app.pool)
        .await
        .unwrap();
    assert!(after_delete.is_none());

    for key in [
        gifiac_backend::paths::template_clip_object_key(&template_uuid),
        gifiac_backend::paths::template_thumbnail_object_key(&template_uuid),
        gifiac_backend::paths::template_filmstrip_object_key(&template_uuid),
    ] {
        let result = test_app
            .template_assets_storage
            .download_file(&key, &scratch.path().join("should-not-exist"))
            .await;
        assert!(result.is_err(), "expected {key} to have been deleted from S3 by the admin delete");
    }
}

#[tokio::test]
async fn deleting_an_unknown_template_as_admin_returns_404() {
    let test_app = spawn_app().await;
    let admin_cookie = login_as_admin(&test_app, "admin@example.com").await;

    let response = test_app
        .app
        .clone()
        .oneshot(
            Request::builder()
                .method("DELETE")
                .uri("/api/admin/templates/00000000-0000-0000-0000-000000000000")
                .header("cookie", &admin_cookie)
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::NOT_FOUND);
}

#[tokio::test]
async fn deleting_an_unknown_gif_as_admin_returns_404() {
    let test_app = spawn_app().await;
    let admin_cookie = login_as_admin(&test_app, "admin@example.com").await;

    let response = test_app
        .app
        .clone()
        .oneshot(
            Request::builder()
                .method("DELETE")
                .uri("/api/admin/gifs/00000000-0000-0000-0000-000000000000")
                .header("cookie", &admin_cookie)
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::NOT_FOUND);
}
