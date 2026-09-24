const db = require('../../db/knex');
const { isOffline, ALERT_TYPES } = require('@metris/shared');

/**
 * Evaluates connector heartbeats and raises asset_offline alerts for assets
 * that have gone quiet. An alert is only raised while no open alert of the
 * same type exists for the asset.
 */
module.exports = async function alertScan({ log }) {
  const referenceTime = new Date().toISOString();
  const connectors = await db('connector_assets')
    .join('assets', 'assets.id', 'connector_assets.asset_id')
    .join('sites', 'sites.id', 'assets.site_id')
    .where('assets.status', 'active')
    .select(
      'connector_assets.last_seen_at',
      'connector_assets.external_id',
      'assets.id as asset_id',
      'assets.name as asset_name',
      'assets.site_id',
      'sites.name as site_name'
    );

  let raised = 0;
  for (const connector of connectors) {
    if (!isOffline(connector.last_seen_at, referenceTime)) continue;

    const existing = await db('alerts')
      .where({ asset_id: connector.asset_id, type: ALERT_TYPES.ASSET_OFFLINE, status: 'open' })
      .first();
    if (existing) continue;

    // alerts_open_asset_type_uq closes the race between the check above and
    // this insert when another run evaluates the same asset.
    const inserted = await db('alerts')
      .insert({
        site_id: connector.site_id,
        asset_id: connector.asset_id,
        type: ALERT_TYPES.ASSET_OFFLINE,
        severity: 'critical',
        status: 'open',
        message: `No data received from ${connector.asset_name} (${connector.site_name}) for more than 6 hours. Last seen ${connector.last_seen_at ? new Date(connector.last_seen_at).toISOString() : 'never'}.`,
        triggered_at: db.fn.now(),
      })
      .onConflict(db.raw("(asset_id, type) WHERE status = 'open' AND asset_id IS NOT NULL"))
      .ignore()
      .returning('id');
    if (inserted.length === 0) continue;
    raised += 1;
    log(
      'info',
      `Raised asset_offline alert for asset ${connector.external_id} (${connector.site_name} / ${connector.asset_name})`,
      {
        external_id: connector.external_id,
        last_seen_at: connector.last_seen_at,
      }
    );
  }

  log(
    'info',
    `alert-scan completed: ${raised} alert(s) raised, ${connectors.length} assets evaluated`,
    {
      alerts_raised: raised,
    }
  );
  return { assets_evaluated: connectors.length, alerts_raised: raised };
};
