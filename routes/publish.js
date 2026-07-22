// routes/publish.js
// The "instant response, AI works in the background" endpoint.
//
// Flow:
//   1. Teacher hits Push to Live Vault -> this route is called
//   2. We immediately create a brand NEW Firestore doc (auto-generated
//      ID — never a fixed key) with status "processing" and respond
//      right away (teacher's UI unblocks here)
//   3. AFTER responding, we keep working: extract text (if PDF), call
//      Gemini, then update that same new doc with the real questions
//      (or an error) — using the Admin SDK, so this finishes even if the
//      teacher's tab is long closed.
//
// IMPORTANT: this used to compute a deterministic key
// (`${subject}_${type}_${year}`) and .set() it, which meant a second
// upload for the same subject/type/year silently overwrote the first
// one. Now every upload gets its own document, so multiple quizzes,
// or a 1st + 2nd semester exam, can all coexist. Students' past_paper.html
// now QUERIES for matching documents (subject + type + optional semester
// + year) instead of fetching one fixed key, and shows a picker if more
// than one match comes back.

const express = require('express');
const multer = require('multer');

const { getDb } = require('../services/firebaseAdmin');
const { solveExamWithGemini } = require('../services/gemini');
const { extractTextFromPdf } = require('../services/pdfParser');

const router = express.Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 15 * 1024 * 1024 } });

router.post('/', upload.single('paper'), async (req, res) => {
  const { title, grade, subject, examType, examYear, semester, text } = req.body || {};
  const pdfFile = req.file;

  if (!subject || !examType || !examYear) {
    return res.status(400).json({ success: false, error: 'subject, examType, and examYear are required.' });
  }
  if ((examType === 'Final' || examType === 'Mid') && !semester) {
    return res.status(400).json({ success: false, error: 'semester ("1st" or "2nd") is required for Final/Mid exams.' });
  }
  if (!text && !pdfFile) {
    return res.status(400).json({ success: false, error: 'Provide either "text" (docx, extracted client-side) or a "paper" PDF file.' });
  }

  let db;
  try {
    db = getDb();
  } catch (err) {
    // Firebase isn't configured — fail loudly and immediately, nothing to do in the background.
    return res.status(500).json({ success: false, error: err.message });
  }

  let docRef;
  try {
    // Auto-generated ID — this is what makes repeat uploads ADD instead
    // of overwrite. .doc() with no argument reserves a fresh random ID.
    docRef = db.collection('past_papers').doc();
    await docRef.set({
      title: title || `${subject} ${examType} Exam`,
      grade: grade || '',
      subject,
      type: examType,
      semester: semester || null, // only meaningful for Final/Mid
      year: examYear,
      status: 'processing',
      questions: [],
      createdAt: new Date(),
      updatedAt: new Date(),
    });
  } catch (err) {
    console.error('Failed to write placeholder doc:', err);
    return res.status(500).json({ success: false, error: 'Could not reach Firestore: ' + err.message });
  }

  // Respond immediately — the teacher's UI unblocks here.
  res.status(202).json({ success: true, docId: docRef.id, status: 'processing' });

  // Keep working AFTER the response has already been sent.
  processInBackground({ db, docId: docRef.id, text, pdfFile, subject }).catch((err) => {
    // processInBackground already writes failures to Firestore; this is
    // just a final safety net so an unexpected crash doesn't go silent.
    console.error(`Background processing crashed for ${docRef.id}:`, err);
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
