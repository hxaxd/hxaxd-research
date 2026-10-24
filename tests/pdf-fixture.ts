export function pdfFixture(pageCount = 1) {
  const objects = ['', '', '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>'];
  const pages: number[] = [];
  for (let page = 1; page <= pageCount; page++) {
    const text = page === 1 ? 'Research fixture: alpha and beta' : `Research fixture: page ${page}`;
    const stream = `BT /F1 16 Tf 40 420 Td (${text}) Tj ET`;
    const content = objects.push(`<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`);
    const id = objects.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 400 500] /Resources << /Font << /F1 3 0 R >> >> /Contents ${content} 0 R >>`);
    pages.push(id);
  }
  let outline = '';
  if (pageCount > 1) {
    const root = objects.push('');
    const first = root + 1;
    for (let index = 0; index < pageCount; index++) {
      objects.push(`<< /Title (Section ${index + 1}) /Parent ${root} 0 R /Dest [${pages[index]} 0 R /Fit] ${index ? `/Prev ${first + index - 1} 0 R` : ''} ${index < pageCount - 1 ? `/Next ${first + index + 1} 0 R` : ''} >>`);
    }
    objects[root - 1] = `<< /Type /Outlines /First ${first} 0 R /Last ${first + pageCount - 1} 0 R /Count ${pageCount} >>`;
    outline = `/Outlines ${root} 0 R`;
  }
  objects[0] = `<< /Type /Catalog /Pages 2 0 R ${outline} >>`;
  objects[1] = `<< /Type /Pages /Kids [${pages.map(id => `${id} 0 R`).join(' ')}] /Count ${pageCount} >>`;
  let pdf = '%PDF-1.4\n';
  const offsets = [0];
  for (const [index, object] of objects.entries()) {
    offsets.push(Buffer.byteLength(pdf));
    pdf += `${index + 1} 0 obj\n${object}\nendobj\n`;
  }
  const xref = Buffer.byteLength(pdf);
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.slice(1).map(offset => `${String(offset).padStart(10, '0')} 00000 n \n`).join('')}trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
  return Buffer.from(pdf);
}
