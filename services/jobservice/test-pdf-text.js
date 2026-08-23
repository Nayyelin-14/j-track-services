/// { PDFParse } from "pdf-parse"

// Build a simple but valid PDF with text content
function makePdfWithText(text) {
  // Escape for PDF content stream
  const escaped = text.replace(/\\/g, '\\\\').replace(/\(/g, '\(').replace(/\)/g, '\)');
  
  let content = 'BT\n/F1 12 Tf\n72 740 Td\n';
  const lines = text.split('\n');
  lines.forEach((line, i) => {
    content += '0 -16 Td\n(' + escaped + ') Tj\n';
  });
  content += 'ET';

  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
    '<</Length ' + Buffer.from(content, 'ascii').length + '>>\nstream\n' + content + '\nendstream',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ];

  let pdf = '%PDF-1.4\n';
  const offsets = [0];
  objects.forEach((obj, i) => {
    offsets.push(Buffer.byteLength(pdf, 'ascii'));
    pdf += (i + 1) + ' 0 obj\n' + obj + '\nendobj\n';
  });

  const xrefOffset = Buffer.byteLength(pdf, 'ascii');
  pdf += 'xref\n0 ' + (objects.length + 1) + '\n0000000000 65535 f \n';
  for (let i = 1; i <= objects.length; i++) {
    pdf += String(offsets[i]).padStart(10, '0') + ' 00000 n \n';
  }
  pdf += 'trailer\n<< /Size ' + (objects.length + 1) + ' /Root 1 0 R >>\nstartxref\n' + xrefOffset + '\n%%EOF';

  return Buffer.from(pdf, 'ascii');
}

// Test with 50+ chars of text content
const testText = 'PROFILE\nSoftware Developer with 3+ years experience in web development using React, Node.js, and TypeScript. Skilled in building responsive web applications and REST APIs using modern frameworks.\nSKILLS\nJavaScript, React, Node.js, SQL, HTML/CSS, TypeScript, Git, Webpack\nEXPERIENCE\nDeveloped responsive web applications using React and Node.js. Built REST APIs with Express. Implemented CI/CD pipelines for automated testing and deployment. Worked in agile teams and collaborated with cross-functional stakeholders.\nEDUCATION\nBachelor of Science in Computer Science\nUniversity of Technology';

const pdfBuf = makePdfWithText(testText);
const uint8 = new Uint8Array(pdfBuf.buffer, pdfBuf.byteOffset, pdfBuf.byteLength);

PDFParse(uint8).getText().then((result) => {
  console.log('Text length:', result.text.length);
  console.log('Meets 50+:', result.text.length >= 50);
  if (result.text) console.log('First 200 chars:', result.text.substring(0, 200));
}).catch((e) => {
  console.error('ERROR:', e.message);
});