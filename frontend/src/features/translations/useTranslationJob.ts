import { useEffect, useState } from "react";

import { api } from "../../shared/api/client";
import type { Job } from "../../shared/api/contracts";

export function useTranslationJob(onCompleted: () => Promise<void> | void) {
  const [job, setJob] = useState<Job | null>(null);
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function start(paperId: string) {
    setStarting(true);
    setError(null);
    try {
      setJob(await api.translate(paperId));
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "无法启动翻译");
    } finally {
      setStarting(false);
    }
  }

  useEffect(() => {
    if (!job || !["queued", "running"].includes(job.status)) return;
    let active = true;
    const timer = window.setTimeout(() => {
      void api
        .job(job.id)
        .then(async (nextJob) => {
          if (!active) return;
          setJob(nextJob);
          if (nextJob.status === "succeeded") await onCompleted();
        })
        .catch((reason: unknown) => {
          if (active) setError(reason instanceof Error ? reason.message : "无法读取翻译进度");
        });
    }, 1500);
    return () => {
      active = false;
      window.clearTimeout(timer);
    };
  }, [job, onCompleted]);

  return { job, starting, error, start };
}

