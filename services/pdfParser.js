// services/pdfParser.js
// upload.html sends raw PDF bytes to /api/process-paper (docx is already
// turned into text in the browser via mammoth, but PDFs aren't). This
// extracts the plain text server-side so Gemini can read it.

const pdfParse = require('pdf-parse');

async function extractTextFromPdf(buffer) {
  const result = await pdfParse(buffer);
  const text = (result.text || '').trim();
  if (!text) {
    throw new Error('No readable text was found in that PDF (it may be a scanned image).');
  }
  return text;
}

module.exports = { extractTextFromPdf };
