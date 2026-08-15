// routes/supportChat.js
// Backs the floating "Study Buddy" chat widget on the student side.
// Plain conversational endpoint — no Firestore involved, just
// message in -> Gemini reply out, same as process-text/process-paper.

const express = require('express');
const { chatWithGemini } = require('../services/gemini');

const router = express.Router();

// Simple in-memory per-session cap so one runaway conversation can't burn
// through the whole Gemini quota and block every other student. Not meant
// to be bulletproof (it resets whenever the service restarts, and Render's
// free tier does that periodically anyway) — just a sane ceiling.
const MAX_MESSAGES_PER_SESSION = 20;
const sessionCounts = new Map(); // sessionId -> count

router.post('/', async (req, res) => {
  const { sessionId, message, history } = req.body || {};

  if (!sessionId || typeof sessionId !== 'string') {
    return res.status(400).json({ success: false, error: 'Missing sessionId.' });
  }
  if (!message || typeof message !== 'string' || !message.trim()) {
    return res.status(400).json({ success: false, error: 'Missing message.' });
  }

  const currentCount = sessionCounts.get(sessionId) || 0;
  if (currentCount >= MAX_MESSAGES_PER_SESSION) {
    return res.status(429).json({
      success: false,
      limitReached: true,
      error: `You've reached the ${MAX_MESSAGES_PER_SESSION}-message limit for this chat session. Please come back a bit later!`,
    });
  }

  try {
    const reply = await chatWithGemini(history, message.trim());
    sessionCounts.set(sessionId, currentCount + 1);
    res.json({
      success: true,
      reply,
      remaining: MAX_MESSAGES_PER_SESSION - (currentCount + 1),
    });
  } catch (err) {
    console.error('support-chat failed:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

module.exports = router;
