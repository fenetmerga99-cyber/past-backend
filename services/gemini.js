// services/gemini.js
// Turns raw exam text into structured, solved multiple-choice questions.
// Field names (questionText/options/correctOptionIndex/explanation) match
// what past_paper.html expects when it later reads these back out of
// Firestore, so don't rename them without updating that file too.

const MAX_INPUT_CHARS = 12000;

function buildPrompt(subject) {
  return (
    `You are an expert ${subject || ''} teacher. You will be given the raw text of a past exam paper, ` +
    `possibly extracted from a Word document or PDF and containing formatting noise, headers, or instructions ` +
    `mixed in with the real questions — ignore anything that isn't an actual exam question.\n\n` +
    `For every genuine question you find:\n` +
    `1. Keep the wording faithful to the original.\n` +
    `2. Provide exactly 4 answer options (reconstruct/complete them if the source is messy, but keep them plausible and mutually exclusive).\n` +
    `3. Work out the correct answer yourself and give its zero-based index (0-3).\n` +
    `4. Write a short, clear, step-by-step explanation a student could learn from.\n\n` +
    `If a source question isn't multiple-choice, convert it into a fair 4-option version instead of skipping it. ` +
    `Return ONLY valid JSON, no markdown fences, no commentary.`
  );
}

async function solveExamWithGemini(text, subject) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    throw new Error('GEMINI_API_KEY is not set on the server. Add it to your .env file.');
  }

  const model = process.env.GEMINI_MODEL || 'gemini-3.5-flash';
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;

  const payload = {
    systemInstruction: { parts: [{ text: buildPrompt(subject) }] },
    contents: [
      {
        parts: [
          { text: `Exam text:\n"""\n${text.slice(0, MAX_INPUT_CHARS)}\n"""\n\nExtract and solve every question.` },
        ],
      },
    ],
    generationConfig: {
      responseMimeType: 'application/json',
      responseSchema: {
        type: 'OBJECT',
        properties: {
          questions: {
            type: 'ARRAY',
            items: {
              type: 'OBJECT',
              properties: {
                questionText: { type: 'STRING' },
                options: { type: 'ARRAY', items: { type: 'STRING' } },
                correctOptionIndex: { type: 'INTEGER' },
                explanation: { type: 'STRING' },
              },
              required: ['questionText', 'options', 'correctOptionIndex', 'explanation'],
            },
          },
        },
        required: ['questions'],
      },
    },
  };

  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });

  if (!response.ok) {
    const errBody = await response.text().catch(() => '');
    throw new Error(`Gemini API error (${response.status}): ${errBody.slice(0, 300)}`);
  }

  const result = await response.json();
  const candidateText = result?.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!candidateText) {
    throw new Error('Gemini returned no content — the text may have been rejected by safety filters.');
  }

  let parsed;
  try {
    parsed = JSON.parse(candidateText);
  } catch (e) {
    throw new Error('Gemini did not return valid JSON.');
  }

  const questions = Array.isArray(parsed.questions) ? parsed.questions : [];
  const cleaned = questions
    .filter((q) => q && typeof q.questionText === 'string' && Array.isArray(q.options))
    .map((q) => {
      const options = q.options.slice(0, 4).map((o) => String(o));
      while (options.length < 4) options.push('N/A');
      let correctOptionIndex = Number.isInteger(q.correctOptionIndex) ? q.correctOptionIndex : 0;
      if (correctOptionIndex < 0 || correctOptionIndex > 3) correctOptionIndex = 0;
      return {
        questionText: String(q.questionText).trim(),
        options,
        correctOptionIndex,
        explanation: String(q.explanation || '').trim() || 'No explanation provided.',
      };
    });

  if (cleaned.length === 0) {
    throw new Error('Gemini did not identify any solvable questions in this document.');
  }

  return cleaned;
}

module.exports = { solveExamWithGemini };
