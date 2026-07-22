// routes/publish.js
// The new "instant response, AI works in the background" endpoint.
//
// Flow:
//   1. Teacher hits Push to Live Vault -> this route is called
//   2. We immediately write a "processing" placeholder to Firestore and
//      respond right away (teacher's UI unblocks here)
//   3. AFTER responding, we keep working: extract text (if PDF), call
//      Gemini, then update that same Firestore doc with the real
//      questions (or an error) — using the Admin SDK, so this finishes
//      even if the teacher's tab is long closed.
//
// Because students' past_paper.html reads the same doc, it needs to
// check the "status" field now — see the update made there.

const express = require('express');
const multer = require('multer');

const { getDb } = require('../services/firebaseAdmin');
const { solveExamWithGemini } = require('../services/gemini');
const { extractTextFromPdf } = require('../services/pdfParser');

const router = express.Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 15 * 1024 * 1024 } });

router.post('/', upload.single('paper'), async (req, res) => {
  const { title, grade, subject, examType, examYear, text } = req.body || {};
  const pdfFile = req.file;

  if (!subject || !examType || !examYear) {
    return res.status(400).json({ success: false, error: 'subject, examType, and examYear are required.' });
  }
  if (!text && !pdfFile) {
    return res.status(400).json({ success: false, error: 'Provide either "text" (docx, extracted client-side) or a "paper" PDF file.' });
  }

  const docId = `${subject}_${examType}_${examYear}`;
  let db;
  try {
    db = getDb();
  } catch (err) {
    // Firebase isn't configured — fail loudly and immediately, nothing to do in the background.
    return res.status(500).json({ success: false, error: err.message });
  }

  try {
    // Step 1: write the placeholder immediately and respond right away.
    await db.collection('past_papers').doc(docId).set({
      key: docId,
      title: title || `${subject} ${examType} Exam`,
      grade: grade || '',
      subject,
      type: examType,
      year: examYear,
      status: 'processing',
      questions: [],
      updatedAt: new Date(),
    });
  } catch (err) {
    console.error('Failed to write placeholder doc:', err);
    return res.status(500).json({ success: false, error: 'Could not reach Firestore: ' + err.message });
  }

  // Respond immediately — the teacher's UI unblocks here.
  res.status(202).json({ success: true, docId, status: 'processing' });

  // Step 2: keep working AFTER the response has already been sent.
  processInBackground({ db, docId, text, pdfFile, subject }).catch((err) => {
    // processInBackground already writes failures to Firestore; this is
    // just a final safety net so an unexpected crash doesn't go silent.
    console.error(`Background processing crashed for ${docId}:`, err);
  });
});

async function processInBackground({ db, docId, text, pdfFile, subject }) {
  try {
    const sourceText = text || (await extractTextFromPdf(pdfFile.buffer));
    const questions = await solveExamWithGemini(sourceText, subject);

    await db.collection('past_papers').doc(docId).update({
      status: 'ready',
      questions,
      updatedAt: new Date(),
    });
    console.log(`Published "${docId}" with ${questions.length} questions.`);
  } catch (err) {
    console.error(`Solving failed for ${docId}:`, err, err.cause ? `\nCaused by: ${err.cause}` : '');
    await db.collection('past_papers').doc(docId).update({
      status: 'failed',
      error: err.message,
      updatedAt: new Date(),
    }).catch(() => {});
  }
}

module.exports = router;
