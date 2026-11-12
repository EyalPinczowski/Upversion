import { runSyncDue, type CronEnv } from './sync-due';

/** The parts of the Workers runtime types this file uses (no extra type package needed). */
interface ScheduledController {
  readonly cron: string;
  readonly scheduledTime: number;
}
interface ExecutionContext {
  waitUntil(promise: Promise<unknown>): void;
}

export default {
  /** Runs on the cron trigger in wrangler.jsonc (every 15 minutes, UTC). */
  async scheduled(_controller: ScheduledController, env: CronEnv, ctx: ExecutionContext) {
    ctx.waitUntil(runSyncDue(env));
  },
};
