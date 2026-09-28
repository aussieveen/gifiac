//! One-off backfill for gifs exported before `exports::run_pipeline`
//! started stamping `template_id` onto the gif that produced a template
//! (Flow A + "Also save as a template"), not just gifs later started
//! *from* one (Flow B, which already set it at insert time). Anything
//! exported since that fix already has correct lineage, so this only ever
//! needs a single run against production.
//!
//! Safe to re-run: it's a single conditional `UPDATE` (`db::backfill_gif_template_lineage`)
//! that only touches gifs still missing `template_id`, so a second run is
//! just a no-op.

use std::process::ExitCode;

use anyhow::Result;
use gifiac_backend::config::Config;
use gifiac_backend::db;

async fn run() -> Result<()> {
    let config = Config::from_env();
    let pool = db::create_pool(&config.database_url).await?;

    let updated = db::backfill_gif_template_lineage(&pool).await?;
    println!("done: stamped template_id onto {updated} gif(s)");
    Ok(())
}

#[tokio::main]
async fn main() -> ExitCode {
    tracing_subscriber::fmt::init();
    match run().await {
        Ok(()) => ExitCode::SUCCESS,
        Err(err) => {
            eprintln!("backfill aborted: {err:#}");
            ExitCode::FAILURE
        }
    }
}
