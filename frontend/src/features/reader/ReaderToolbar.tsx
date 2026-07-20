import type { ReactNode } from "react";

import type { Resource, ResourceRepresentation } from "../../shared/api/contracts";
import { Icon, type IconName } from "../../shared/ui/Icon";
import { pdfByRepresentation, resourceLabels, resourceOrder } from "./artifactVariants";
import type { PdfColorMode } from "./PdfViewer";

interface Props {
  resources: Resource[]; selected: ResourceRepresentation | null; colorMode: PdfColorMode;
  actions?: ReactNode; onSelect: (kind: ResourceRepresentation) => void;
  onColorMode: (mode: PdfColorMode) => void; onFullscreen: () => void;
}

export function ReaderToolbar({ resources, selected, colorMode, actions, onSelect, onColorMode, onFullscreen }: Props) {
  const available = pdfByRepresentation(resources);
  const colorModes: Array<{ icon: IconName; label: string; mode: PdfColorMode }> = [
    { icon: "sun", label: "彩色", mode: "normal" }, { icon: "moon", label: "暗色", mode: "dark" }, { icon: "coffee", label: "柔和", mode: "sepia" },
  ];
  return <div className="reader-toolbar"><div className="reader-toolbar-primary"><div className="toolbar-group toolbar-group--versions" aria-label="PDF 版本">
    {resourceOrder.map((kind) => <button key={kind} aria-pressed={selected === kind} className={selected === kind ? "segmented active" : "segmented"} type="button" disabled={!available[kind]} onClick={() => onSelect(kind)}><Icon name={kind === "original" ? "file-text" : "languages"} size={14} /><span>{resourceLabels[kind]}</span></button>)}
  </div><span className="toolbar-divider" /><div className="toolbar-group toolbar-group--colors" aria-label="色彩模式">{colorModes.map(({ icon, label, mode }) => <button key={mode} aria-label={label} aria-pressed={colorMode === mode} className={colorMode === mode ? "segmented active" : "segmented"} title={label} type="button" onClick={() => onColorMode(mode)}><Icon name={icon} size={15} /><span>{label}</span></button>)}</div></div>
  <div className="reader-toolbar-actions">{actions}<button className="toolbar-button" type="button" onClick={onFullscreen}><Icon name="maximize" size={15} /><span>全屏</span></button></div></div>;
}
