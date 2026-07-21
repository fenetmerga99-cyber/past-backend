// server.js
// Local AI microservice — this is the "http://localhost:5000" backend
// upload.html already expects. It doesn't touch Firestore at all; the
// browser (upload.html) writes the solved questions straight to Firestore
// itself once this service hands them back. This service's only job is:
// raw exam text/PDF in -> solved questions out.

require('dotenv').config();
const express = require('express');
const cors = require('cors');
const multer = require('multer');

const { solveExamWithGemini } = require('./services/gemini');
const { extractTextFromPdf } = require('./services/pdfParser');
const publishRoute = require('./routes/publish');

const app = express();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 15 * 1024 * 1024 } });

app.use(cors()); // opened up for local dev use from a file:// page or any local static server
app.use(express.json({ limit: '2mb' }));

// Matches: fetch('http://localhost:5000/api/process-text', { body: { text, subject } })
app.post('/api/process-text', async (req, res) => {
  const { text, subject } = req.body || {};
  if (!text || typeof text !== 'string') {
    return res.status(400).json({ success: false, error: 'Missing "text" in request body.' });
  }

  try {
    const questions = await solveExamWithGemini(text, subject);
    res.json({ success: true, data: { questions } });
  } catch (err) {
    console.error('process-text failed:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// Matches: fetch('http://localhost:5000/api/process-paper', { body: FormData with field "paper" })
app.post('/api/process-paper', upload.single('paper'), async (req, res) => {
  if (!req.file) {
    return res.status(400).json({ success: false, error: 'No file uploaded (field name must be "paper").' });
  }

  try {
    const text = await extractTextFromPdf(req.file.buffer);
    const questions = await solveExamWithGemini(text, req.body?.subject);
    res.json({ success: true, data: { questions } });
  } catch (err) {
    console.error('process-paper failed:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

app.get('/api/health', (req, res) => res.json({ ok: true }));

app.use('/api/publish-exam', publishRoute);

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => {
  console.log(`AI solver backend running at http://localhost:${PORT}`);
  if (!process.env.GEMINI_API_KEY) {
    console.warn('⚠️  GEMINI_API_KEY is not set — copy .env.example to .env and add your key.');
  }
});
