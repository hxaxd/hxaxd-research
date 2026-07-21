import { useEffect, useMemo, useState } from "react";

import { api } from "../../shared/api/client";
import type {
  Attachment,
  DocumentBlock,
  DocumentBlocksPage,
  Job,
  SemanticRole,
} from "../../shared/api/contracts";
import { useApiResource } from "../../shared/api/useApiResource";
import { AsyncMessage } from "../../shared/ui/AsyncMessage";
import { Icon } from "../../shared/ui/Icon";
import {
  effectiveReadingMode,
  filterSemanticBlocks,
  type ReadingMode,
} from "./semanticReading";
import "./semantic-reader.css";

type OcrMode = "auto" | "force" | "off";

const roleLabels: Record<SemanticRole, string> = {
  background: "背景",
  question: "问题",
  method: "方法",
  evidence: "证据",
  result: "结果",
  limitation: "局限",
  conclusion: "结论",
  other: "其他",
};

const terminalStatuses = new Set(["succeeded", "failed", "canceled"]);

interface Props {
  itemId: string;
  attachment: Attachment;
  onOpenPdf: (page: number | null) => void;
}

export function SemanticReader({ itemId, attachment, onOpenPdf }: Props) {
  const [targetLanguage, setTargetLanguage] = useState("zh-CN");
  const [mode, setMode] = useState<ReadingMode>(() => {
    const stored = window.localStorage.getItem("semantic-reading-mode");
    return stored === "bilingual" || stored === "translation" ? stored : "source";
  });
  const [role, setRole] = useState<SemanticRole | "all">("all");
  const [fontSize, setFontSize] = useState("medium");
  const [measure, setMeasure] = useState("balanced");
  const [density, setDensity] = useState("comfortable");
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [ocrMode, setOcrMode] = useState<OcrMode>("auto");
  const [activeJob, setActiveJob] = useState<Job | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  const documents = useApiResource(() => api.documents(itemId), [itemId]);
  const document = useMemo(
    () =>
      documents.data?.find(
        (candidate) =>
          candidate.source_attachment_id === attachment.id && candidate.status === "ready",
      ) ?? null,
    [attachment.id, documents.data],
  );
  const blocks = useApiResource<DocumentBlocksPage>(
    () =>
      document
        ? api.documentBlocks(document.id, targetLanguage)
        : Promise.resolve({ document_id: "", offset: 0, limit: 1000, total: 0, items: [] }),
    [document?.id, targetLanguage],
  );
  const activeJobId = activeJob?.id;
  const activeJobStatus = activeJob?.status;
  const reloadBlocks = blocks.reload;
  const reloadDocuments = documents.reload;

  useEffect(() => {
    if (!activeJobId || !activeJobStatus || terminalStatuses.has(activeJobStatus)) return;
    let disposed = false;
    const timer = window.setInterval(() => {
      void api.job(activeJobId).then((next) => {
        if (disposed) return;
        setActiveJob(next);
        if (next.status === "succeeded") {
          void reloadDocuments();
          void reloadBlocks();
        }
      }).catch((reason: unknown) => {
        if (!disposed) setActionError(reason instanceof Error ? reason.message : "任务状态读取失败");
      });
    }, 700);
    return () => {
      disposed = true;
      window.clearInterval(timer);
    };
  }, [activeJobId, activeJobStatus, reloadBlocks, reloadDocuments]);

  const visibleBlocks = useMemo(
    () => filterSemanticBlocks(blocks.data?.items ?? [], role),
    [blocks.data, role],
  );
  const translatedCount = (blocks.data?.items ?? []).filter(
    (block) => block.translation,
  ).length;
  const effectiveMode = effectiveReadingMode(mode, translatedCount);
  const outline = (blocks.data?.items ?? []).filter(
    (block) => block.kind === "title" || block.kind === "heading",
  );
  const isRunning = activeJob && !terminalStatuses.has(activeJob.status);

  useEffect(() => {
    window.localStorage.setItem("semantic-reading-mode", mode);
  }, [mode]);

  async function startExtraction() {
    setActionError(null);
    try {
      setActiveJob(await api.extractDocument(attachment.id, ocrMode));
    } catch (reason) {
      setActionError(reason instanceof Error ? reason.message : "无法开始结构化提取");
    }
  }

  async function startTranslation() {
    if (!document) return;
    setActionError(null);
    try {
      setActiveJob(await api.translateDocument(document.id, targetLanguage));
    } catch (reason) {
      setActionError(reason instanceof Error ? reason.message : "无法开始整篇翻译");
    }
  }

  if (documents.loading) {
    return <div className="semantic-reader"><AsyncMessage kind="loading">正在读取文档结构…</AsyncMessage></div>;
  }
  if (documents.error) {
    return <div className="semantic-reader"><AsyncMessage kind="error">{documents.error}</AsyncMessage></div>;
  }
  if (!document) {
    return <div className="semantic-reader semantic-reader--empty">
      <section className="semantic-onboarding">
        <span className="semantic-onboarding__icon"><Icon name="book-open" size={25} /></span>
        <span className="eyebrow">STRUCTURED READING</span>
        <h2>把线性 PDF 变成可筛选的阅读结构</h2>
        <p>复用 BabelDOC 的段落、布局、公式与页面坐标，一次生成稳定阅读块；之后整篇翻译与语义识别共用同一份结构。</p>
        <label>扫描件策略
          <select value={ocrMode} onChange={(event) => setOcrMode(event.target.value as OcrMode)}>
            <option value="auto">自动检测</option>
            <option value="force">强制离线 OCR</option>
            <option value="off">跳过扫描检测</option>
          </select>
        </label>
        <button className="primary-button semantic-primary-action" disabled={Boolean(isRunning)} type="button" onClick={() => void startExtraction()}>
          <Icon name={isRunning ? "activity" : "sparkles"} size={17} />
          {isRunning ? "正在生成结构…" : "生成结构化内容"}
        </button>
        <small>自动模式优先恢复原生段落；没有文本层时回退到真正的离线 OCR，并把页码、坐标与识别置信度保留到阅读块。</small>
        {actionError || activeJob?.error_message ? <p className="semantic-action-error">{actionError || activeJob?.error_message}</p> : null}
      </section>
    </div>;
  }

  return <div className={`semantic-reader semantic-reader--${fontSize} semantic-reader--${measure} semantic-reader--${density}`}>
    <header className="semantic-toolbar">
      <div className="semantic-segments" aria-label="阅读语言">
        {(["source", "bilingual", "translation"] as ReadingMode[]).map((value) => <button aria-pressed={effectiveMode === value} className={effectiveMode === value ? "active" : ""} disabled={!translatedCount && value !== "source"} key={value} type="button" onClick={() => setMode(value)}>{value === "source" ? "原文" : value === "bilingual" ? "双语" : "译文"}</button>)}
      </div>
      <label className="semantic-role-filter"><span>语义</span><select value={role} onChange={(event) => setRole(event.target.value as SemanticRole | "all")}><option value="all">全部节奏</option>{Object.entries(roleLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
      <span className="semantic-toolbar__status">{document.block_count} 块 · {translatedCount} 已译</span>
      <button className="toolbar-button" type="button" aria-expanded={settingsOpen} onClick={() => setSettingsOpen((value) => !value)}><Icon name="settings" size={15} />设置</button>
      <button className="primary-toolbar-button" disabled={Boolean(isRunning)} type="button" onClick={() => void startTranslation()}><Icon name={isRunning ? "activity" : "languages"} size={15} />{isRunning ? "处理中" : translatedCount ? "重新翻译与语义识别" : "翻译与语义识别"}</button>
    </header>
    {settingsOpen ? <section className="semantic-settings" aria-label="阅读设置">
      <label>目标语言<select value={targetLanguage} onChange={(event) => setTargetLanguage(event.target.value)}><option value="zh-CN">简体中文</option><option value="zh-TW">繁体中文</option><option value="en">English</option></select></label>
      <label>字号<select value={fontSize} onChange={(event) => setFontSize(event.target.value)}><option value="small">紧凑</option><option value="medium">标准</option><option value="large">大字</option></select></label>
      <label>行宽<select value={measure} onChange={(event) => setMeasure(event.target.value)}><option value="focused">专注</option><option value="balanced">均衡</option><option value="wide">宽屏</option></select></label>
      <label>块间距<select value={density} onChange={(event) => setDensity(event.target.value)}><option value="compact">紧密</option><option value="comfortable">舒展</option></select></label>
    </section> : null}
    {actionError || activeJob?.error_message ? <div className="semantic-job-message semantic-job-message--error">{actionError || activeJob?.error_message}</div> : isRunning ? <div className="semantic-job-message"><Icon name="activity" size={14} />后台任务进行中；可以继续阅读现有内容。</div> : null}
    <div className="semantic-layout">
      <nav className="semantic-outline" aria-label="文档目录">
        <span>文档节奏</span>
        {outline.map((block) => <button key={block.id} type="button" onClick={() => globalThis.document.getElementById(`block-${block.id}`)?.scrollIntoView({ behavior: "smooth", block: "center" })}>{block.source_text}</button>)}
      </nav>
      <main className="semantic-scroll">
        <article className="semantic-document">
          {blocks.loading ? <AsyncMessage kind="loading">正在装配阅读块…</AsyncMessage> : null}
          {blocks.error ? <AsyncMessage kind="error">{blocks.error}</AsyncMessage> : null}
          {!blocks.loading && !visibleBlocks.length ? <AsyncMessage kind="empty">当前筛选没有匹配的阅读块</AsyncMessage> : null}
          {visibleBlocks.map((block) => <SemanticBlockCard block={block} key={block.id} mode={effectiveMode} onOpenPdf={onOpenPdf} />)}
        </article>
      </main>
    </div>
  </div>;
}

function SemanticBlockCard({ block, mode, onOpenPdf }: { block: DocumentBlock; mode: ReadingMode; onOpenPdf: (page: number | null) => void }) {
  const heading = block.kind === "title" || block.kind === "heading";
  const source = heading ? <h2>{block.source_text}</h2> : <p>{block.source_text}</p>;
  const translation = block.translation
    ? heading
      ? <h2>{block.translation.translated_text}</h2>
      : <p>{block.translation.translated_text}</p>
    : <p className="semantic-untranslated">尚无此语言的译文</p>;
  return <section className={`semantic-block semantic-block--${block.kind}`} id={`block-${block.id}`}>
    <div className="semantic-block__meta">
      {block.semantic_role ? <span className={`role-chip role-chip--${block.semantic_role}`}>{roleLabels[block.semantic_role]}</span> : <span className="role-chip">未分类</span>}
      <button type="button" onClick={() => onOpenPdf(block.page_start)}>{block.page_start ? `第 ${block.page_start} 页` : "无页码"}<Icon name="arrow-right" size={12} /></button>
    </div>
    <div className={`semantic-block__content semantic-block__content--${mode}`}>
      {mode !== "translation" ? <div lang="en">{source}</div> : null}
      {mode !== "source" ? <div lang="zh-CN">{translation}</div> : null}
    </div>
  </section>;
}
