Type: research
Status: resolved
Assignee: claude (this session)

## Question

The user wants to do a one-time migration of their existing GIF library from Giphy into Gifiac's archive — they have no local copies, everything currently exists only on Giphy's platform under their account.

Research Giphy's public API to establish what's actually possible:
- Can a user enumerate the GIFs *they themselves* created/uploaded via the API (not just search Giphy's general catalog)? What endpoint, and what auth (API key, OAuth, username-based) does it require?
- What metadata does the API expose per GIF — title, tags/caption-like text, creation date, direct downloadable file URL(s) (original GIF, and any MP4/WebM variant Giphy already generated)?
- Rate limits that would matter for a bulk one-time pull of "a BUNCH" of GIFs (dozens to low hundreds, order of magnitude TBD by the user).
- Any terms-of-service constraint on bulk-downloading a user's own uploaded content for personal archival.

Produce a markdown summary of findings with a clear recommendation on feasibility (straightforward / possible with caveats / not really supported), since the answer determines whether "Giphy import" becomes a real design ticket or gets pushed out of scope.

## Answer

**Verdict: possible with caveats.** Full findings, with citations to Giphy's official API docs and Terms of Service: [09-giphy-import-feasibility.md](../assets/09-giphy-import-feasibility.md).

**Technically sound**: no OAuth needed — a plain beta API key enumerates a user's own uploads via `q=@<giphy-username>` search (or Channel Search + `channel_ids`). Each GIF exposes `title`, `alt_text`, three timestamp fields, and direct download URLs for both the original GIF and a Giphy-transcoded MP4 (`images.original.mp4`). No WebM rendition exists (GIF/MP4/WebP only — WebM would need local transcoding), and there's no tags/keyword field (only `title`/`alt_text`). The 100-calls/hour beta rate limit comfortably covers a one-time pull of dozens to a couple hundred GIFs.

**The real blocker is legal/policy, not technical.** Giphy's API docs explicitly prohibit caching/storing copies of GIPHY media assets without prior written partner approval, and the API Terms of Service separately forbid using API-obtained content to build "a database, directory, or index containing GIFs" — with no exception for content the user personally uploaded and owns. A one-time personal export is low-risk relative to what these terms clearly target (competing catalogs, commercial redistribution), but the public API/ToS does not affirmatively sanction it.

Graduated into [Giphy import design](10-giphy-import-design.md), which needs to put the ToS caveat to the user directly (accept the risk vs. an alternative approach) before settling the remaining schema/UX questions.
