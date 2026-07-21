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
  initialSelectedId?: string | null;
  onSelected?: (id: string | null) => void;
}

export function TaskCenter({ jobs, runs, changeSets, onChanged, initialSelectedId = null, onSelected }: Props) {
  const [kind, setKind] = useState<"changes" | "jobs" | "agents">("changes");
  const [selectedId, setSelectedId] = useState<string | null>(initialSelectedId);
  const selectedJob = jobs.find((item) => item.id === selectedId) ?? (kind === "jobs" ? jobs[0] : null);
  const sortedRuns = useMemo(
    () => [...runs].toSorted((a, b) => b.created_at.localeCompare(a.created_at)),
    [runs],
  );
  const selectedRun = sortedRuns.find((item) => item.id === selectedId) ?? (kind === "agents" ? sortedRuns[0] : null);
  const selectedChange = changeSets.find((item) => item.id === selectedId) ?? (kind === "changes" ? changeSets[0] : null);

  useEffect(() => {
    if (!initialSelectedId) return;
    setSelectedId(initialSelectedId);
    if (jobs.some((job) => job.id === initialSelectedId)) setKind("jobs");
    else if (runs.some((run) => run.id === initialSelectedId)) setKind("agents");
    else if (changeSets.some((changeSet) => changeSet.id === initialSelectedId)) setKind("changes");
  }, [changeSets, initialSelectedId, jobs, runs]);

  function select(id: string) {
    setSelectedId(id);
    onSelected?.(id);
  }

  function choose(next: typeof kind) {
    setKind(next);
    setSelectedId(null);
    onSelected?.(null);
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
            <button className={changeSet.id === selectedChange?.id ? "active" : ""} key={changeSet.id} type="button" onClick={() => select(changeSet.id)}>
              <span className={`task-dot task-dot--${changeSet.status}`} />
              <span><strong>{changeSet.summary}</strong><small>{changeSet.kind} · {formatDateTime(changeSet.created_at)}</small></span>
            </button>
          )) : kind === "agents" ? sortedRuns.map((run) => (
            <button className={run.id === selectedRun?.id ? "active" : ""} key={run.id} type="button" onClick={() => select(run.id)}>
              <span className={`task-dot task-dot--${run.status}`} />
              <span><strong>{run.goal}</strong><small>{run.task_kind} · {formatDateTime(run.created_at)}</small></span>
            </button>
          )) : jobs.map((job) => (
            <button className={job.id === selectedJob?.id ? "active" : ""} key={job.id} type="button" onClick={() => select(job.id)}>
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
  const products = eventProducts(events.findLast((event) => event.event_type === "job.succeeded"));
  const failure = taskFailureGuidance(
    job,
    events.findLast((event) => event.event_type === "job.failed"),
  );
  return <div className="task-summary"><div className="task-detail-heading"><div><span className="eyebrow">BACKGROUND JOB</span><h2>{jobKindLabel(job.kind)}</h2><small className="task-kind-code">{job.kind}</small></div><span className={`run-status run-status--${job.status}`}><i />{job.status}</span></div><dl><dt>输入对象</dt><dd>{job.subject_type && job.subject_id ? `${job.subject_type}:${job.subject_id}` : "工作区"}</dd><dt>尝试上限</dt><dd>{job.max_attempts}</dd><dt>事件连接</dt><dd>{streamStateLabel(state)}</dd><dt>错误类别</dt><dd>{failure?.categoryLabel ?? "—"}</dd><dt>可重新发起</dt><dd>{failure ? failure.retryable ? "是" : "需先修正配置或输入" : "—"}</dd><dt>错误原因</dt><dd>{job.error_message || "—"}</dd></dl><div className="job-event-list">{events.map((event) => <article key={event.id}><span>{eventTypeLabel(event.event_type)}</span><time>{formatDateTime(event.created_at)}</time><p>{String(event.payload.message ?? event.payload.summary ?? "")}</p></article>)}{!events.length ? <p className="muted">等待任务事件；连接中断时会自动续接。</p> : null}</div>{products.length ? <div className="job-products"><strong>任务结果</strong>{products.map((product) => product.href.startsWith("/api/") ? <a href={product.href} key={`${product.type}-${product.id}`} target="_blank" rel="noreferrer"><Icon name="external-link" size={14} />{productLabel(product)}</a> : <Link to={product.href} key={`${product.type}-${product.id}`}><Icon name="external-link" size={14} />{productLabel(product)}</Link>)}</div> : null}{failure ? <div className="job-retry-guidance"><strong>{failure.title}</strong><p>{failure.message}</p><div>{failure.href ? <Link className="toolbar-button" to={failure.href}><Icon name="refresh" size={14} />{failure.actionLabel}</Link> : <button className="toolbar-button" type="button" onClick={() => window.history.back()}><Icon name="arrow-left" size={14} />{failure.actionLabel}</button>}<Link to={`/tasks?job=${job.id}`}>保留此执行记录</Link></div></div> : null}<div className="task-actions">{active ? <button className="danger-button" type="button" onClick={() => void api.cancelJob(job.id).then(onChanged)}><Icon name="close" size={15} />取消任务</button> : null}</div></div>;
}

interface FailureGuidance {
  categoryLabel: string;
  retryable: boolean;
  title: string;
  message: string;
  actionLabel: string;
  href: string | null;
}

export function taskFailureGuidance(job: Job, event?: JobEvent): FailureGuidance | null {
  if (job.status !== "failed" && job.status !== "canceled") return null;
  if (job.status === "canceled") return {
    categoryLabel: "用户取消",
    retryable: true,
    title: "任务已安全取消",
    message: "未到提交点的输出不会登记；需要时可回到原入口重新发起。",
    actionLabel: "返回原入口",
    href: null,
  };
  const code = String(event?.payload.code ?? job.error_code ?? "unknown");
  const retryable = event?.payload.retryable === true;
  const categoryLabel = failureCategory(code);
  const settingsTask = job.kind.startsWith("tool.") || job.kind.startsWith("snapshot.");
  const integrationTask = job.kind.includes("zotero");
  return {
    categoryLabel,
    retryable,
    title: retryable ? "自动重试已用尽，可以重新发起" : "需要先修正输入或运行环境",
    message: retryable
      ? "原执行记录和失败阶段会保留。检查网络或临时服务状态后，从原入口创建一个新任务。"
      : "原执行记录不会被覆盖。按错误原因修正设置、凭据、工具或源文件后再创建任务。",
    actionLabel: settingsTask ? "打开系统设置" : integrationTask ? "打开集成设置" : "返回原入口",
    href: settingsTask ? "/settings" : integrationTask ? "/integrations" : null,
  };
}

function failureCategory(code: string) {
  if (/download|dns|provider|network|timeout|workspace_busy/.test(code)) return "网络或临时服务";
  if (/tool|installer|installation|credential|unsupported_platform/.test(code)) return "工具或运行配置";
  if (/stale|conflict|subject_mismatch|hash/.test(code)) return "对象版本冲突";
  if (/unsafe|invalid|missing|empty|too_large/.test(code)) return "输入校验";
  if (/worker|process|snapshot/.test(code)) return "后台执行";
  return "任务执行";
}

function jobKindLabel(kind: string) {
  return ({
    "attachment.download": "获取文献资源",
    "attachment.compile": "编译 TeX 源码",
    "attachment.translate": "生成翻译 PDF",
    "document.extract": "提取论文结构",
    "document.translate": "整篇语义翻译",
    "tool.install.pdf2zh": "安装 PDF 工具",
    "tool.install.tex": "安装 TeX 工具",
    "tool.verify.pdf2zh": "验证 PDF 工具",
    "tool.verify.tex": "验证 TeX 工具",
    "snapshot.create": "创建工作区快照",
    "snapshot.restore": "恢复工作区快照",
    "agent.run": "智能体领域任务",
  } as Record<string, string>)[kind] ?? kind;
}

function streamStateLabel(state: string) {
  return ({ idle: "未连接", connecting: "正在连接或重连", open: "实时连接", closed: "事件已结束", error: "暂时断开" } as Record<string, string>)[state] ?? state;
}

function eventTypeLabel(type: string) {
  return ({
    "job.queued": "已进入队列",
    "job.started": "开始执行",
    "job.retry_scheduled": "等待自动重试",
    "job.succeeded": "执行成功",
    "job.failed": "执行失败",
    "job.canceled": "已取消",
    "job.recovered": "重启后恢复",
  } as Record<string, string>)[type] ?? type;
}

interface EventProduct { type: string; id: string; role: string; href: string }

function eventProducts(event: JobEvent | undefined): EventProduct[] {
  const products = event?.payload.products;
  if (!Array.isArray(products)) return [];
  const result: EventProduct[] = [];
  for (const item of products) {
    if (typeof item !== "object" || item === null || Array.isArray(item)) continue;
    const type = item.type;
    const id = item.id;
    const role = item.role;
    const href = item.href;
    if (
      typeof type === "string" && typeof id === "string"
      && typeof role === "string" && typeof href === "string"
      && href.startsWith("/") && !href.startsWith("//")
    ) result.push({ type, id, role, href });
  }
  return result;
}

function productLabel(product: EventProduct) {
  if (product.type === "attachment") return product.role === "bilingual" ? "打开双语 PDF" : product.role === "translated" ? "打开译文 PDF" : "打开输出附件";
  return "查看结构化文档结果";
}

function TaskEmpty({ kind }: { kind: string }) {
  return <div className="task-empty"><Icon name="activity" size={26} /><h2>暂无{kind}</h2><p>新的执行记录会保存在这里。</p></div>;
}
