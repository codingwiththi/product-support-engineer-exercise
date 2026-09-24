const db = require('../../db/knex');
const { log, hostname } = require('./logger');

/**
 * Runs one job execution: records the run in the jobs table, forwards log
 * lines, and captures failures with their database error details when
 * present.
 */
async function runJob(definition, scheduledFor) {
  // Worker replicas each run the scheduler; a session advisory lock held for
  // the whole run ensures only one of them executes a given job at a time.
  const lockConnection = await db.client.acquireConnection();
  try {
    const { rows } = await lockConnection.query(
      'SELECT pg_try_advisory_lock(hashtext($1)) AS locked',
      [definition.name]
    );
    if (!rows[0].locked) {
      log(null, 'info', `${definition.name} skipped — already running on another worker`, {});
      return { ok: true };
    }
    try {
      return await executeJob(definition, scheduledFor);
    } finally {
      await lockConnection.query('SELECT pg_advisory_unlock(hashtext($1))', [definition.name]);
    }
  } finally {
    await db.client.releaseConnection(lockConnection);
  }
}

async function executeJob(definition, scheduledFor) {
  const [job] = await db('jobs')
    .insert({
      name: definition.name,
      status: 'running',
      scheduled_for: scheduledFor,
      started_at: db.fn.now(),
      hostname,
    })
    .returning('id');

  const jobLog = (level, message, context) => log(job.id, level, message, context);

  try {
    const metadata = await definition.run({ log: jobLog });
    await db('jobs')
      .where({ id: job.id })
      .update({ status: 'completed', finished_at: db.fn.now(), metadata: metadata || {} });
    return { ok: true };
  } catch (err) {
    await db('jobs')
      .where({ id: job.id })
      .update({ status: 'failed', finished_at: db.fn.now(), error: err.message });
    const context = {};
    if (err.code) context.code = err.code;
    if (err.hint) context.hint = err.hint;
    jobLog(
      'error',
      `${definition.failureMessage || definition.name + ' failed'}: ${err.message}`,
      context
    );
    return { ok: false };
  }
}

module.exports = { runJob };
