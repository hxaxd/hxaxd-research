import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useParams } from "react-router-dom";

import { usePaper } from "../../features/papers/usePaper";
import { artifactsByKind, firstAvailableKind } from "../../features/reader/artifactVariants";
import { OriginalPdfUpload } from "../../features/reader/OriginalPdfUpload";
import { PdfViewer, type PdfColorMode } from "../../features/reader/PdfViewer";
import { ReaderToolbar } from "../../features/reader/ReaderToolbar";
import { useArtifacts } from "../../features/reader/useArtifacts";
import { TranslationButton } from "../../features/translations/TranslationButton";
import { api } from "../../shared/api/client";
import type { ArtifactKind } from "../../shared/api/contracts";
import { AsyncMessage } from "../../shared/ui/AsyncMessage";

export function PaperPage() {
  const { paperId } = useParams<{ paperId: string }>();
  if (!paperId) return <AsyncMessage kind="error">论文地址无效</AsyncMessage>;
  return <PaperContent paperId={paperId} />;
}

function PaperContent({ paperId }: { paperId: string }) {
  const reader = useRef<HTMLDivElement>(null);
  const { paper, loading: paperLoading, error: paperError } = usePaper(paperId);
  const {
    artifacts,
    loading: artifactLoading,
    error: artifactError,
    reload: reloadArtifacts,
  } = useArtifacts(paperId);
  const [selected, setSelected] = useState<ArtifactKind | null>(null);
  const [colorMode, setColorMode] = useState<PdfColorMode>("normal");
  const available = useMemo(() => artifactsByKind(artifacts), [artifacts]);

  useEffect(() => {
    if (!selected || !available[selected]) setSelected(firstAvailableKind(artifacts));
  }, [artifacts, available, selected]);

  const refreshAfterTranslation = useCallback(async () => {
    await reloadArtifacts();
    setSelected("bilingual");
  }, [reloadArtifacts]);

  if (paperLoading || artifactLoading) {
    return <AsyncMessage kind="loading">正在打开论文…</AsyncMessage>;
  }
  if (paperError || artifactError) {
    return <AsyncMessage kind="error">{paperError ?? artifactError}</AsyncMessage>;
  }
  if (!paper) return <AsyncMessage kind="empty">论文不存在</AsyncMessage>;

  const current = selected ? available[selected] : undefined;
  const originalExists = available.original !== undefined;
  const translationsExist = available.chinese !== undefined && available.bilingual !== undefined;

  return (
    <section className="paper-page" ref={reader}>
      <header className="paper-header">
        <div className="paper-heading-copy">
          <span className="eyebrow">{paper.paper_type}</span>
          <h2>{paper.title_zh}</h2>
          <p title={paper.title_en}>{paper.title_en}</p>
        </div>
      </header>
      {artifacts.length === 0 ? (
        <OriginalPdfUpload paperId={paperId} onUploaded={reloadArtifacts} />
      ) : (
        <div className="reader-frame">
          <ReaderToolbar
            artifacts={artifacts}
            selected={selected}
            colorMode={colorMode}
            onSelect={setSelected}
            onColorMode={setColorMode}
            onFullscreen={() => void reader.current?.requestFullscreen()}
            actions={
              <>
                <OriginalPdfUpload compact paperId={paperId} onUploaded={reloadArtifacts} />
                <TranslationButton
                  paperId={paperId}
                  disabled={!originalExists || translationsExist}
                  onCompleted={refreshAfterTranslation}
                />
                {selected ? (
                  <a
                    className="toolbar-button"
                    href={api.artifactDownloadUrl(paperId, selected)}
                  >
                    下载
                  </a>
                ) : null}
              </>
            }
          />
          {current && selected ? (
            <PdfViewer
              key={`${selected}-${current.sha256}`}
              url={api.artifactUrl(paperId, selected, current.sha256)}
              colorMode={colorMode}
            />
          ) : (
            <AsyncMessage kind="empty">所选 PDF 版本尚不存在</AsyncMessage>
          )}
        </div>
      )}
    </section>
  );
}

