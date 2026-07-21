import type { Attachment, AttachmentLanguageMode } from "../../shared/api/contracts";

export const attachmentLabels: Record<AttachmentLanguageMode, string> = {
  original: "原文",
  bilingual: "双语",
  translated: "中文",
};

export const attachmentOrder: AttachmentLanguageMode[] = ["original", "bilingual", "translated"];

export function pdfByLanguageMode(attachments: Attachment[]): Partial<Record<AttachmentLanguageMode, Attachment>> {
  const result: Partial<Record<AttachmentLanguageMode, Attachment>> = {};
  const preferred = attachments
    .filter((item) => item.format === "pdf")
    .toSorted((left, right) => Number(right.preferred_for.includes("reading")) - Number(left.preferred_for.includes("reading")));
  for (const attachment of preferred) result[attachment.language_mode] ??= attachment;
  return result;
}
export function firstReadableAttachment(attachments: Attachment[]): Attachment | null {
  const available = pdfByLanguageMode(attachments);
  const mode = attachmentOrder.find((item) => available[item]);
  return mode ? available[mode] ?? null : null;
}
