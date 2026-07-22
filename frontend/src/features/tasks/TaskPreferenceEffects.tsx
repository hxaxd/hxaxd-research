import { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";

import { api } from "../../shared/api/client";
import type { Job } from "../../shared/api/contracts";
import { Icon } from "../../shared/ui/Icon";
import { taskEffects } from "./taskEffects";
import "./task-effects.css";

interface Toast {
  jobId: string;
  title: string;
  message: string;
}

export function TaskPreferenceEffects() {
  const navigate = useNavigate();
  const previous = useRef<Map<string, Job["status"]> | null>(null);
  const [toast, setToast] = useState<Toast | null>(null);

  useEffect(() => {
    let stopped = false;
    let running = false;
    async function poll() {
      if (running || stopped) return;
      running = true;
      try {
        const [jobs, preferences] = await Promise.all([
          api.jobs(),
          api.userPreferences(),
        ]);
        if (stopped) return;
        if (previous.current) {
          const effects = taskEffects(previous.current, jobs, preferences.tasks);
          for (const effect of effects) {
            const title = effect.outcome === "succeeded" ? "任务已完成" : "任务执行失败";
            const jobLabel = taskEffectLabel(effect.job.kind);
            const message = effect.outcome === "succeeded"
              ? `${jobLabel}已产生可查看的结果。`
              : `${jobLabel}：${effect.job.error_message || "请打开任务中心查看原因。"}`;
            if (effect.notify) {
              showSystemNotification(title, message, effect.job.id);
              setToast({ jobId: effect.job.id, title, message });
            }
            if (effect.autoOpen) navigate(`/tasks?job=${effect.job.id}`);
          }
        }
        previous.current = new Map(jobs.map((job) => [job.id, job.status]));
      } catch {
        // Connection state is already surfaced globally; polling resumes next cycle.
      } finally {
        running = false;
      }
    }
    void poll();
    const timer = window.setInterval(() => void poll(), 4_000);
    return () => {
      stopped = true;
      window.clearInterval(timer);
    };
  }, [navigate]);

  useEffect(() => {
    if (!toast) return;
    const timer = window.setTimeout(() => setToast(null), 7_000);
    return () => window.clearTimeout(timer);
  }, [toast]);

  return toast ? <button className="task-effect-toast" type="button" onClick={() => { navigate(`/tasks?job=${toast.jobId}`); setToast(null); }}>
    <Icon name="activity" size={18} /><span><strong>{toast.title}</strong><small>{toast.message}</small></span><Icon name="chevron-right" size={16} />
  </button> : null;
}

function taskEffectLabel(kind: string) {
  return ({
    "attachment.download": "文献资源获取",
    "attachment.compile": "TeX 编译",
    "document.extract": "论文结构识别",
    "document.translate": "整篇语义翻译",
    "snapshot.create": "工作区快照创建",
    "snapshot.restore": "工作区快照恢复",
    "tool.install.pdf2zh": "论文结构工具安装",
    "tool.install.tex": "TeX 工具安装",
  } as Record<string, string>)[kind] ?? "后台任务";
}

function showSystemNotification(title: string, body: string, jobId: string) {
  if (!("Notification" in window) || Notification.permission !== "granted") return;
  const notification = new Notification(title, {
    body,
    tag: `workspace-job-${jobId}`,
    icon: "/research-icon.svg",
  });
  notification.onclick = () => {
    window.focus();
    window.location.assign(`/tasks?job=${jobId}`);
  };
}
