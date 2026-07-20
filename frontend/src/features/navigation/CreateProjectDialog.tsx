import { useEffect, useRef, useState, type FormEvent } from "react";

import { Icon } from "../../shared/ui/Icon";

interface CreateProjectDialogProps {
  open: boolean;
  onClose: () => void;
  onCreate: (name: string) => Promise<void>;
}

export function CreateProjectDialog({ open, onClose, onCreate }: CreateProjectDialogProps) {
  const input = useRef<HTMLInputElement>(null);
  const [name, setName] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    input.current?.focus();
    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape" && !submitting) onClose();
    }
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [onClose, open, submitting]);

  if (!open) return null;

  async function submit(event: FormEvent) {
    event.preventDefault();
    const nextName = name.trim();
    if (!nextName) return;
    setSubmitting(true);
    setError(null);
    try {
      await onCreate(nextName);
      setName("");
      onClose();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "无法创建项目");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="dialog-backdrop" role="presentation" onMouseDown={onClose}>
      <form
        aria-labelledby="create-project-title"
        aria-modal="true"
        className="project-dialog"
        role="dialog"
        onMouseDown={(event) => event.stopPropagation()}
        onSubmit={(event) => void submit(event)}
      >
        <div className="dialog-heading">
          <div className="dialog-icon"><Icon name="folder" size={20} /></div>
          <div>
            <h2 id="create-project-title">新建学习项目</h2>
            <p>项目会直接出现在学习资料库中。</p>
          </div>
          <button aria-label="关闭" className="dialog-close" type="button" onClick={onClose}>
            <Icon name="close" size={18} />
          </button>
        </div>
        <label className="field-label" htmlFor="project-name">项目名称</label>
        <input
          ref={input}
          autoComplete="off"
          className="dialog-input"
          id="project-name"
          maxLength={80}
          placeholder="例如：多模态智能体"
          value={name}
          onChange={(event) => setName(event.target.value)}
        />
        {error ? <p className="dialog-error">{error}</p> : null}
        <div className="dialog-actions">
          <button className="toolbar-button" disabled={submitting} type="button" onClick={onClose}>
            取消
          </button>
          <button className="primary-button dialog-submit" disabled={!name.trim() || submitting} type="submit">
            {submitting ? "创建中…" : "创建项目"}
          </button>
        </div>
      </form>
    </div>
  );
}
