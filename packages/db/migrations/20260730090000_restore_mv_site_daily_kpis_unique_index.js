/**
 * 20260727053100 recreated mv_site_daily_kpis without its unique index.
 * REFRESH MATERIALIZED VIEW CONCURRENTLY requires one, so every nightly
 * refresh since has failed and the dashboard has served the 2026-07-27
 * snapshot. Restores the index and rebuilds the rollup once.
 */

exports.up = async (knex) => {
  await knex.raw(`
    CREATE UNIQUE INDEX IF NOT EXISTS mv_site_daily_kpis_site_day_uq
    ON mv_site_daily_kpis (site_id, day)
  `);
  await knex.raw('REFRESH MATERIALIZED VIEW mv_site_daily_kpis');
};

exports.down = async (knex) => {
  await knex.raw('DROP INDEX IF EXISTS mv_site_daily_kpis_site_day_uq');
};
