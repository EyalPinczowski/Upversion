import { runSyncDue, type CronEnv } from './sync-due';

/** The part of the Workers runtime types this file uses (no extra type package needed). */
interface ScheduledController {
  readonly cron: string;
  readonly scheduledTime: number;
}

export default {
  /**
   * Runs on the cron trigger in wrangler.jsonc (every 15 minutes, UTC). The run is awaited, so a
   * failed run rejects and shows as a failed cron event. Logs carry the status and counts only.
   */
  async scheduled(_controller: ScheduledController, env: CronEnv) {
    await runSyncDue(env);
  },
};
