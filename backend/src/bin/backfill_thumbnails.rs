//! One-off backfill (see 0015_gif_thumbnails.sql / thumbnails.rs) for linked
//! gifs that existed before the thumbnail pipeline did — anything created
//! by `POST /api/gifs/link` since gets its thumbnail generated
//! automatically in the background, so this only ever needs a single run
//! against production, plus (if you want to retry ones that failed the
//! first time) an occasional manual re-run.
//!
//! Safe to re-run: only processes gifs currently `pending` (never
//! attempted) — a `ready` or `failed` gif is left alone. To retry `failed`
//! gifs specifically, flip them back to `pending` in the database first
//! (deliberately not automated — see SPEC's "leave as failed" decision).

use std::process::ExitCode;

use anyhow::Result;
use gifiac_backend::config::Config;
use gifiac_backend::{db, link_check, storage, thumbnails};

async fn run() -> Result<bool> {
    let config = Config::from_env();
    let pool = db::create_pool(&config.database_url).await?;

    let r2 = storage::R2Config::from_env()?;
    let storage = storage::Storage::new(
        &r2.endpoint_url(),
        &r2.bucket_name,
        Some(&r2.public_base_url),
        &r2.access_key_id,
        &r2.secret_access_key,
    );
    let http_client = link_check::build_client()?;

    let gifs = db::list_gifs_needing_thumbnail(&pool).await?;
    println!("found {} linked gif(s) needing a thumbnail", gifs.len());

    let mut failed = 0;
    for gif in &gifs {
        let external_url = gif
            .external_url
            .as_deref()
            .expect("list_gifs_needing_thumbnail only returns linked gifs");
        print!("generating thumbnail for {} ({external_url})... ", gif.id);
        match thumbnails::generate_and_store(&pool, &storage, &http_client, &gif.id, external_url).await {
            Ok(true) => println!("ready"),
            Ok(false) => {
                println!("failed");
                failed += 1;
            }
            Err(err) => {
                println!("error: {err:#}");
                failed += 1;
            }
        }
    }

    println!("done: {} succeeded, {failed} failed", gifs.len() - failed);
    Ok(failed > 0)
}

#[tokio::main]
async fn main() -> ExitCode {
    tracing_subscriber::fmt::init();
    match run().await {
        Ok(had_failures) => {
            if had_failures {
                ExitCode::FAILURE
            } else {
                ExitCode::SUCCESS
            }
        }
        Err(err) => {
            eprintln!("backfill aborted: {err:#}");
            ExitCode::FAILURE
        }
    }
}
