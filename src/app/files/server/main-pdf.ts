export function isPdfPath(path: string) {
  return /\.pdf$/i.test(path);
}

export function selectMainPdf(paths: string[]): string | undefined {
  return paths.sort((a, b) =>
    a.split('/').length - b.split('/').length || a.localeCompare(b, 'en', { numeric: true }),
  )[0];
}
