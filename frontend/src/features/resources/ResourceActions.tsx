import { useEffect, useRef, useState, type FormEvent } from "react";
import { Link, useParams } from "react-router-dom";

import { api } from "../../shared/api/client";
import type { Attachment, Job, JobEvent } from "../../shared/api/contracts";
import { useEventStream } from "../../shared/api/useEventStream";
import { Icon } from "../../shared/ui/Icon";
import "./resources.css";

interface Props {
  itemId: string;
  attachments: Attachment[];
  onAttachmentChanged: () => Promise<unknown>;
}

type AcquisitionType = "fulltext" | "source_archive";

interface TrackedJob {
  job: Job;
  label: string;
  outcome: "running" | "succeeded" | "failed" | "canceled";
}

export function ResourceActions({ itemId, attachments, onAttachmentChanged }: Props) {
  const { projectId = "" } = useParams<{ projectId: string }>();
  const [file, setFile] = useState<File | null>(null);
  const [uploadType, setUploadType] = useState<AcquisitionType>("fulltext");
  const [url, setUrl] = useState("");
  const [filename, setFilename] = useState("");
  const [downloadType, setDownloadType] = useState<AcquisitionType>("fulltext");
  const [mainTex, setMainTex] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [trackedJobs, setTrackedJobs] = useState<TrackedJob[]>([]);

  async function refreshCompletedJob() {
    try {
      await onAttachmentChanged();
      setError(null);
      setMessage("任务已完成，附件列表已自动更新。");
    } catch (reason) {
      setMessage(null);
      setError(reason instanceof Error
        ? `任务已完成，但附件列表刷新失败：${reason.message}`
        : "任务已完成，但附件列表刷新失败；请重新加载页面。");
    }
  }

  function track(job: Job, label: string) {
    setTrackedJobs((current) => [
      ...current.filter((entry) => entry.job.id !== job.id),
      { job, label, outcome: job.status === "succeeded" ? "succeeded" : "running" },
    ]);
    if (job.status === "succeeded") {
      void refreshCompletedJob();
    }
  }

  async function finishTrackedJob(
    jobId: string,
    outcome: TrackedJob["outcome"],
    event: JobEvent,
  ) {
    setTrackedJobs((current) => current.map((entry) => (
      entry.job.id === jobId ? { ...entry, outcome } : entry
    )));
    if (outcome === "succeeded") {
      await refreshCompletedJob();
      return;
    }
    const detail = typeof event.payload.message === "string"
      ? event.payload.message
      : outcome === "canceled" ? "资源任务已取消" : "资源任务执行失败";
    setError(detail);
  }

  async function upload(event: FormEvent) {
    event.preventDefault();
    if (!file) return;
    setBusy("upload");
    setError(null);
    setMessage(null);
    try {
      await api.uploadAttachment(itemId, file, {
        attachment_type: uploadType,
        language_mode: "original",
        origin: "user",
        preferred_for: uploadType === "fulltext" ? ["reading", "pdf:original"] : [],
      });
      setFile(null);
      setMessage("附件已验证并登记。");
      await onAttachmentChanged();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "附件上传失败");
    } finally {
      setBusy(null);
    }
  }

  async function acquire(event: FormEvent) {
    event.preventDefault();
    if (!url.trim()) return;
    setBusy("download");
    setError(null);
    setMessage(null);
    try {
      const job = await api.acquireAttachment(itemId, {
        url: url.trim(),
        filename: filename.trim() || null,
        attachment_type: downloadType,
        language_mode: "original",
        origin: "preprint",
        preferred_for: downloadType === "fulltext" ? ["reading", "pdf:original"] : [],
      }, projectId);
      track(job, "HTTPS 获取");
      setMessage(`HTTPS 获取任务已创建：${job.id}`);
      setUrl("");
      setFilename("");
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "无法创建资源获取任务");
    } finally {
      setBusy(null);
    }
  }

  async function compile(attachment: Attachment) {
    setBusy(attachment.id);
    setError(null);
    setMessage(null);
    try {
      const job = await api.compileAttachment(
        attachment.id,
        mainTex.trim() || null,
        projectId,
      );
      track(job, `编译 ${attachment.filename}`);
      setMessage(`TeX 编译任务已创建：${job.id}`);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "无法创建编译任务");
    } finally {
      setBusy(null);
    }
  }

  const sourceArchives = attachments.filter(
    (attachment) =>
      attachment.attachment_type === "source_archive" && attachment.format === "tex",
  );
  return (
    <section className="resource-actions">
      <header><div><span className="eyebrow">RESOURCES</span><h2>资源动作</h2></div><Link to="/tasks">查看任务</Link></header>
      <details>
        <summary><Icon name="upload" size={14} />上传本机文件</summary>
        <form onSubmit={(event) => void upload(event)}>
          <input
            accept=".pdf,.zip,.tar,.tgz,.tar.gz"
            type="file"
            onChange={(event) => {
              const next = event.target.files?.[0] ?? null;
              setFile(next);
              if (next) setUploadType(next.name.toLocaleLowerCase().endsWith(".pdf") ? "fulltext" : "source_archive");
            }}
          />
          <select value={uploadType} onChange={(event) => setUploadType(event.target.value as AcquisitionType)}>
            <option value="fulltext">原文 PDF</option><option value="source_archive">TeX 源码包</option>
          </select>
          <button className="toolbar-button" disabled={!file || busy !== null} type="submit">上传并验证</button>
        </form>
      </details>
      <details>
        <summary><Icon name="download" size={14} />从 HTTPS 获取</summary>
        <form onSubmit={(event) => void acquire(event)}>
          <input required type="url" pattern="https://.*" placeholder="https://…" value={url} onChange={(event) => setUrl(event.target.value)} />
          <input placeholder="可选文件名" value={filename} onChange={(event) => setFilename(event.target.value)} />
          <select value={downloadType} onChange={(event) => setDownloadType(event.target.value as AcquisitionType)}>
            <option value="fulltext">原文 PDF</option><option value="source_archive">TeX 源码包</option>
          </select>
          <button className="toolbar-button" disabled={!url.trim() || busy !== null} type="submit">创建获取任务</button>
        </form>
      </details>
      {sourceArchives.length ? <div className="resource-operation"><label><span>TeX 主文件（可选）</span><input placeholder="例如 main.tex" value={mainTex} onChange={(event) => setMainTex(event.target.value)} /></label>{sourceArchives.map((attachment) => <button className="toolbar-button" disabled={busy !== null} key={attachment.id} type="button" onClick={() => void compile(attachment)}><Icon name="terminal" size={14} />编译 {attachment.filename}</button>)}</div> : null}
      {message ? <p className="resource-message"><Icon name="check" size={13} />{message}<Link to="/tasks">打开任务中心</Link></p> : null}
      {error ? <p className="resource-error">{error}</p> : null}
      {trackedJobs.length ? <div className="resource-job-list" aria-label="本页资源任务">
        {trackedJobs.map((entry) => <ResourceJobTracker
          key={entry.job.id}
          tracked={entry}
          onTerminal={finishTrackedJob}
        />)}
      </div> : null}
    </section>
  );
}

function ResourceJobTracker({
  tracked,
  onTerminal,
}: {
  tracked: TrackedJob;
  onTerminal: (
    jobId: string,
    outcome: TrackedJob["outcome"],
    event: JobEvent,
  ) => Promise<void>;
}) {
  const reported = useRef(false);
  const [pollError, setPollError] = useState<string | null>(null);
  const stream = useEventStream<JobEvent>(
    tracked.outcome === "running" ? api.jobEventsUrl(tracked.job.id) : null,
  );
  const terminal = [...stream.events].reverse().find((event) => (
    event.event_type === "job.succeeded"
    || event.event_type === "job.failed"
    || event.event_type === "job.canceled"
  ));

  useEffect(() => {
    if (!terminal || reported.current) return;
    reported.current = true;
    const outcome = terminal.event_type === "job.succeeded"
      ? "succeeded"
      : terminal.event_type === "job.canceled" ? "canceled" : "failed";
    void onTerminal(tracked.job.id, outcome, terminal);
  }, [onTerminal, terminal, tracked.job.id]);

  useEffect(() => {
    if (tracked.outcome !== "running") return;
    let stopped = false;
    async function poll() {
      try {
        const job = await api.job(tracked.job.id);
        if (stopped) return;
        setPollError(null);
        if (!["succeeded", "failed", "canceled"].includes(job.status) || reported.current) return;
        reported.current = true;
        await onTerminal(
          job.id,
          job.status as "succeeded" | "failed" | "canceled",
          {
            id: -Date.now(),
            job_id: job.id,
            event_type: `job.${job.status}`,
            level: job.status === "failed" ? "error" : "info",
            payload: { message: job.error_message },
            created_at: job.updated_at,
          },
        );
      } catch (reason) {
        if (!stopped) setPollError(reason instanceof Error ? reason.message : "无法轮询任务状态");
      }
    }
    void poll();
    const timer = window.setInterval(() => void poll(), 5_000);
    return () => { stopped = true; window.clearInterval(timer); };
  }, [onTerminal, tracked.job.id, tracked.outcome]);

  return <article className={`resource-job resource-job--${tracked.outcome}`} role="status">
    <span>{tracked.label}</span>
    <strong title={pollError ?? undefined}>{tracked.outcome === "running"
      ? pollError ? "状态更新失败" : stream.state === "error" ? "实时连接重试中" : "执行中"
      : tracked.outcome === "succeeded" ? "已完成"
      : tracked.outcome === "canceled" ? "已取消" : "失败"}</strong>
    <Link to={`/tasks?job=${tracked.job.id}`}>查看任务</Link>
  </article>;
}
