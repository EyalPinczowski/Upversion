import { strToU8, zipSync } from 'fflate';

const W = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
const esc = (t: string) => t.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** A minimal DOCX with one paragraph per line (`\t` becomes a tab). Fictional text only. */
export function buildDocx(lines: string[], extraXml = ''): File {
  const paragraphs = lines
    .map((line) => {
      const runs = line
        .split('\t')
        .map((part) => `<w:r><w:t xml:space="preserve">${esc(part)}</w:t></w:r>`)
        .join('<w:r><w:tab/></w:r>');
      return `<w:p>${runs}</w:p>`;
    })
    .join('');
  const xml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document xmlns:w="${W}"><w:body>${paragraphs}${extraXml}</w:body></w:document>`;
  const zip = zipSync({
    '[Content_Types].xml': strToU8('<Types/>'),
    'word/document.xml': strToU8(xml),
  });
  return new File([zip], 'cv.docx', {
    type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  });
}
