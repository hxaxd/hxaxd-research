import { useRef, useState } from "react";

import { api } from "../../shared/api/client";
import "./reader.css";

interface OriginalPdfUploadProps {
  paperId: string;
  compact?: boolean;
  onUploaded: () => Promise<void> | void;
}

export function OriginalPdfUpload({
  paperId,
  compact = false,
  onUploaded,
}: OriginalPdfUploadProps) {
  const input = useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function upload(file: File) {
    setUploading(true);
    setError(null);
    try {
      await api.uploadOriginal(paperId, file);
      await onUploaded();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "上传失败");
    } finally {
      setUploading(false);
      if (input.current) input.current.value = "";
    }
  }

  return (
    <div className={compact ? "upload-inline" : "upload-card"}>
      {!compact ? (
        <div>
          <span className="eyebrow">ORIGINAL PDF</span>
          <h3>还没有原文</h3>
          <p>添加原文后即可在浏览器阅读并启动翻译。</p>
        </div>
      ) : null}
      <input
        ref={input}
        hidden
        type="file"
        accept="application/pdf,.pdf"
        onChange={(event) => {
          const file = event.target.files?.[0];
          if (file) void upload(file);
        }}
      />
      <button
        className={compact ? "toolbar-button" : "primary-button"}
        type="button"
        disabled={uploading}
        onClick={() => input.current?.click()}
      >
        {uploading ? "上传中…" : compact ? "替换原文" : "选择 PDF"}
      </button>
      {error ? <span className="inline-error">{error}</span> : null}
    </div>
  );
}
