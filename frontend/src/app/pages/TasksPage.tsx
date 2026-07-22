import { useEffect } from "react";
import { useSearchParams } from "react-router-dom";

import { TaskCenter } from "../../features/tasks/TaskCenter";
import { api } from "../../shared/api/client";
import { useApiResource } from "../../shared/api/useApiResource";
import { AsyncMessage } from "../../shared/ui/AsyncMessage";
import "./pages.css";

export function TasksPage() {
  const [searchParams, setSearchParams] = useSearchParams();
  const resource = useApiResource(
    () => Promise.all([api.jobs(), api.agentRuns(), api.changeSets()]),
    [],
  );
  useEffect(() => {
    const timer = window.setInterval(() => void resource.reload(), 5000);
    return () => window.clearInterval(timer);
  }, [resource.reload]);
  if (resource.loading) return <AsyncMessage kind="loading">正在读取任务…</AsyncMessage>;
  if (resource.error) return <AsyncMessage kind="error" onRetry={() => void resource.retry()}>{resource.error}</AsyncMessage>;
  if (!resource.data) return <AsyncMessage kind="empty">暂无任务记录</AsyncMessage>;
  const [jobs, runs, changeSets] = resource.data;
  const visibleJobs = jobs.filter((job) => job.kind !== "agent.run");
  return <section className="tasks-page workspace-page"><div className="workspace-content"><header className="page-header compact-page-header"><div><span className="eyebrow">任务与决策</span><h1>继续运行，审阅结果</h1><p>这里集中处理需要你决定的建议、智能体结果和后台执行；失败记录可以直接恢复。</p></div></header><TaskCenter jobs={visibleJobs} runs={runs} changeSets={changeSets.items} initialSelectedId={searchParams.get("job")} onChanged={resource.reload} onSelected={(id) => setSearchParams(id ? { job: id } : {}, { replace: true })} /></div></section>;
}
