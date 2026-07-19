import type { ReactNode } from "react";

import type { Artifact, ArtifactKind } from "../../shared/api/contracts";
import { artifactLabels, artifactOrder, artifactsByKind } from "./artifactVariants";
import type { PdfColorMode } from "./PdfViewer";

interface ReaderToolbarProps {
  artifacts: Artifact[];
  selected: ArtifactKind | null;
  colorMode: PdfColorMode;
  actions?: ReactNode;
  onSelect: (kind: ArtifactKind) => void;
  onColorMode: (mode: PdfColorMode) => void;
  onFullscreen: () => void;
}

export function ReaderToolbar({
  artifacts,
  selected,
  colorMode,
  actions,
  onSelect,
  onColorMode,
  onFullscreen,
}: ReaderToolbarProps) {
  const available = artifactsByKind(artifacts);
  return (
    <div className="reader-toolbar">
      <div className="toolbar-group" aria-label="PDF 版本">
        {artifactOrder.map((kind) => (
          <button
            key={kind}
            className={selected === kind ? "segmented active" : "segmented"}
            type="button"
            disabled={!available[kind]}
            onClick={() => onSelect(kind)}
          >
            {artifactLabels[kind]}
          </button>
        ))}
      </div>
      <div className="toolbar-group" aria-label="色彩模式">
        {(["normal", "dark", "sepia"] as const).map((mode) => (
          <button
            key={mode}
            className={colorMode === mode ? "segmented active" : "segmented"}
            type="button"
            onClick={() => onColorMode(mode)}
          >
            {{ normal: "彩色", dark: "暗色", sepia: "柔和" }[mode]}
          </button>
        ))}
      </div>
      <div className="toolbar-spacer" />
      {actions}
      <button className="toolbar-button" type="button" onClick={onFullscreen}>
        全屏
      </button>
    </div>
  );
}

