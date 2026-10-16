import { runReconciliation } from '../services/reconciliation_service';
import { explainPreviousDayRiskFlags } from '../services/risk_explanation_service';

export interface SchedulerLogger {
  info(fields: unknown, message: string): void;
  error(error: unknown, message: string): void;
}

const RUN_HOUR_UTC = 2;

function millisecondsUntilNextRun(now: Date): number {
  const next = new Date(now);
  next.setUTCHours(RUN_HOUR_UTC, 0, 0, 0);
  if (next <= now) next.setUTCDate(next.getUTCDate() + 1);
  return next.getTime() - now.getTime();
}

export function startReconciliationScheduler(logger: SchedulerLogger): () => void {
  let timer: NodeJS.Timeout;
  let stopped = false;
  const schedule = (): void => {
    if (stopped) return;
    timer = setTimeout(async () => {
      try {
        const result = await runReconciliation();
        logger.info({ result }, 'scheduled reconciliation finished');
        if (result.status === 'completed') {
          const explained = await explainPreviousDayRiskFlags();
          logger.info({ explained }, 'risk flags explained');
        }
      } catch (error) {
        logger.error(error, 'scheduled reconciliation failed');
      }
      schedule();
    }, millisecondsUntilNextRun(new Date()));
  };
  schedule();
  return () => {
    stopped = true;
    clearTimeout(timer);
  };
}
