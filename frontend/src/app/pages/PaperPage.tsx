import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link, useParams } from "react-router-dom";

import { usePaper } from "../../features/papers/usePaper";
import { firstAvailableRepresentation, pdfByRepresentation } from "../../features/reader/artifactVariants";
import { PdfViewer, type PdfColorMode } from "../../features/reader/PdfViewer";
import { ReaderToolbar } from "../../features/reader/ReaderToolbar";
import { ResourceUpload } from "../../features/reader/ResourceUpload";
import { useResources } from "../../features/reader/useArtifacts";
import { TranslationButton } from "../../features/translations/TranslationButton";
import { api } from "../../shared/api/client";
import type { Job, Resource, ResourceRepresentation } from "../../shared/api/contracts";
import { AsyncMessage } from "../../shared/ui/AsyncMessage";
import { Icon } from "../../shared/ui/Icon";
import "./pages.css";

export function PaperPage() {
  const { paperId } = useParams<{ paperId: string }>();
  if (!paperId) return <AsyncMessage kind="error">论文地址无效</AsyncMessage>;
  return <PaperContent paperId={paperId} />;
}

function PaperContent({ paperId }: { paperId: string }) {
  const reader = useRef<HTMLDivElement>(null);
  const { paper, projects, loading: paperLoading, error: paperError } = usePaper(paperId);
  const { resources, loading: resourceLoading, error: resourceError, reload } = useResources(paperId);
  const [selected, setSelected] = useState<ResourceRepresentation | null>(null);
  const [colorMode, setColorMode] = useState<PdfColorMode>("normal");
  const available = useMemo(() => pdfByRepresentation(resources), [resources]);
  useEffect(() => { if (!selected || !available[selected]) setSelected(firstAvailableRepresentation(resources)); }, [available, resources, selected]);
  const refreshAfterTranslation = useCallback(async () => { await reload(); setSelected("bilingual"); }, [reload]);
  if (paperLoading || resourceLoading) return <AsyncMessage kind="loading">正在打开论文…</AsyncMessage>;
  if (paperError || resourceError) return <AsyncMessage kind="error">{paperError ?? resourceError}</AsyncMessage>;
  if (!paper) return <AsyncMessage kind="empty">论文不存在</AsyncMessage>;
  const current = selected ? available[selected] : undefined;
  const projectContext = projects[0];
  const project = projectContext?.membership;
  const texResources = resources.filter((item) => item.format === "tex");
  const originalExists = available.original !== undefined;
  const translationsExist = available.translated !== undefined && available.bilingual !== undefined;
  return <section className="paper-page" ref={reader}>
    <header className="paper-header"><Link className="paper-back-link" title="返回项目" to={project ? `/projects/${project.project_id}` : "/"}><Icon name="arrow-left" size={18} /></Link><div className="paper-heading-copy"><div className="paper-kicker"><span>{project?.roles.join(" / ") || "候选论文"}</span><i /><span>{paper.publication_year ?? "年份未知"}</span><i /><span>{paper.authors.slice(0, 2).join(", ")}{!paper.authors_complete ? " 等" : ""}</span></div><h1>{paper.title_zh || paper.title}</h1><p title={paper.title}>{paper.title}</p></div></header>
    <details className="paper-details" open><summary>论文信息、项目判断与资源</summary><div className="paper-detail-grid">
      <section><h2>论文事实</h2><dl><dt>作者</dt><dd>{paper.authors.join("、")}{!paper.authors_complete ? "（旧数据作者不完整）" : ""}</dd><dt>发表</dt><dd>{paper.venue || "未知场所"} · {paper.publication_state} · {paper.publication_year ?? "未知年份"}</dd><dt>摘要</dt><dd>{paper.abstract || "尚未收录摘要"}</dd><dt>标识符</dt><dd>{paper.identifiers.map((item) => <code key={item.id}>{item.scheme}:{item.value}</code>)}</dd><dt>链接</dt><dd>{paper.links.map((item) => <a key={`${item.type}-${item.url}`} href={item.url} target="_blank" rel="noreferrer">{item.type}</a>)}</dd></dl></section>
      <section><h2>项目判断</h2>{projects.length ? <div className="project-judgments">{projects.map(({ project: record, membership }) => <div key={membership.id}><h3><Link to={`/projects/${record.id}`}>{record.name}</Link></h3><dl><dt>状态 / 角色</dt><dd>{membership.status} · {membership.roles.join("、") || "未分类"}</dd><dt>摘要</dt><dd>{membership.summary || "尚未补充"}</dd><dt>贡献</dt><dd>{membership.contributions.length ? <ul>{membership.contributions.map((item) => <li key={item}>{item}</li>)}</ul> : "尚未补充"}</dd><dt>相关性</dt><dd>{membership.relevance || "尚未补充"}</dd><dt>阅读重点</dt><dd>{membership.reading_focus.join("、") || "尚未补充"}</dd></dl></div>)}</div> : <p>尚未关联学习项目。</p>}</section>
      <section><h2>资源</h2><div className="resource-list">{resources.map((resource) => <div key={resource.id}><strong>{resource.format.toUpperCase()} · {resource.representation}</strong><span>{resource.origin} · {(resource.size / 1024 / 1024).toFixed(1)} MB{resource.preferred ? " · 首选" : ""}</span><span>{resource.parent_resource_id ? "派生资源" : "原始资源"}</span><a href={api.resourceDownloadUrl(resource.id)}>下载</a>{resource.format === "tex" ? <CompileButton resource={resource} onCompleted={reload} /> : null}</div>)}</div></section>
    </div></details>
    <div className="reader-frame"><ReaderToolbar resources={resources} selected={selected} colorMode={colorMode} onSelect={setSelected} onColorMode={setColorMode} onFullscreen={() => void reader.current?.requestFullscreen()} actions={<><ResourceUpload compact paperId={paperId} onUploaded={async () => { await reload(); }} /><TranslationButton paperId={paperId} disabled={!originalExists || translationsExist} onCompleted={refreshAfterTranslation} />{current ? <a className="toolbar-button" href={api.resourceDownloadUrl(current.id)}><Icon name="download" size={15} /><span>下载</span></a> : null}</>} />
      {current ? <PdfViewer key={`${current.id}-${current.sha256}`} url={api.resourceUrl(current.id, current.sha256)} colorMode={colorMode} /> : <div className="resource-empty"><ResourceUpload paperId={paperId} onUploaded={async () => { await reload(); }} />{texResources.length ? <p>已存在 TeX 源码，请点击资源区的“编译”生成 PDF。</p> : null}</div>}
    </div>
  </section>;
}

function CompileButton({ resource, onCompleted }: { resource: Resource; onCompleted: () => Promise<void> | void }) {
  const [job, setJob] = useState<Job | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (!job || !["queued", "running"].includes(job.status)) return;
    const timer = window.setTimeout(() => { void api.job(job.id).then(async (next) => { setJob(next); if (next.status === "succeeded") await onCompleted(); }).catch((reason: unknown) => setError(reason instanceof Error ? reason.message : "无法读取编译进度")); }, 1000);
    return () => window.clearTimeout(timer);
  }, [job, onCompleted]);
  return <><button type="button" disabled={job?.status === "queued" || job?.status === "running"} onClick={() => { setError(null); void api.createJob("compile", resource.id).then(setJob).catch((reason: unknown) => setError(reason instanceof Error ? reason.message : "无法启动编译")); }}>{job && ["queued", "running"].includes(job.status) ? `${job.message} ${job.progress}%` : "编译"}</button>{job?.status === "failed" ? <span className="inline-error" title={job.error_summary ?? undefined}>编译失败</span> : null}{error ? <span className="inline-error">{error}</span> : null}</>;
}
