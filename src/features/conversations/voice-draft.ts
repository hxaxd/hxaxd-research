export type TextRange = { start: number; end: number };

function commonPrefix(previous: string, next: string) {
  const max = Math.min(previous.length, next.length);
  let index = 0;
  while (index < max && previous[index] === next[index]) index += 1;
  return index;
}

function commonSuffix(previous: string, next: string, prefix: number) {
  const max = Math.min(previous.length, next.length) - prefix;
  let index = 0;
  while (
    index < max &&
    previous[previous.length - 1 - index] === next[next.length - 1 - index]
  )
    index += 1;
  return index;
}

export function adjustPosition(position: number, previous: string, next: string) {
  if (previous === next) return position;
  const prefix = commonPrefix(previous, next);
  const suffix = commonSuffix(previous, next, prefix);
  const removedEnd = previous.length - suffix;
  const delta = next.length - previous.length;
  if (position < prefix) return position;
  if (position === prefix)
    return delta > 0 && prefix === removedEnd ? position + delta : position;
  if (position >= removedEnd) return position + delta;
  return prefix;
}

export function adjustRange(range: TextRange, previous: string, next: string): TextRange {
  const start = adjustPosition(range.start, previous, next);
  const end = adjustPosition(range.end, previous, next);
  return { start, end };
}

function needsSpace(before: string, chunk: string) {
  const last = before.at(-1);
  if (!last || /\s/.test(last)) return false;
  if (/^[\s.,!?;:，。！？；：、)\]】》」』]/u.test(chunk)) return false;
  if (/[\[(（【《「『]$/u.test(last)) return false;
  const cjk = /[\u3400-\u9fff\uf900-\ufaff]/u;
  if (cjk.test(last) && cjk.test(chunk[0])) return false;
  return true;
}

export function insertVoiceText(
  text: string,
  range: TextRange,
  content: string,
): { text: string; range: TextRange; inserted: TextRange } {
  const { start, end } = range;
  const before = text.slice(0, start);
  const after = text.slice(end);
  const inserted = `${needsSpace(before, content) ? ' ' : ''}${content}`;
  const insertedEnd = start + inserted.length;
  return {
    text: `${before}${inserted}${after}`,
    range: { start: insertedEnd, end: insertedEnd },
    inserted: { start, end: insertedEnd },
  };
}

export function removeRanges(text: string, ranges: TextRange[]) {
  let next = text;
  for (const range of [...ranges].sort((a, b) => b.start - a.start)) {
    const { start, end } = range;
    next = `${next.slice(0, start)}${next.slice(end)}`;
  }
  return next;
}
