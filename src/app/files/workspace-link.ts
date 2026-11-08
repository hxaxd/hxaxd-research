import type { ReadingContext } from './schema';

/**
 * Links written by the model usually point at workspace files, either as a
 * relative path (`papers/a/paper.pdf`), an absolute path that contains the
 * workspace folder, or one of the app's own file URLs. Anything else stays a
 * normal link so external sources keep opening in the browser.
 */
const scheme = /^[a-z][a-z\d+.-]*:/i;

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function pageHint(value: string) {
  const match = /[?#&]page=(\d+)(?=$|[&#])/i.exec(value);
  const page = Number(match?.[1]);
  return Number.isSafeInteger(page) && page > 0 ? page : undefined;
}

function decode(value: string) {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

/** Workspace paths are stored with forward slashes; `?` never belongs to a file name. */
function normalize(value: string) {
  return value.replaceAll('\\', '/').split(/[?#]/)[0];
}

function documentPath(value: string, page?: number): ReadingContext | null {
  const trimmed = value.replaceAll('\\', '/').replace(/^(?:\.\/)+/, '').replace(/^\/+/, '').replace(/\/+$/, '');
  if (!trimmed) return null;
  const parts = trimmed.split('/');
  if (parts.some((part) => !part || part === '.' || part === '..')) return null;
  return { path: trimmed, ...(/\.pdf$/i.test(trimmed) && page !== undefined ? { page } : {}) };
}

export function resolveWorkspaceLink(href: string, workspaceId: string, origin?: string): ReadingContext | null {
  const raw = href.trim();
  if (!raw || raw.startsWith('#')) return null;
  const page = pageHint(raw);
  // Keep the query string for the API URL check below; path handling strips it again.
  const value = raw.replaceAll('\\', '/');

  const absoluteWeb = /^(?:https?:|\/\/)/i.test(value);
  const url = URL.parse(value, origin ?? 'http://workspace.local');
  if (absoluteWeb && (!origin || url?.origin !== origin)) return null;
  if (url && /^https?:$/.test(url.protocol) && url.pathname.startsWith('/api/workspaces/')) {
    const prefix = `/api/workspaces/${workspaceId}`;
    if (url.pathname === `${prefix}/file`) {
      const path = url.searchParams.get('path');
      return path ? documentPath(path, page) : null;
    }
    const preview = `${prefix}/preview/`;
    return url.pathname.startsWith(preview) ? documentPath(decode(url.pathname.slice(preview.length)), page) : null;
  }
  if (absoluteWeb || (scheme.test(value) && !/^(?:file:|[a-z]:\/)/i.test(value))) return null;

  // Absolute paths that pass through the workspace folder, such as C:/…/workspaces/<id>/papers/a.pdf.
  const marker = new RegExp(`/workspaces/${escapeRegExp(workspaceId)}/`, 'i').exec(normalize(value));
  if (marker) return documentPath(decode(normalize(value).slice(marker.index + marker[0].length)), page);

  if (scheme.test(normalize(value)) || normalize(value).startsWith('//')) return null;
  return documentPath(decode(normalize(value)), page);
}
