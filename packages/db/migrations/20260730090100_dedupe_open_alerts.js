/**
 * Two worker replicas ran alert-scan concurrently and raised the same
 * asset_offline alert twice. Resolves the later duplicates and lets the
 * database guarantee a single open alert per asset and type.
 */

exports.up = async (knex) => {
  const { rows: duplicates } = await knex.raw(`
    UPDATE alerts a
    SET status = 'resolved', resolved_at = now()
    FROM alerts keep
    WHERE keep.asset_id = a.asset_id
      AND keep.type = a.type
      AND keep.status = 'open'
      AND a.status = 'open'
      AND keep.id < a.id
    RETURNING a.id, keep.id AS kept_id
  `);
  for (const duplicate of duplicates) {
    await knex('audit_logs').insert({
      actor_type: 'migration',
      actor_id: '20260730090100_dedupe_open_alerts',
      action: 'alert.status.updated',
      entity_type: 'alert',
      entity_id: String(duplicate.id),
      before: { status: 'open' },
      after: { status: 'resolved' },
      note: `Duplicate of alert ${duplicate.kept_id} raised by concurrent alert-scan runs.`,
    });
  }

  await knex.raw(`
    CREATE UNIQUE INDEX alerts_open_asset_type_uq
    ON alerts (asset_id, type)
    WHERE status = 'open' AND asset_id IS NOT NULL
  `);
};

exports.down = async (knex) => {
  await knex.raw('DROP INDEX IF EXISTS alerts_open_asset_type_uq');
};
