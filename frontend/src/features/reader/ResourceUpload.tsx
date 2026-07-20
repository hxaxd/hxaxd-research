import { useRef, useState } from "react";

import { api } from "../../shared/api/client";
import type { Resource } from "../../shared/api/contracts";
import { Icon } from "../../shared/ui/Icon";

export function ResourceUpload({ paperId, compact = false, onUploaded }: { paperId: string; compact?: boolean; onUploaded: (resource: Resource) => Promise<void> | void }) {
  const input = useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function upload(file: File) {
    setUploading(true); setError(null);
    try {
      const format = file.name.toLowerCase().endsWith(".pdf") ? "pdf" : "tex";
      const resource = await api.uploadResource(paperId, file, format);
      await onUploaded(resource);
    } catch (reason) { setError(reason instanceof Error ? reason.message : "上传失败"); }
    finally { setUploading(false); if (input.current) input.current.value = ""; }
  }
  return <div className={compact ? "upload-inline" : "upload-card"}>{!compact ? <div><span className="upload-card-icon"><Icon name="upload" size={23} /></span><h3>还没有可阅读的 PDF</h3><p>可以上传 PDF，或上传 zip、tar、tar.gz 格式的 TeX 源码包后编译。</p></div> : null}
    <input ref={input} hidden type="file" accept="application/pdf,.pdf,.zip,.tar,.tar.gz,.tgz" onChange={(event) => { const file = event.target.files?.[0]; if (file) void upload(file); }} />
    <button className={compact ? "toolbar-button" : "primary-button"} type="button" disabled={uploading} onClick={() => input.current?.click()}><Icon name="upload" size={15} /><span>{uploading ? "上传中…" : compact ? "添加资源" : "选择 PDF 或 TeX"}</span></button>{error ? <span className="inline-error">{error}</span> : null}</div>;
}
