import type { ReactNode } from "react";

import type { Attachment, AttachmentLanguageMode } from "../../shared/api/contracts";
import { Icon, type IconName } from "../../shared/ui/Icon";
import { attachmentLabels, attachmentOrder, pdfByLanguageMode } from "./artifactVariants";
import type { PdfColorMode } from "./PdfViewer";

interface Props {
  attachments: Attachment[];
  selected: AttachmentLanguageMode | null;
  colorMode: PdfColorMode;
  actions?: ReactNode;
  onSelect: (attachment: Attachment) => void;
  onColorMode: (mode: PdfColorMode) => void;
  onFullscreen: () => void;
}
export function ReaderToolbar({ attachments, selected, colorMode, actions, onSelect, onColorMode, onFullscreen }: Props) {
  const available = pdfByLanguageMode(attachments);
  const colorModes: Array<{ icon: IconName; label: string; mode: PdfColorMode }> = [
    { icon: "sun", label: "彩色", mode: "normal" },
    { icon: "moon", label: "暗色", mode: "dark" },
    { icon: "coffee", label: "柔和", mode: "sepia" },
  ];
  return <div className="reader-toolbar"><div className="reader-toolbar-primary"><div className="toolbar-group toolbar-group--versions" aria-label="PDF 版本">{attachmentOrder.map((mode) => <button key={mode} aria-pressed={selected === mode} className={selected === mode ? "segmented active" : "segmented"} type="button" disabled={!available[mode]} onClick={() => { const attachment = available[mode]; if (attachment) onSelect(attachment); }}><Icon name={mode === "original" ? "file-text" : "languages"} size={14} /><span>{attachmentLabels[mode]}</span></button>)}</div><span className="toolbar-divider" /><div className="toolbar-group toolbar-group--colors" aria-label="色彩模式">{colorModes.map(({ icon, label, mode }) => <button key={mode} aria-label={label} aria-pressed={colorMode === mode} className={colorMode === mode ? "segmented active" : "segmented"} title={label} type="button" onClick={() => onColorMode(mode)}><Icon name={icon} size={15} /><span>{label}</span></button>)}</div></div><div className="reader-toolbar-actions">{actions}<button className="toolbar-button" type="button" onClick={onFullscreen}><Icon name="maximize" size={15} /><span>全屏</span></button></div></div>;
}
