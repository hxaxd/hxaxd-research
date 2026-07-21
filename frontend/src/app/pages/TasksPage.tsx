import { useEffect } from "react";

import { TaskCenter } from "../../features/tasks/TaskCenter";
import { api } from "../../shared/api/client";
import { useApiResource } from "../../shared/api/useApiResource";
import { AsyncMessage } from "../../shared/ui/AsyncMessage";
import "./pages.css";

export function TasksPage() {
  const resource = useApiResource(() => Promise.all([api.jobs(), api.agentRuns()]), []);
  useEffect(() => {
    const timer = window.setInterval(() => void resource.reload(), 5000);
    return () => window.clearInterval(timer);
  }, [resource.reload]);
  if (resource.loading) return <AsyncMessage kind="loading">正在读取任务…</AsyncMessage>;
  if (resource.error) return <AsyncMessage kind="error">{resource.error}</AsyncMessage>;
  const [jobs, runs] = resource.data ?? [[], []];
  return <section className="workspace-page"><div className="workspace-content"><header className="page-header compact-page-header"><div><span className="eyebrow">TASK CONTROL</span><h1>任务中心</h1><p>这里保留独立生命周期与事件记录；失败的后台任务需从对应领域入口修正输入后重新发起。</p></div></header><TaskCenter jobs={jobs} runs={runs} onChanged={resource.reload} /></div></section>;
}
