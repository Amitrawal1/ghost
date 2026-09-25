// Reads a resume file into plain text. Used by the ⚙ "Load resume" button (main.js)
// and by the `ghost setup` terminal wizard, so it must not require('electron').
//
// PDF: unpdf (pure JS, works on macOS and Windows), with macOS PDFKit as a fallback.
// DOCX: unzipped with Node's zlib, no extra dependency.
// DOC/RTF/ODT/Pages: macOS textutil only.
const { execFile } = require('child_process');
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const RESUME_MAX_CHARS = 15000;
const EXTENSIONS = ['pdf', 'docx', 'doc', 'rtf', 'odt', 'pages', 'txt', 'md'];

function run(cmd, args) {
  return new Promise((resolve, reject) =>
    execFile(cmd, args, { maxBuffer: 20 * 1024 * 1024 }, (err, stdout) => (err ? reject(err) : resolve(stdout)))
  );
}

async function pdfText(file) {
  try {
    const { getDocumentProxy, extractText } = await import('unpdf');
    const pdf = await getDocumentProxy(new Uint8Array(fs.readFileSync(file)), { verbosity: 0 });
    const { text } = await extractText(pdf, { mergePages: false });
    return text.join('\n\n');
  } catch (err) {
    if (process.platform !== 'darwin') throw new Error(`Could not read this PDF (${err.message}).`);
    const script =
      "ObjC.import('PDFKit'); function run(argv) {" +
      ' const doc = $.PDFDocument.alloc.initWithURL($.NSURL.fileURLWithPath(argv[0]));' +
      " if (!doc || doc.isNil()) throw new Error('Cannot open PDF');" +
      " const s = doc.string; return s && !s.isNil() ? s.js : ''; }";
    return run('osascript', ['-l', 'JavaScript', '-e', script, file]);
  }
}

// Minimal zip reader: finds one entry through the central directory and inflates it.
function unzipEntry(buf, wanted) {
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65557); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error('Not a valid Word file.');
  let p = buf.readUInt32LE(eocd + 16);
  const count = buf.readUInt16LE(eocd + 10);
  for (let n = 0; n < count && buf.readUInt32LE(p) === 0x02014b50; n++) {
    const method = buf.readUInt16LE(p + 10);
    const size = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const local = buf.readUInt32LE(p + 42);
    const name = buf.toString('utf8', p + 46, p + 46 + nameLen);
    if (name === wanted) {
      const start = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
      const data = buf.subarray(start, start + size);
      return method === 8 ? zlib.inflateRawSync(data) : data;
    }
    p += 46 + nameLen + extraLen + commentLen;
  }
  throw new Error('Not a valid Word file.');
}

function docxText(file) {
  const xml = unzipEntry(fs.readFileSync(file), 'word/document.xml').toString('utf8');
  return xml
    .replace(/<w:tab\/>/g, '\t')
    .replace(/<w:br\/>|<\/w:p>/g, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

async function extractText(file) {
  const ext = path.extname(file).toLowerCase();
  if (ext === '.pdf') return pdfText(file);
  if (ext === '.docx') return docxText(file);
  if (['.doc', '.rtf', '.odt', '.html', '.htm', '.pages'].includes(ext)) {
    if (process.platform !== 'darwin') throw new Error('Save your resume as PDF or DOCX, then load that file.');
    return run('textutil', ['-convert', 'txt', '-stdout', file]);
  }
  return fs.readFileSync(file, 'utf8');
}

async function readResume(file) {
  const text = (await extractText(file))
    .replace(/[ \t]+/g, ' ')
    .replace(/\n\s*\n\s*\n+/g, '\n\n')
    .trim();
  if (!text) throw new Error('No text found in this file. If it is a scanned PDF, export it as text or Word first.');
  return { name: path.basename(file), text: text.slice(0, RESUME_MAX_CHARS), truncated: text.length > RESUME_MAX_CHARS };
}

module.exports = { readResume, EXTENSIONS };
