import { pool } from './database';
import { startReconciliationScheduler } from './jobs/reconciliation_scheduler';

const stop = startReconciliationScheduler({
  info: (fields, message) => console.info(JSON.stringify({ level: 'info', message, fields })),
  error: (error, message) => console.error(JSON.stringify({ level: 'error', message, error: String(error) })),
});

let stopping = false;
async function shutdown() {
  if (stopping) return;
  stopping = true;
  stop();
  await pool.end();
}

for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.once(signal, () => {
    shutdown().then(() => process.exit(0)).catch((error: unknown) => {
      console.error('Worker shutdown failed:', error);
      process.exit(1);
    });
  });
}

console.info('Reconciliation worker started; scheduled daily at 02:00 UTC.');
