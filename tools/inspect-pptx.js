// Quick inspector: dump color hits + logo position from a .pptx so we can confirm what was rendered.
const AdmZip = require('adm-zip');
const path = process.argv[2];
if (!path) { console.error('Usage: node inspect-pptx.js <file.pptx>'); process.exit(1); }
const z = new AdmZip(path);
const get = (entry) => { const e = z.getEntry(entry); return e ? e.getData().toString('utf8') : ''; };
const masterXml = get('ppt/slideMasters/slideMaster1.xml');
const slide1Xml = get('ppt/slides/slide1.xml');
const slide2Xml = get('ppt/slides/slide2.xml');
const find = (txt, c) => (txt.match(new RegExp('val="' + c + '"', 'gi')) || []).length + (txt.match(new RegExp('color="' + c + '"', 'gi')) || []).length;
console.log('MASTER (slideMaster1.xml):');
console.log('  orange F58220 hits:', find(masterXml, 'F58220'));
console.log('  yellow FBC02D hits:', find(masterXml, 'FBC02D'));
console.log('  navy   1E3A5F hits:', find(masterXml, '1E3A5F'));
const offMatch = masterXml.match(/<p:pic>[\s\S]*?<a:off([^/]+)\/>[\s\S]*?<\/p:pic>/);
console.log('  logo  <a:off>     :', offMatch ? offMatch[1].trim() : '(not found)');
console.log('SLIDE 1 (title):');
console.log('  orange F58220 hits:', find(slide1Xml, 'F58220'));
console.log('  yellow FBC02D hits:', find(slide1Xml, 'FBC02D'));
console.log('SLIDE 2 (bullets):');
console.log('  orange F58220 hits:', find(slide2Xml, 'F58220'));
console.log('  yellow FBC02D hits:', find(slide2Xml, 'FBC02D'));
