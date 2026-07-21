import { useEffect, useMemo, useRef, useState } from "react";
import { Link } from "react-router-dom";

import { ChangeSetReview } from "../changes/ChangeSetReview";
import { api } from "../../shared/api/client";
import type { AgentRun, ChangeSet, Job, JobEvent } from "../../shared/api/contracts";
import { useEventStream } from "../../shared/api/useEventStream";
import { formatDateTime } from "../../shared/lib/format";
import { Icon } from "../../shared/ui/Icon";
import "./tasks.css";

interface Props {
  jobs: Job[];
  runs: AgentRun[];
  changeSets: ChangeSet[];
  onChanged: () => Promise<unknown>;
}

export function TaskCenter({ jobs, runs, changeSets, onChanged }: Props) {
  const [kind, setKind] = useState<"changes" | "jobs" | "agents">("changes");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const selectedJob = jobs.find((item) => item.id === selectedId) ?? (kind === "jobs" ? jobs[0] : null);
  const sortedRuns = useMemo(
    () => [...runs].toSorted((a, b) => b.created_at.localeCompare(a.created_at)),
    [runs],
  );
  const selectedRun = sortedRuns.find((item) => item.id === selectedId) ?? (kind === "agents" ? sortedRuns[0] : null);
  const selectedChange = changeSets.find((item) => item.id === selectedId) ?? (kind === "changes" ? changeSets[0] : null);

  function choose(next: typeof kind) {
    setKind(next);
    setSelectedId(null);
  }

  return (
    <div className="task-center">
      <aside className="task-rail">
        <div className="task-kind-tabs">
          <button className={kind === "changes" ? "active" : ""} type="button" onClick={() => choose("changes")}>待审阅 <span>{changeSets.filter((item) => item.status === "submitted").length}</span></button>
          <button className={kind === "agents" ? "active" : ""} type="button" onClick={() => choose("agents")}>智能体 <span>{runs.length}</span></button>
          <button className={kind === "jobs" ? "active" : ""} type="button" onClick={() => choose("jobs")}>后台任务 <span>{jobs.length}</span></button>
        </div>
        <div className="task-list">
          {kind === "changes" ? changeSets.map((changeSet) => (
            <button className={changeSet.id === selectedChange?.id ? "active" : ""} key={changeSet.id} type="button" onClick={() => setSelectedId(changeSet.id)}>
              <span className={`task-dot task-dot--${changeSet.status}`} />
              <span><strong>{changeSet.summary}</strong><small>{changeSet.kind} · {formatDateTime(changeSet.created_at)}</small></span>
            </button>
          )) : kind === "agents" ? sortedRuns.map((run) => (
            <button className={run.id === selectedRun?.id ? "active" : ""} key={run.id} type="button" onClick={() => setSelectedId(run.id)}>
              <span className={`task-dot task-dot--${run.status}`} />
              <span><strong>{run.goal}</strong><small>{run.task_kind} · {formatDateTime(run.created_at)}</small></span>
            </button>
          )) : jobs.map((job) => (
            <button className={job.id === selectedJob?.id ? "active" : ""} key={job.id} type="button" onClick={() => setSelectedId(job.id)}>
              <span className={`task-dot task-dot--${job.status}`} />
              <span><strong>{job.kind}</strong><small>{job.status} · {formatDateTime(job.created_at)}</small></span>
            </button>
          ))}
        </div>
      </aside>
      <section className="task-detail">
        {kind === "changes" ? (
          selectedChange ? <ChangeSetReview changeSet={selectedChange} onChanged={onChanged} /> : <TaskEmpty kind="待审阅变更" />
        ) : kind === "agents" ? (
          selectedRun ? <AgentSummary run={selectedRun} onChanged={onChanged} /> : <TaskEmpty kind="智能体运行" />
        ) : selectedJob ? (
          <JobDetail job={selectedJob} onChanged={onChanged} />
        ) : <TaskEmpty kind="后台任务" />}
      </section>
    </div>
  );
}

function AgentSummary({ run, onChanged }: { run: AgentRun; onChanged: Props["onChanged"] }) {
  const active = ["created", "starting", "running", "waiting_approval", "cancellation_requested"].includes(run.status);
  return <div className="task-summary"><span className="eyebrow">AGENT RUN</span><h2>{run.goal}</h2><p>每个运行拥有独立上下文和事件记录，不与其他任务共享会话状态。</p><dl><dt>状态</dt><dd>{run.status}</dd><dt>运行时</dt><dd>{run.runtime}{run.runtime_version ? ` ${run.runtime_version}` : ""}</dd><dt>模型</dt><dd>{run.model || "默认"}</dd><dt>推理强度</dt><dd>{run.reasoning_effort || "默认"}</dd><dt>开始</dt><dd>{run.started_at ? formatDateTime(run.started_at) : "尚未开始"}</dd></dl><div className="task-actions"><Link className="primary-button" to={`/agent-runs/${run.id}`}><Icon name="activity" size={15} />打开事件时间线</Link>{active ? <button className="danger-button" type="button" onClick={() => void api.interruptAgentRun(run.id).then(onChanged)}><Icon name="close" size={15} />中断</button> : run.status === "failed" || run.status === "canceled" ? <button className="toolbar-button" type="button" onClick={() => void api.resumeAgentRun(run.id).then(onChanged)}><Icon name="refresh" size={15} />恢复</button> : null}</div></div>;
}

function JobDetail({ job, onChanged }: { job: Job; onChanged: Props["onChanged"] }) {
  const { events, state } = useEventStream<JobEvent>(api.jobEventsUrl(job.id));
  const refreshedEvent = useRef(0);
  useEffect(() => {
    const terminal = events.findLast((event) => ["job.succeeded", "job.failed", "job.canceled"].includes(event.event_type));
    if (!terminal || terminal.id <= refreshedEvent.current) return;
    refreshedEvent.current = terminal.id;
    void onChanged();
  }, [events, onChanged]);
  const active = ["queued", "running", "cancellation_requested"].includes(job.status);
  return <div className="task-summary"><div className="task-detail-heading"><div><span className="eyebrow">BACKGROUND JOB</span><h2>{job.kind}</h2></div><span className={`run-status run-status--${job.status}`}><i />{job.status}</span></div><dl><dt>对象</dt><dd>{job.subject_type && job.subject_id ? `${job.subject_type}:${job.subject_id}` : "工作区"}</dd><dt>尝试上限</dt><dd>{job.max_attempts}</dd><dt>事件连接</dt><dd>{state}</dd><dt>错误</dt><dd>{job.error_message || "—"}</dd></dl><div className="job-event-list">{events.map((event) => <article key={event.id}><span>{event.event_type}</span><time>{formatDateTime(event.created_at)}</time><p>{String(event.payload.message ?? event.payload.summary ?? "")}</p></article>)}{!events.length ? <p className="muted">等待任务事件…</p> : null}</div>{job.status === "failed" || job.status === "canceled" ? <p className="job-retry-guidance">这条执行记录不会被直接恢复。请回到对应的文献、附件、工具或集成入口，修正输入后重新发起。</p> : null}<div className="task-actions">{active ? <button className="danger-button" type="button" onClick={() => void api.cancelJob(job.id).then(onChanged)}><Icon name="close" size={15} />取消任务</button> : null}</div></div>;
}

function TaskEmpty({ kind }: { kind: string }) {
  return <div className="task-empty"><Icon name="activity" size={26} /><h2>暂无{kind}</h2><p>新的执行记录会保存在这里。</p></div>;
}
