import { useState, type FormEvent } from "react";
import { Link } from "react-router-dom";

import { api } from "../../shared/api/client";
import type { Attachment } from "../../shared/api/contracts";
import { Icon } from "../../shared/ui/Icon";
import "./resources.css";

interface Props {
  itemId: string;
  attachments: Attachment[];
  onAttachmentChanged: () => Promise<unknown>;
}

type AcquisitionType = "fulltext" | "source_archive";

export function ResourceActions({ itemId, attachments, onAttachmentChanged }: Props) {
  const [file, setFile] = useState<File | null>(null);
  const [uploadType, setUploadType] = useState<AcquisitionType>("fulltext");
  const [url, setUrl] = useState("");
  const [filename, setFilename] = useState("");
  const [downloadType, setDownloadType] = useState<AcquisitionType>("fulltext");
  const [mainTex, setMainTex] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

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
      });
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
      const job = await api.compileAttachment(attachment.id, mainTex.trim() || null);
      setMessage(`TeX 编译任务已创建：${job.id}`);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "无法创建编译任务");
    } finally {
      setBusy(null);
    }
  }

  async function translate(attachment: Attachment) {
    setBusy(attachment.id);
    setError(null);
    setMessage(null);
    try {
      const job = await api.translateAttachment(attachment.id);
      setMessage(`PDF 翻译任务已创建：${job.id}`);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "无法创建翻译任务");
    } finally {
      setBusy(null);
    }
  }

  const sourceArchives = attachments.filter(
    (attachment) =>
      attachment.attachment_type === "source_archive" && attachment.format === "tex",
  );
  const originals = attachments.filter(
    (attachment) =>
      attachment.attachment_type === "fulltext" &&
      attachment.format === "pdf" &&
      attachment.language_mode === "original",
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
      {originals.length ? <div className="resource-operation resource-operation--translate"><p>翻译只会在你点击后创建任务，不会自动触发。</p>{originals.map((attachment) => <button className="primary-button" disabled={busy !== null} key={attachment.id} type="button" onClick={() => void translate(attachment)}><Icon name="languages" size={14} />翻译原文 {attachment.filename}</button>)}</div> : null}
      {message ? <p className="resource-message"><Icon name="check" size={13} />{message}<Link to="/tasks">打开任务中心</Link></p> : null}
      {error ? <p className="resource-error">{error}</p> : null}
    </section>
  );
}
