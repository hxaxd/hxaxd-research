import type { Job, TaskPreferences } from "../../shared/api/contracts";

export interface TaskEffect {
  job: Job;
  notify: boolean;
  autoOpen: boolean;
  outcome: "succeeded" | "failed";
}

export function taskEffects(
  previous: ReadonlyMap<string, Job["status"]>,
  current: Job[],
  preferences: TaskPreferences,
): TaskEffect[] {
  const effects: TaskEffect[] = [];
  for (const job of current) {
    const prior = previous.get(job.id);
    if (!prior || ["succeeded", "failed", "canceled"].includes(prior)) continue;
    if (job.status === "succeeded") {
      effects.push({
        job,
        outcome: "succeeded",
        notify: preferences.notify_on_success,
        autoOpen: preferences.auto_open_result,
      });
    }
    if (job.status === "failed") {
      effects.push({
        job,
        outcome: "failed",
        notify: preferences.notify_on_failure,
        autoOpen: false,
      });
    }
  }
  return effects;
}
