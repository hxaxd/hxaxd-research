import { useTranslationJob } from "./useTranslationJob";
import { Icon } from "../../shared/ui/Icon";
import "./translations.css";

interface TranslationButtonProps {
  paperId: string;
  disabled?: boolean;
  onCompleted: () => Promise<void> | void;
}

export function TranslationButton({ paperId, disabled, onCompleted }: TranslationButtonProps) {
  const { job, starting, error, start } = useTranslationJob(onCompleted);
  const active = job?.status === "queued" || job?.status === "running";
  const label = active ? `${job.message} ${job.progress}%` : starting ? "正在提交…" : "翻译";

  return (
    <div className="translation-action">
      <button
        className="primary-toolbar-button"
        type="button"
        disabled={disabled || starting || active}
        onClick={() => void start(paperId)}
      >
        <Icon name="languages" size={15} /><span>{label}</span>
      </button>
      {job?.status === "failed" ? (
        <span className="inline-error" title={job.error_summary ?? undefined}>
          翻译失败
        </span>
      ) : null}
      {error ? <span className="inline-error">{error}</span> : null}
    </div>
  );
}
