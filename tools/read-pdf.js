const fs = require('fs');
const { PDFParse } = require('pdf-parse');
const p = process.argv[2];
if (!p) { console.error('Usage: node read-pdf.js <file>'); process.exit(1); }
(async () => {
  try {
    const buf = fs.readFileSync(p);
    const parser = new PDFParse({ data: new Uint8Array(buf) });
    const res = await parser.getText();
    console.log('PAGES:', res.numpages || res.pages || '?');
    console.log('--- TEXT ---');
    console.log(res.text || '');
  } catch (e) { console.error('err', e.message); process.exit(1); }
})();
