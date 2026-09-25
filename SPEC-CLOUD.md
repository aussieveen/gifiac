# StrewthGif — Multi-Tenant AWS Specification

This document layers on top of [`SPEC.md`](SPEC.md), which stays the reference for single-user mechanics that don't change (caption editor, export pipeline, bulk import, URL-linked GIFs, etc.). `SPEC-CLOUD.md` specifies everything that changes to take StrewthGif from a single-user, no-auth, one-container tool on a home Unraid box to a multi-tenant, publicly-deployed service on AWS: pluggable auth, ownership, sharing, the admin area, the global library, AWS infrastructure, and the mandatory migration of Simon's existing archive.

**Launch posture: friends-only, trusted userbase.** Several things are deliberately deferred rather than designed now — see §11, Out of scope. Section numbers below reference `SPEC.md` sections directly where this document extends or supersedes them; otherwise sections are new.

This spec was assembled from a structured decision process on this repo's issue tracker — see the Appendix.

---

## 1. Architecture changes

Extends `SPEC.md` §1.

- **Compute**: a single EC2 instance, not ECS/Fargate — closest to today's one-container setup, no orchestration to learn for a friends-only launch.
- **Metadata DB**: moves from SQLite to **Postgres via RDS**. A public multi-tenant service needs the DB to survive independently of the app container across deploys/restarts, and needs concurrent-write headroom SQLite doesn't comfortably give under multiple simultaneous users. RDS Postgres is the standard, low-drama AWS default.
- **Source video storage**: moves from local disk to a **private S3 bucket** (see §6) — storage needs to scale independently of compute and survive instance replacement, same reasoning that moved the DB.
- **Finished output storage (R2)**: unchanged — still Cloudflare R2, public-read, zero egress fees, per `SPEC.md` §9.
- **Container/deploy pattern**: unchanged in shape — one Docker image, GHCR-published on push to `main`. What's new is how the running instance picks up a new image; see §8.

---

## 2. Auth & identity model

- **Pluggable from day one**: a `users` table plus a separate `identities(provider, provider_user_id, user_id)` table, rather than baking a `google_id` column directly onto `users`.
- **Google is the first (and for now only) provider** — the schema doesn't need to change to add a second provider later.
- **Sessions, not JWTs**: server-side session cookies. The usual JWT forcing function — stateless validation across many horizontally-scaled replicas — doesn't apply here (compute is a single EC2 instance, §1). Session cookies buy instant server-side revocation, which the admin disable-account action (§7) depends on.
  - Opaque session ID in an `HttpOnly` + `Secure` + `SameSite=Lax` cookie (frontend and backend share one origin, no cross-origin concern).
  - Session state lives in a Postgres `sessions` table: session id, `user_id`, created/last-active timestamps.
  - **Sliding 30-day expiry**, refreshed on each active request. Revocation (e.g. admin disabling an account) is just deleting the row.
  - Admin/role gating is a lookup, not baked into the session: session → `user_id` → `users.role`.
- **TLS is required**: Google OAuth redirect URIs must be HTTPS, ruling out a bare EC2 IP — see §8.

### Data model

`users`

| Column | Type | Notes |
|---|---|---|
| `id` | TEXT | PK, UUID v4 |
| `handle` | TEXT | unique, chosen at signup, locked permanently once set (see §5) |
| `role` | TEXT | e.g. `user` / `admin` |
| `created_at` | TEXT | ISO8601 |

`identities`

| Column | Type | Notes |
|---|---|---|
| `provider` | TEXT | e.g. `google` |
| `provider_user_id` | TEXT | the provider's own user id |
| `user_id` | TEXT | FK → `users.id` |
| | | PK on `(provider, provider_user_id)` |

`sessions`

| Column | Type | Notes |
|---|---|---|
| `id` | TEXT | PK, opaque session id (cookie value) |
| `user_id` | TEXT | FK → `users.id` |
| `created_at` | TEXT | ISO8601 |
| `last_active_at` | TEXT | ISO8601, refreshed per active request (sliding expiry) |

---

## 3. Ownership model

Plain `user_id` foreign key per resource (`videos`, `gifs`, templates). No team/workspace concept — nothing in the requirements implies collaborative/shared ownership; the model is owner-private-by-default with opt-in public sharing, which is an individual-ownership model throughout.

---

## 4. Sharing model & templates

**Source video is never shared, full stop.** Sharing stops at the output level — only finished gifs/templates can be made public. Source videos are often copyrighted footage grabbed for personal fair-use-style GIF-making; redistributing the raw video is a much bigger legal/hosting exposure than redistributing a short gif/template.

This forces a change to templates (`SPEC.md` §12): today a template is just the export-form payload (captions, in/out points, dimensions) resolved against the *original* video file, which can't work for someone without access to that private video.

**A template becomes a self-contained clipped asset.** At save time, the video is trimmed to exactly the template's start/end range, producing its own independent media file (not a reference into the longer source video). The template's thumbnail is the first frame of that trimmed clip, not an arbitrary frame from the original video's timeline. This is also a UX fix in its own right: today, opening a template still shows footage on either side of the in/out points from the original video; trimming at save time makes the template a true like-for-like re-creation of the original edit.

**Fixed vs. changeable captions** (`captions[].locked: boolean`, default `false`). Each caption in a template is independently marked locked or unlocked; the flag governs the whole caption object — text, timing (start/end), style, and position alike, no field-level split:
- **Fixed** (`locked: true`) captions — fully immutable to anyone but the creator; every field can only change by the creator overwriting the template itself.
- **Changeable** (`locked: false`, the default) captions — fully editable by whoever is using the template to pre-fill an export, every field, no restrictions.

**Editor UX**: a non-creator using someone else's template sees every caption, including fixed ones, in the caption list — fixed captions render read-only/disabled rather than being hidden, so the template's full layout stays visible and comprehensible.

**Enforcement is server-side, not just a UI toggle**: `templates.user_id` (below) gates the template's overwrite/delete endpoints — a non-creator's request is rejected with 403. Loading a template to pre-fill an export has no ownership check, only the usual public-sharing check. On export, the server silently normalizes away any client-submitted change to a fixed caption's fields rather than rejecting the request — it just applies the template's saved values for those fields and proceeds.

**Templates stay one-per-video** (unique constraint on `video_id` unchanged from `SPEC.md` §12).

### Data model

`templates` (replaces `SPEC.md` §12's `video_templates`)

| Column | Type | Notes |
|---|---|---|
| `id` | TEXT | PK, UUID v4 |
| `video_id` | TEXT | FK → `videos.id`, unique — one template per video |
| `user_id` | TEXT | FK → `users.id`, the creator |
| `clip_s3_key` | TEXT | the trimmed clip's own media file, produced at save time |
| `thumbnail_s3_key` | TEXT | first frame of the trimmed clip |
| `payload_json` | TEXT | export payload: captions (each carrying a `locked` boolean), gif range, output dimensions |
| `is_public` | INTEGER | boolean — opted into the global library (see §7) |
| `saved_at` | TEXT | ISO8601 |

`gifs` gains (extends `SPEC.md` §2):

| Column | Type | Notes |
|---|---|---|
| `user_id` | TEXT | FK → `users.id`, owner |
| `template_id` | TEXT | nullable FK → `templates.id`, `ON DELETE SET NULL` |
| `is_public` | INTEGER | boolean — opted into the global library |
| `use_count` | INTEGER | default `0` — see §7 |

`videos` gains `user_id` (FK → `users.id`).

**GIF↔template lineage.** `template_id` is stamped at export time whenever the export form was pre-filled from a template — edits to changeable captions never break the link, since the fixed/structural parts are guaranteed unchanged. "Started from this template" and "still true to this template" collapse into the same thing.

`gifs.video_id` is `NULL` when a GIF is exported from a template (same treatment as a bulk import, `SPEC.md` §7) — this covers the common case of exporting from a template you don't own the source video for; `template_id` carries the lineage instead.

**Re-editability extends to template-derived GIFs**: a GIF is reopenable in the caption editor if it has *either* a `video_id` (reopens against that video) *or* a `template_id` (reopens against the template's own trimmed clip media).

`template_id` is `ON DELETE SET NULL` and there is no deletion guard on templates — a creator can delete their template, or an admin can unpublish it, freely at any time. Already-exported GIFs are fully independent assets (own media, own `captions_json`) and simply lose the "made from this template" attribution when the template goes away. This also fully replaces `SPEC.md` §12's "a video can only be deleted if it has no template" guard, which no longer makes sense once templates own their own clip (see §6).

---

## 5. User profiles

Users get a **chosen, unique handle**, separate from their Google display name (which isn't unique, isn't guaranteed stable, and isn't URL-safe as-is). Pre-filled at signup with a slugified guess from the Google display name, editable before confirming, then **locked permanently** — no self-service rename. If a handle genuinely needs to change later, that's a manual admin action, not a feature this spec designs for.

Every handle gets a **public profile page** at `/u/:handle`, showing that user's opted-in-public gifs/templates — the same view as the global library, filtered to one `user_id`. This is where attribution links (§7) point.

**Profile contents**: handle, avatar (sourced directly from the Google OAuth payload — no separate avatar upload flow), and the public content list. No bio/description field.

---

## 6. Source video storage & lifecycle

Extends `SPEC.md` §3.

- Source videos move from local disk to a **private S3 bucket** (not public-read like the R2 output bucket).
- **Retention**: raw uploaded videos **auto-delete after 7 days** via an S3 lifecycle rule, regardless of whether a gif/template was made from them.
- A video that's been turned into a template is **not** subject to this TTL — per §4, saving a template produces its own independently-clipped asset, a separate, persistent asset class from the raw upload.
- Raw uploads and template clips live in **separate S3 prefixes/buckets** so the lifecycle rule can target one without touching the other.
- This supersedes `SPEC.md` §12's "a video can only be deleted if it has no template" guard entirely — see §4.

**Upload flow mechanics stay unchanged otherwise** (extends `SPEC.md` §3): browser does a multipart `POST` to Axum, which streams to local disk, runs `ffprobe` + thumbnail generation synchronously, inserts the DB row — identical to the current pipeline. The only addition: after the pipeline succeeds, the backend pushes the file to the S3 bucket above (reusing the existing `Storage`/`aws_sdk_s3` client pattern already used for R2 exports), then deletes the local temp copy. Local disk on the EC2 instance is just working scratch space for processing, not the persistence layer.

Direct-to-S3 presigned upload was considered and rejected: it doesn't reduce total bandwidth (the backend still has to fetch the bytes to run ffprobe/thumbnail), and it adds a pending-upload state machine and orphaned-upload cleanup a friends-only launch doesn't need yet.

---

## 7. Admin area

Owner-only. Covers:

- View every user's gifs/templates.
- Delete/unpublish any gif or template (the enforcement side of the moderation policy below).
- Disable a user account — the one urgent action if a bad actor ever shows up; cheap to spec as an admin-gated endpoint now rather than needing an emergency DB edit later.
- Per-user usage stats — gif count, creation frequency/recency — to see who the heaviest users are, ahead of ever needing quotas.

Heavier moderation tooling (report queues, audit logs) is deferred — see §11.

**Global library moderation policy**: publish-immediately, no pre-moderation gate. A user opting a gif/template into the global library goes live immediately; the admin delete/unpublish action above is the only after-the-fact control. Revisit if/when the volume of public content grows past a size where post-hoc moderation isn't enough.

**Content policy when an account is disabled**: disabling a user account and unpublishing content are independent admin actions.
- Disable only revokes the user's sessions and blocks further login/creation — it does **not** touch their existing public gifs/templates.
- A disabled user's already-public content, and their public profile page (`/u/:handle`), stay live and unchanged unless the admin separately unpublishes specific items. No visible "disabled" indicator appears anywhere — disabling is purely a backend access-control action, invisible to other visitors.

---

## 8. Global library

**Discovery/search UX**: a single uniform feed.
- One full-width live search bar, matching the existing name+caption `LIKE` search (`GET /api/gifs?q=`, `SPEC.md` §5), scoped across all users instead of one. No tags/categories.
- Two sort pills: **Newest** and **Most used**.
- GIFs and templates are peer tiles in the same grid, distinguished by a type badge. Clicking a tile opens a lightbox with attribution, created date, use count, and the primary action (Copy link for a GIF, Use this template for a template).
- When a GIF has an associated template, its lightbox also surfaces that template with a "Use this template" affordance — reachable both directly from the grid and contextually from a GIF made from it.

**Attribution**: global library items always show creator attribution — the creator's handle, linking to `/u/:handle` (§5). No anonymous opt-out; no per-item toggle to hide attribution. Simplest model, consistent with the friends-only trusted-userbase launch posture.

**Popularity/use-count**:
- **GIF "use"**: copy-link, copy-embed, or download — any of the three increments the same single `use_count`. Plain views don't count.
- **Template "use"**: applying it to start a new GIF. Viewing/browsing doesn't count.
- **Storage**: a plain `use_count` integer column on the row (`gifs.use_count`, `templates` — see §4), incremented in place (`UPDATE ... SET use_count = use_count + 1`). No events table, no history.
- **Dedup**: none — every qualifying action increments the counter, even repeats by the same person.
- **Auth**: the increment endpoint requires an authenticated caller.
- **Visibility**: the count is displayed on tiles (e.g. "42 uses"), not just used internally for sort order.
- **Implementation note**: today copy-link, copy-embed, and download are pure client-side actions (`frontend/src/Archive.tsx`) with zero backend call. This requires a new endpoint (e.g. `POST /api/gifs/{id}/use` and a template equivalent) that the frontend calls on each of those actions.

---

## 9. Frontend navigation

A single persistent top tab bar.

- One fixed header, always visible: logo, then flat tabs **My Library** / **Global Library** / **Admin** (Admin tab only rendered for the owner/admin account, per §7). Tabs are always all visible at once — no drilldown, no space-switching gesture.
- Content for whichever tab is active renders full-width below the header.
- A small avatar/name button on the header's right opens the current user's own public profile.
- Visiting a public profile — your own, or via a "by @handle" link from the global library — **replaces the whole page** (`/u/:handle`, §5) with a simple back link to return; it does not stay nested inside the tab-bar shell.

Two other structurally distinct variants (a sidebar app-shell; a GitHub-org-style space switcher) were prototyped and compared live before this one won; the prototype code is not part of this spec.

---

## 10. AWS infrastructure

### Compute & deployment mechanics

- Single EC2 instance (§1). The existing GHCR image publish pipeline (on push to `main`) doesn't change; what's new is how the running instance picks up a new image — it runs `docker compose pull && docker compose up -d` the same way it would on Unraid, triggered either by a small deploy step added to the GitHub Actions workflow (SSH or AWS SSM `send-command`) or by keeping something like Watchtower running on the instance.
- **Domain/TLS**: the existing domain is pointed at the instance. TLS via AWS ACM — required because Google OAuth redirect URIs must be HTTPS, ruling out a bare EC2 IP.

### Secrets management

- **Runtime secret storage**: AWS SSM Parameter Store (`SecureString`), holding only genuine secrets — Google OAuth client secret, RDS Postgres password, R2 access key ID/secret. Non-secret config (bucket names, public URLs, dir paths) stays as plain env vars in `docker-compose.yml`, unchanged.
- **Population mechanism**: the EC2 instance's IAM role reads those parameters (`aws ssm get-parameters --with-decryption`) via a small script run before `docker compose up -d` at each deploy, writing/overwriting a local `.env` file (`chmod 600`). The app's runtime is unchanged — it still reads plain env vars via docker-compose, same as today on Unraid.
- **GitHub Actions → AWS auth**: GitHub's OIDC provider assumes a narrowly-scoped IAM role (no static AWS access keys stored in GitHub secrets) to trigger the deploy step (`ssm:SendCommand` targeting this one instance).
- **S3 (source video bucket, §6)**: the backend authenticates via the same instance IAM role directly (SDK default credential chain) — no static access key/secret pair.
- **RDS Postgres**: static password auth, not RDS IAM database authentication — kept simple for a single-instance, friends-only launch; the password is stored in SSM like the others.
- **GHCR image pulls**: the package is already public, so no credential is needed on the instance for `docker compose pull`.

### Backup/DR

- **RDS Postgres**: automated backups with 7-day retention (includes point-in-time recovery), single-AZ (no automatic failover — consistent with the single-EC2, no-HA compute posture). Encryption at rest enabled.
- **Manual snapshots**: an explicit manual RDS snapshot taken immediately before the one-time SQLite→Postgres migration (§12), and adopted as a habit before future risky schema migrations.
- **S3 — raw video uploads** (7-day TTL class, §6): no versioning, no extra backup — ephemeral by design, trivially re-uploadable.
- **S3 — template-clip assets** (persistent class, §6): versioning enabled, with a lifecycle rule expiring noncurrent versions after 30 days to bound storage growth while keeping a rollback window for accidental overwrite/delete.
- **DR scope**: explicitly no cross-region replication, no formal RTO/RPO target, no scheduled restore-drill process. Disaster recovery means restoring RDS from the latest automated backup or manual snapshot; S3 durability is relied on in-region. Real DR machinery is deferred until usage/risk justifies it.

---

## 11. Out of scope

- **Quotas / rate-limiting / abuse-prevention enforcement** — deferred until real usage data justifies it; a friends-only trust launch doesn't need enforcement machinery yet.
- **Monetization / billing** — no plans until real AWS cost data is available.
- **Self-service account deletion** — out of scope for this launch. Account removal stays admin-only via the disable action (§7); there is no self-service delete button.
- **Self-service data export** — out of scope; no feature for a user to download their own gifs/templates/data. (Together with the point above: there is no account-deletion mechanism at all right now, self-service or admin — only disable, which already leaves public content untouched.)
- **Heavier moderation tooling** (report queues, audit logs, a moderation queue) — beyond the publish-immediately + admin-takedown policy in §7; deferred until the global library outgrows a friends-only trust model, which this launch's destination doesn't need to design for.

---

## 12. Existing data migration (hard requirement)

Simon's existing archive (SQLite metadata + R2-hosted GIF/MP4/WebM outputs, on the Unraid box) **must** migrate into the new system as his account's content — this is not optional; losing his own archive to launch a version for other people is not an acceptable trade.

This is a one-time, bounded, scriptable migration:
- SQLite rows → Postgres rows tagged with his `user_id`.
- R2 outputs stay in place or get copied to whatever bucket structure the new system uses.
- His templated videos are explicitly included: per §4, templates move from "time-offsets into a video" to "their own clipped asset," so the migration must *produce* that new shape for his existing templates — actually clip the source video to the template's in/out range and store it as the new self-contained asset, not just copy the old rows across unchanged.
- A manual RDS snapshot is taken immediately before this migration runs (§10, Backup/DR).

---

## 13. Branching & release strategy

All implementation work for this effort happens on a separate, long-lived development branch (`multi-tenant-aws`) — not incrementally on `main`. `main` keeps shipping the current single-user release (still auto-published to GHCR on every push, per `SPEC.md` §11) untouched throughout. Once the multi-tenant AWS version is fully built and ready, it merges into `main` in one big-bang launch, rather than trickling out partially-built multi-user features to the existing single-user deployment.

This applies to any code produced along the way too — e.g. throwaway or semi-throwaway prototype UI/logic built while deciding on frontend navigation (§9) or discovery UX (§8) — all of it targets this dev branch, never `main`.

---

## 14. Favourites & personal saved library

Extends §8 (Global library) and §9 (Frontend navigation). Lets a user save someone else's gif to a personal list, browse it, and remove items from it, without editing or remixing the underlying gif (opening a saved gif in the caption editor to fork it is a separate, larger feature involving derived-content ownership/attribution, and is explicitly out of scope for this destination).

**What's favouritable**: a gif opted into the global library (`is_public`), or a gif the caller owns themselves — public or private. The only thing that stays off-limits is another user's *private* gif. Favouriting your own gif is a little redundant with it already living in My Library, but it's allowed for consistency — one star component and one rule everywhere a gif card renders, rather than special-casing "this is your own gif."

**Where it lives in the UI**: no new top-level nav tab — §9's three flat tabs (My Library / Global Library / Admin) are unchanged. Instead, **My Library** gains a segmented mode toggle at the top of the page: **My GIFs** (today's owner-scoped view, unchanged) and **Favourites**. Switching modes swaps the whole dataset and toolbar rather than filtering client-side — unlike the existing All/Public/Private/One-offs chips, which filter one already-fetched list of the caller's own gifs, "Favourites" pulls a different dataset (other users' public gifs, plus any of the caller's own gifs they've favourited) via its own endpoint (below). There's deliberately no "Favourites" entry among the All/Public/Private/One-offs chips within "My GIFs" — favouriting one of your own gifs surfaces it in the Favourites mode, not as a further filter on the mode you're already in.

- A star icon renders on every gif card, everywhere one appears: Global Library, My Library (both "My GIFs" and "Favourites" modes), and public profile pages (`/u/:handle`, §5) — one control, no per-surface variation.
  - On a grid thumbnail: a small circular badge in the corner, hidden unless the gif is favourited (filled) or, on desktop, the card is hovered/focused (a muted outline reveal, so the star can be toggled straight from the grid).
  - In the detail panel: a small square icon-button next to the existing "Copy link" primary action (not replacing it, and not full-width), styled like the app's other secondary buttons (neutral border) — an outline star when not favourited, filled in the app's accent color when favourited. Embed/Download stay as the unchanged secondary row below.
  - Toggling from either surface (grid or detail panel) updates both immediately — they render off one shared per-viewer state, never drift independently.
- **Favourites empty state**: an outline star icon, "No favourites yet," a line pointing at the Global Library's star action, and a "Browse Global Library" link.
- **Favourites sort**: newest-favourited first only (ordered by when it was favourited, not the gif's own creation date) — no secondary "Most used"-style sort yet, matching the presence/absence-only data model below. Revisit if a richer Favourites view (sort, filter, search) turns out to be missed; not designed now.

**Un-publishing is not the same as deleting.** If the owner of a gif you've favourited later makes it private again, it disappears from your Favourites view — but the favourite row itself isn't touched. If they re-publish it later, it silently reappears. Only an actual gif deletion removes the favourite row for good (see Data model).

### Data model

`favourites` (new table)

| Column | Type | Notes |
|---|---|---|
| `user_id` | TEXT | FK → `users.id`, `ON DELETE CASCADE` |
| `gif_id` | TEXT | FK → `gifs.id`, `ON DELETE CASCADE` |
| `created_at` | TEXT | ISO8601 — when the gif was favourited; drives Favourites' sort order |
| | | PK on `(user_id, gif_id)` |

Deleting a user or a gif cascades away their favourite rows — no tombstones. Un-publishing a gif (`is_public` flipping to `false`) does **not** touch its favourite rows; visibility is enforced at read time instead (below), which is what makes the reappear-on-republish behavior fall out for free.

### API surface

- `POST /api/gifs/{id}/favourite` — save, idempotent (saving twice is a no-op). `DELETE /api/gifs/{id}/favourite` — remove, idempotent. Both mirror the existing `POST /api/gifs/{id}/use` pattern (§8): they return the updated gif view so the frontend can sync local state without a re-fetch. Both enforce the favouritable-scope rule above server-side — a request against a gif that's neither public nor owned by the caller gets `404 Not Found`, the same treatment `db::get_gif`'s owner-scoped lookup already gives an invisible resource, so as not to confirm a private gif's existence.
- `GET /api/favourites` (new, auth required) — the caller's saved gifs, in the same attributed row shape `GET /api/library` already returns (a saved gif may be the caller's own or someone else's), filtered to gifs currently visible to the caller and sorted newest-favourited-first.
- Every gif-card response gains a per-viewer `isFavourited: bool`, computed per-request from the caller's set of favourited gif ids:
  - `GET /api/gifs` (My Library) — already authenticated, no change to its auth requirement.
  - `GET /api/library` (Global Library) and `GET /api/profiles/{slug}` (public profiles) — both switch from fully anonymous to the `OptionalCurrentUser` extractor (already defined in the auth module, previously only used by `/auth/me`): a logged-out viewer still browses freely and just gets `isFavourited: false` on every item.

---

## Appendix: process record

This spec was assembled from a structured decision process on this repo's issue tracker: **Map: Gifiac multi-tenant AWS launch** ([issue #1](https://github.com/aussieveen/gifiac/issues/1)) and its 23 resolved child tickets (issues #2–#24), each holding the full question, reasoning, and resolution behind one decision above. `SPEC.md` itself was not edited by this effort — only referenced; reconciling/merging the two documents is a follow-up outside this effort's scope.

§14 (Favourites & personal saved library) was assembled from a second, later decision process on the same tracker: **Map: Favourite GIFs and personal saved library** ([issue #26](https://github.com/aussieveen/gifiac/issues/26)), itself charted from a feature request ([issue #25](https://github.com/aussieveen/gifiac/issues/25)), and its three resolved child tickets ([#27](https://github.com/aussieveen/gifiac/issues/27), [#28](https://github.com/aussieveen/gifiac/issues/28), [#29](https://github.com/aussieveen/gifiac/issues/29)).
