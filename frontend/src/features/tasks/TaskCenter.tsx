import { useEffect, useMemo, useRef, useState } from "react";
import { Link } from "react-router-dom";

import { agentRuntimeLabel } from "../agents/AgentRuntimePicker";
import { ChangeSetReview } from "../changes/ChangeSetReview";
import { api } from "../../shared/api/client";
import type {
  AgentRun,
  ChangeSet,
  Job,
  JobEvent,
} from "../../shared/api/contracts";
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

type TaskKind = "changes" | "jobs" | "agents";

export function defaultTaskKind(
  jobs: Job[],
  runs: AgentRun[],
  changeSets: ChangeSet[],
): TaskKind {
  if (changeSets.some((item) => item.status === "submitted")) return "changes";
  if (
    runs.some((run) =>
      ["created", "starting", "running", "waiting_approval"].includes(
        run.status,
      ),
    )
  )
    return "agents";
  if (
    jobs.some((job) =>
      ["queued", "running", "cancellation_requested"].includes(job.status),
    )
  )
    return "jobs";
  if (jobs.some((job) => ["failed", "canceled"].includes(job.status)))
    return "jobs";
  if (runs.some((run) => ["failed", "canceled"].includes(run.status)))
    return "agents";
  if (runs.length) return "agents";
  if (jobs.length) return "jobs";
  return "changes";
}

export function TaskCenter({
  jobs,
  runs,
  changeSets,
  onChanged,
  initialSelectedId = null,
  onSelected,
}: Props) {
  const visibleJobs = useMemo(
    () => jobs.filter((job) => job.kind !== "agent.run"),
    [jobs],
  );
  const [kind, setKind] = useState<TaskKind>(() =>
    defaultTaskKind(visibleJobs, runs, changeSets),
  );
  const [selectedId, setSelectedId] = useState<string | null>(
    initialSelectedId,
  );
  const sortedJobs = useMemo(
    () =>
      [...visibleJobs].toSorted((a, b) =>
        b.created_at.localeCompare(a.created_at),
      ),
    [visibleJobs],
  );
  const sortedChanges = useMemo(
    () =>
      [...changeSets].toSorted((a, b) => {
        const priority =
          Number(b.status === "submitted") - Number(a.status === "submitted");
        return priority || b.created_at.localeCompare(a.created_at);
      }),
    [changeSets],
  );
  const selectedJob =
    sortedJobs.find((item) => item.id === selectedId) ??
    (kind === "jobs" ? sortedJobs[0] : null);
  const sortedRuns = useMemo(
    () =>
      [...runs].toSorted((a, b) => b.created_at.localeCompare(a.created_at)),
    [runs],
  );
  const selectedRun =
    sortedRuns.find((item) => item.id === selectedId) ??
    (kind === "agents" ? sortedRuns[0] : null);
  const selectedChange =
    sortedChanges.find((item) => item.id === selectedId) ??
    (kind === "changes" ? sortedChanges[0] : null);

  useEffect(() => {
    if (!initialSelectedId) return;
    setSelectedId(initialSelectedId);
    if (visibleJobs.some((job) => job.id === initialSelectedId))
      setKind("jobs");
    else if (runs.some((run) => run.id === initialSelectedId))
      setKind("agents");
    else if (changeSets.some((changeSet) => changeSet.id === initialSelectedId))
      setKind("changes");
  }, [changeSets, initialSelectedId, runs, visibleJobs]);

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
          <button
            className={kind === "changes" ? "active" : ""}
            type="button"
            onClick={() => choose("changes")}
          >
            待审阅{" "}
            <span>
              {changeSets.filter((item) => item.status === "submitted").length}
            </span>
          </button>
          <button
            className={kind === "agents" ? "active" : ""}
            type="button"
            onClick={() => choose("agents")}
          >
            智能体 <span>{runs.length}</span>
          </button>
          <button
            className={kind === "jobs" ? "active" : ""}
            type="button"
            onClick={() => choose("jobs")}
          >
            后台任务 <span>{visibleJobs.length}</span>
          </button>
        </div>
        <div className="task-list">
          {kind === "changes"
            ? sortedChanges.map((changeSet) => (
                <button
                  className={
                    changeSet.id === selectedChange?.id ? "active" : ""
                  }
                  key={changeSet.id}
                  type="button"
                  onClick={() => select(changeSet.id)}
                >
                  <span className={`task-dot task-dot--${changeSet.status}`} />
                  <span>
                    <strong>{changeSet.summary}</strong>
                    <small>
                      {changeKindLabel(changeSet.kind)} ·{" "}
                      {formatDateTime(changeSet.created_at)}
                    </small>
                  </span>
                </button>
              ))
            : kind === "agents"
              ? sortedRuns.map((run) => (
                  <button
                    className={run.id === selectedRun?.id ? "active" : ""}
                    key={run.id}
                    type="button"
                    onClick={() => select(run.id)}
                  >
                    <span className={`task-dot task-dot--${run.status}`} />
                    <span>
                      <strong>{run.goal}</strong>
                      <small>
                        {agentRuntimeLabel(run.runtime)} · {agentTaskLabel(run.task_kind)} ·{" "}
                        {formatDateTime(run.created_at)}
                      </small>
                    </span>
                  </button>
                ))
              : sortedJobs.map((job) => (
                  <button
                    className={job.id === selectedJob?.id ? "active" : ""}
                    key={job.id}
                    type="button"
                    onClick={() => select(job.id)}
                  >
                    <span className={`task-dot task-dot--${job.status}`} />
                    <span>
                      <strong>{jobKindLabel(job.kind)}</strong>
                      <small>
                        {jobStatusLabel(job.status)} ·{" "}
                        {formatDateTime(job.created_at)}
                      </small>
                    </span>
                  </button>
                ))}
        </div>
      </aside>
      <section className="task-detail">
        {kind === "changes" ? (
          selectedChange ? (
            <ChangeSetReview changeSet={selectedChange} onChanged={onChanged} />
          ) : (
            <TaskEmpty kind="待审阅变更" />
          )
        ) : kind === "agents" ? (
          selectedRun ? (
            <AgentSummary run={selectedRun} onChanged={onChanged} />
          ) : (
            <TaskEmpty kind="智能体运行" />
          )
        ) : selectedJob ? (
          <JobDetail job={selectedJob} onChanged={onChanged} />
        ) : (
          <TaskEmpty kind="后台任务" />
        )}
      </section>
    </div>
  );
}

function AgentSummary({
  run,
  onChanged,
}: {
  run: AgentRun;
  onChanged: Props["onChanged"];
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const active = [
    "created",
    "starting",
    "running",
    "waiting_approval",
    "cancellation_requested",
  ].includes(run.status);
  async function act(action: "interrupt" | "resume") {
    setBusy(true);
    setError(null);
    try {
      await (action === "interrupt"
        ? api.interruptAgentRun(run.id)
        : api.resumeAgentRun(run.id));
      await onChanged();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "无法更新智能体运行");
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="task-summary">
      <div className="task-detail-heading">
        <div>
          <span className="eyebrow">智能体任务</span>
          <h2>{run.goal}</h2>
        </div>
        <span className={`run-status run-status--${run.status}`}>
          <i />
          {agentStatusLabel(run.status)}
        </span>
      </div>
      <div className="task-runtime-summary">
        <span><Icon name="terminal" size={14} />{agentRuntimeLabel(run.runtime)}</span>
        <span>{run.model || "跟随运行环境"}</span>
      </div>
      {run.final_message ? (
        <section className="task-result-card">
          <strong>运行结果</strong>
          <p>{run.final_message}</p>
        </section>
      ) : null}
      {run.error_message ? (
        <p className="task-action-error">{run.error_message}</p>
      ) : null}
      <p>上下文、工具权限与结果都绑定在这次独立运行中。</p>
      <details className="task-diagnostics">
        <summary>运行诊断</summary>
        <dl>
          <dt>任务类型</dt>
          <dd>{run.task_kind}</dd>
          <dt>运行环境</dt>
          <dd>
            {agentRuntimeLabel(run.runtime)}
            {run.runtime_version ? ` ${run.runtime_version}` : ""}
          </dd>
          <dt>模型</dt>
          <dd>{run.model || "跟随运行环境"}</dd>
          <dt>推理强度</dt>
          <dd>{run.reasoning_effort || "默认"}</dd>
          <dt>开始</dt>
          <dd>
            {run.started_at ? formatDateTime(run.started_at) : "尚未开始"}
          </dd>
        </dl>
      </details>
      {error ? (
        <p className="task-action-error" role="alert">
          {error}
        </p>
      ) : null}
      <div className="task-actions">
        <Link className="primary-button" to={`/agent-runs/${run.id}`}>
          <Icon name="activity" size={15} />
          查看过程与结果
        </Link>
        {active ? (
          <button
            className="danger-button"
            disabled={busy}
            type="button"
            onClick={() => void act("interrupt")}
          >
            <Icon name="close" size={15} />
            {busy ? "处理中…" : "中断"}
          </button>
        ) : run.status === "failed" || run.status === "canceled" ? (
          <button
            className="toolbar-button"
            disabled={busy}
            type="button"
            onClick={() => void act("resume")}
          >
            <Icon name="refresh" size={15} />
            {busy ? "恢复中…" : "恢复运行"}
          </button>
        ) : null}
      </div>
    </div>
  );
}

function JobDetail({
  job,
  onChanged,
}: {
  job: Job;
  onChanged: Props["onChanged"];
}) {
  const [busy, setBusy] = useState<"cancel" | "resume" | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const { events, state } = useEventStream<JobEvent>(api.jobEventsUrl(job.id));
  const refreshedEvent = useRef(0);
  useEffect(() => {
    const terminal = events.findLast((event) =>
      ["job.succeeded", "job.failed", "job.canceled"].includes(
        event.event_type,
      ),
    );
    if (!terminal || terminal.id <= refreshedEvent.current) return;
    refreshedEvent.current = terminal.id;
    void onChanged();
  }, [events, onChanged]);
  const active = ["queued", "running", "cancellation_requested"].includes(
    job.status,
  );
  const products = jobProducts(job, events);
  const resultRows = jobResultRows(job.result);
  const failure = taskFailureGuidance(
    job,
    events.findLast((event) => event.event_type === "job.failed"),
  );
  async function act(action: "cancel" | "resume") {
    setBusy(action);
    setActionError(null);
    try {
      await (action === "cancel"
        ? api.cancelJob(job.id)
        : api.resumeJob(job.id));
      await onChanged();
    } catch (reason) {
      setActionError(reason instanceof Error ? reason.message : "无法更新任务");
    } finally {
      setBusy(null);
    }
  }
  const visibleEvents = events
    .filter(
      (event) =>
        !event.event_type.endsWith(".stdout") &&
        !event.event_type.endsWith(".stderr"),
    )
    .slice(-30);
  return (
    <div className="task-summary">
      <div className="task-detail-heading">
        <div>
          <span className="eyebrow">后台任务</span>
          <h2>{jobKindLabel(job.kind)}</h2>
        </div>
        <span className={`run-status run-status--${job.status}`}>
          <i />
          {jobStatusLabel(job.status)}
        </span>
      </div>
      {job.status === "succeeded" ? (
        <section className="task-result-card">
          <strong>任务结果</strong>
          {resultRows.length ? (
            <dl>
              {resultRows.map((row) => (
                <span key={row.label}>
                  <dt>{row.label}</dt>
                  <dd>{row.value}</dd>
                </span>
              ))}
            </dl>
          ) : (
            <p>任务已成功完成，结果已登记到工作区。</p>
          )}
          {products.length ? (
            <div className="job-products">
              {products.map((product) =>
                product.href.startsWith("/api/") ? (
                  <a
                    href={product.href}
                    key={`${product.type}-${product.id}`}
                    target="_blank"
                    rel="noreferrer"
                  >
                    <Icon name="external-link" size={14} />
                    {productLabel(product)}
                  </a>
                ) : (
                  <Link to={product.href} key={`${product.type}-${product.id}`}>
                    <Icon name="external-link" size={14} />
                    {productLabel(product)}
                  </Link>
                ),
              )}
            </div>
          ) : null}
        </section>
      ) : null}
      <details className="task-diagnostics">
        <summary>执行诊断</summary>
        <dl>
          <dt>作用对象</dt>
          <dd>{jobSubjectLabel(job)}</dd>
          <dt>尝试上限</dt>
          <dd>{job.max_attempts}</dd>
          <dt>事件连接</dt>
          <dd>{streamStateLabel(state)}</dd>
          <dt>错误类别</dt>
          <dd>{failure?.categoryLabel ?? "—"}</dd>
          <dt>错误原因</dt>
          <dd>{job.error_message || "—"}</dd>
        </dl>
      </details>
      <details className="job-event-panel" open={active}>
        <summary>执行记录（{visibleEvents.length}）</summary>
        <div className="job-event-list">
          {visibleEvents.map((event) => (
            <article key={event.id}>
              <span>{eventTypeLabel(event.event_type)}</span>
              <time>{formatDateTime(event.created_at)}</time>
              {eventMessage(event) ? <p>{eventMessage(event)}</p> : null}
            </article>
          ))}
          {!visibleEvents.length ? (
            <p className="muted">
              等待任务事件；实时连接失败时，页面轮询仍会继续更新状态。
            </p>
          ) : null}
        </div>
      </details>
      {failure ? (
        <div className="job-retry-guidance">
          <span>{failure.categoryLabel}</span>
          <strong>{failure.title}</strong>
          <p>{failure.message}</p>
          <div>
            {failure.href ? (
              <Link className="toolbar-button" to={failure.href}>
                <Icon name="settings" size={14} />
                {failure.actionLabel}
              </Link>
            ) : null}
            <button
              className="toolbar-button"
              disabled={busy !== null}
              type="button"
              onClick={() => void act("resume")}
            >
              <Icon name="refresh" size={14} />
              {busy === "resume" ? "恢复中…" : "从失败点恢复"}
            </button>
          </div>
        </div>
      ) : null}
      {actionError ? (
        <p className="task-action-error" role="alert">
          {actionError}
        </p>
      ) : null}
      <div className="task-actions">
        {active ? (
          <button
            className="danger-button"
            disabled={busy !== null}
            type="button"
            onClick={() => void act("cancel")}
          >
            <Icon name="close" size={15} />
            {busy === "cancel" ? "正在取消…" : "取消任务"}
          </button>
        ) : null}
      </div>
    </div>
  );
}

interface FailureGuidance {
  categoryLabel: string;
  retryable: boolean;
  title: string;
  message: string;
  actionLabel: string;
  href: string | null;
}

export function taskFailureGuidance(
  job: Job,
  event?: JobEvent,
): FailureGuidance | null {
  if (job.status !== "failed" && job.status !== "canceled") return null;
  if (job.status === "canceled")
    return {
      categoryLabel: "用户取消",
      retryable: true,
      title: "任务已安全取消",
      message:
        "未到提交点的输出不会登记；可以从这条记录直接恢复，任务会重新进入队列。",
      actionLabel: "返回原入口",
      href: null,
    };
  const code = String(event?.payload.code ?? job.error_code ?? "unknown");
  const retryable = event?.payload.retryable === true;
  const categoryLabel = failureCategory(code);
  const settingsTask =
    job.kind.startsWith("tool.") || job.kind.startsWith("snapshot.");
  const integrationTask = job.kind.includes("zotero");
  return {
    categoryLabel,
    retryable,
    title: retryable
      ? "自动重试已用尽，可以恢复任务"
      : "需要先修正输入或运行环境",
    message: retryable
      ? "原执行记录和失败阶段会保留。检查网络或临时服务状态后，可直接从失败点恢复。"
      : "原执行记录不会被覆盖。按错误原因修正设置、凭据、工具或源文件后再恢复任务。",
    actionLabel: settingsTask
      ? "打开系统设置"
      : integrationTask
        ? "打开集成设置"
        : "返回原入口",
    href: settingsTask ? "/settings" : integrationTask ? "/integrations" : null,
  };
}

function failureCategory(code: string) {
  if (/download|dns|provider|network|timeout|workspace_busy/.test(code))
    return "网络或临时服务";
  if (/tool|installer|installation|credential|unsupported_platform/.test(code))
    return "工具或运行配置";
  if (/stale|conflict|subject_mismatch|hash/.test(code)) return "对象版本冲突";
  if (/unsafe|invalid|missing|empty|too_large/.test(code)) return "输入校验";
  if (/worker|process|snapshot/.test(code)) return "后台执行";
  return "任务执行";
}

function jobKindLabel(kind: string) {
  return (
    (
      {
        "attachment.download": "获取文献资源",
        "attachment.compile": "编译 TeX 源码",
        "document.extract": "提取论文结构",
        "document.translate": "整篇语义翻译",
        "tool.install.pdf2zh": "安装 PDF 工具",
        "tool.install.tex": "安装 TeX 工具",
        "tool.verify.pdf2zh": "验证 PDF 工具",
        "tool.verify.tex": "验证 TeX 工具",
        "snapshot.create": "创建工作区快照",
        "snapshot.restore": "恢复工作区快照",
        "agent.run": "智能体领域任务",
      } as Record<string, string>
    )[kind] ?? kind
  );
}

function changeKindLabel(kind: ChangeSet["kind"]) {
  return (
    {
      metadata_patch: "书目信息",
      resource_acquisition: "资源获取",
      project_insights: "项目阅读信息",
      zotero_conflict_resolution: "Zotero 冲突",
    } as const
  )[kind];
}

function agentTaskLabel(kind: string) {
  return (
    (
      {
        literature_search: "检索候选文献",
        metadata_enrichment: "补全文献元数据",
        resource_acquisition: "寻找文献资源",
        conflict_resolution: "分析 Zotero 冲突",
      } as Record<string, string>
    )[kind] ?? "智能体任务"
  );
}

function streamStateLabel(state: string) {
  return (
    (
      {
        idle: "未连接",
        connecting: "正在自动重连",
        open: "实时连接",
        closed: "事件已结束",
        error: "暂时断开，正在重试",
      } as Record<string, string>
    )[state] ?? state
  );
}

function eventTypeLabel(type: string) {
  return (
    (
      {
        "job.queued": "已进入队列",
        "job.started": "开始执行",
        "job.retry_scheduled": "等待自动重试",
        "job.succeeded": "执行成功",
        "job.failed": "执行失败",
        "job.canceled": "已取消",
        "job.recovered": "重启后恢复",
      } as Record<string, string>
    )[type] ?? type
  );
}

interface EventProduct {
  type: string;
  id: string;
  role: string;
  href: string;
}

function productsFromPayload(
  payload: Record<string, unknown> | null | undefined,
): EventProduct[] {
  const products = payload?.products;
  if (!Array.isArray(products)) return [];
  const result: EventProduct[] = [];
  for (const item of products) {
    if (typeof item !== "object" || item === null || Array.isArray(item))
      continue;
    const type = item.type;
    const id = item.id;
    const role = item.role;
    const href = item.href;
    if (
      typeof type === "string" &&
      typeof id === "string" &&
      typeof role === "string" &&
      typeof href === "string" &&
      href.startsWith("/") &&
      !href.startsWith("//")
    )
      result.push({ type, id, role, href });
  }
  return result;
}

function jobProducts(job: Job, events: JobEvent[]): EventProduct[] {
  const fromResult = productsFromPayload(job.result);
  const fallback = productsFromPayload(
    events.findLast((event) => event.event_type === "job.succeeded")?.payload,
  );
  const result = [...fromResult, ...fallback];
  const projectId = textValue(job.result?.project_id);
  const itemId = textValue(job.result?.item_id);
  const attachmentIds = job.result?.attachment_ids;
  if (projectId && itemId && Array.isArray(attachmentIds)) {
    for (const attachmentId of attachmentIds) {
      if (typeof attachmentId !== "string") continue;
      result.push({
        type: "attachment",
        id: attachmentId,
        role: "output",
        href: `/projects/${encodeURIComponent(projectId)}/items/${encodeURIComponent(itemId)}/read/${encodeURIComponent(attachmentId)}?panel=pdf`,
      });
    }
  }
  const downloadUrl = textValue(job.result?.download_url);
  const filename = textValue(job.result?.filename);
  if (downloadUrl?.startsWith("/api/") && filename) {
    result.push({
      type: "snapshot",
      id: filename,
      role: "download",
      href: downloadUrl,
    });
  }
  return result.filter(
    (product, index, all) =>
      all.findIndex(
        (candidate) =>
          candidate.href === product.href && candidate.id === product.id,
      ) === index,
  );
}

function jobResultRows(result: Job["result"]) {
  if (!result) return [];
  const fields: Array<[keyof typeof result, string]> = [
    ["filename", "快照文件"],
    ["file_count", "文件数"],
    ["attachments", "输出附件"],
    ["page_count", "页数"],
    ["block_count", "结构块"],
    ["translated_blocks", "已翻译段落"],
    ["target_language", "目标语言"],
    ["tool", "工具"],
    ["version", "版本"],
    ["ready", "可用状态"],
  ];
  return fields.flatMap(([key, label]) => {
    const value = result[key];
    if (!["string", "number", "boolean"].includes(typeof value)) return [];
    return [
      {
        label,
        value:
          typeof value === "boolean"
            ? value
              ? "可用"
              : "不可用"
            : String(value),
      },
    ];
  });
}

function eventMessage(event: JobEvent) {
  const value =
    event.payload.message ?? event.payload.summary ?? event.payload.stage;
  return typeof value === "string" ? value : null;
}

function jobSubjectLabel(job: Job) {
  if (!job.subject_type || !job.subject_id) return "整个工作区";
  const type =
    (
      {
        attachment: "附件",
        document: "结构化论文",
        item: "文献",
        workspace: "工作区",
      } as Record<string, string>
    )[job.subject_type] ?? "工作对象";
  return `${type} · ${job.subject_id}`;
}

function textValue(value: unknown) {
  return typeof value === "string" && value ? value : null;
}

function productLabel(product: EventProduct) {
  if (product.type === "snapshot") return "下载工作区快照";
  if (product.type === "attachment")
    return product.role === "bilingual"
      ? "打开双语 PDF"
      : product.role === "translated"
        ? "打开译文 PDF"
        : "打开输出附件";
  return "查看结构化文档结果";
}

function jobStatusLabel(status: Job["status"]) {
  return (
    {
      queued: "等待执行",
      running: "执行中",
      cancellation_requested: "正在取消",
      canceled: "已取消",
      succeeded: "已完成",
      failed: "失败",
    } as const
  )[status];
}

function agentStatusLabel(status: AgentRun["status"]) {
  return (
    {
      created: "已创建",
      starting: "正在启动",
      running: "运行中",
      waiting_approval: "等待批准",
      cancellation_requested: "正在取消",
      canceled: "已取消",
      completed: "已完成",
      failed: "失败",
    } as const
  )[status];
}

function TaskEmpty({ kind }: { kind: string }) {
  return (
    <div className="task-empty">
      <Icon name="activity" size={26} />
      <h2>暂无{kind}</h2>
      <p>新的执行记录会保存在这里。</p>
    </div>
  );
}
