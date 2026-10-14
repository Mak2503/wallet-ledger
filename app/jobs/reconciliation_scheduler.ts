import { FastifyBaseLogger } from 'fastify';
import { runReconciliation } from '../services/reconciliation_service';

const RUN_HOUR_UTC = 2;

function millisecondsUntilNextRun(now: Date): number {
  const next = new Date(now);
  next.setUTCHours(RUN_HOUR_UTC, 0, 0, 0);
  if (next <= now) next.setUTCDate(next.getUTCDate() + 1);
  return next.getTime() - now.getTime();
}

export function startReconciliationScheduler(logger: FastifyBaseLogger): () => void {
  let timer: NodeJS.Timeout;
  let stopped = false;
  const schedule = (): void => {
    if (stopped) return;
    timer = setTimeout(async () => {
      try {
        const result = await runReconciliation();
        logger.info({ result }, 'scheduled reconciliation finished');
      } catch (error) {
        logger.error(error, 'scheduled reconciliation failed');
      }
      schedule();
    }, millisecondsUntilNextRun(new Date()));
    timer.unref();
  };
  schedule();
  return () => {
    stopped = true;
    clearTimeout(timer);
  };
}
