import { useEffect } from "react";

import { TaskCenter } from "../../features/tasks/TaskCenter";
import { api } from "../../shared/api/client";
import { useApiResource } from "../../shared/api/useApiResource";
import { AsyncMessage } from "../../shared/ui/AsyncMessage";
import "./pages.css";

export function TasksPage() {
  const resource = useApiResource(
    () => Promise.all([api.jobs(), api.agentRuns(), api.changeSets()]),
    [],
  );
  useEffect(() => {
    const timer = window.setInterval(() => void resource.reload(), 5000);
    return () => window.clearInterval(timer);
  }, [resource.reload]);
  if (resource.loading) return <AsyncMessage kind="loading">正在读取任务…</AsyncMessage>;
  if (resource.error) return <AsyncMessage kind="error">{resource.error}</AsyncMessage>;
  if (!resource.data) return <AsyncMessage kind="empty">暂无任务记录</AsyncMessage>;
  const [jobs, runs, changeSets] = resource.data;
  return <section className="workspace-page"><div className="workspace-content"><header className="page-header compact-page-header"><div><span className="eyebrow">TASK CONTROL</span><h1>任务与审阅</h1><p>智能体建议、用户批准、领域执行和后台任务各有独立生命周期；任何建议都不会静默生效。</p></div></header><TaskCenter jobs={jobs} runs={runs} changeSets={changeSets.items} onChanged={resource.reload} /></div></section>;
}
