// services/gemini.js
// Turns raw exam text into structured, solved questions — and now
// PRESERVES each question's real format instead of forcing everything
// into multiple-choice.
//
// Every question gets a "type": one of
//   "multiple_choice" | "true_false" | "fill_blank" | "short_answer"
//
// Shape per type (all share questionText + explanation):
//   multiple_choice -> options: [4 strings], correctOptionIndex: 0-3
//   true_false      -> options: ["True","False"], correctOptionIndex: 0 or 1
//   fill_blank      -> correctAnswerText: "the missing word/phrase"
//   short_answer    -> correctAnswerText: "a model answer" (self-checked
//                       by the student, not auto-graded — free text
//                       answers are too varied to grade reliably by
//                       exact string match)
//
// past_paper.html renders each type differently and grades multiple_choice/
// true_false/fill_blank automatically, but shows short_answer as
// self-check only. Don't rename these fields without updating that file.

const MAX_INPUT_CHARS = 12000;

function buildPrompt(subject) {
  return (
    `You are an expert ${subject || ''} teacher. You will be given the raw text of a past exam paper, ` +
    `possibly extracted from a Word document or PDF and containing formatting noise, headers, or instructions ` +
    `mixed in with the real questions — ignore anything that isn't an actual exam question.\n\n` +
    `For every genuine question you find, KEEP ITS ORIGINAL FORMAT — do not force every question into ` +
    `multiple-choice. Classify each one into exactly one "type":\n` +
    `- "multiple_choice": the source already gives answer choices (A/B/C/D or similar). Provide exactly 4 options ` +
    `(reconstruct/complete them if the source is messy, but keep them plausible and mutually exclusive), and the ` +
    `zero-based index of the correct one.\n` +
    `- "true_false": the source asks the student to judge a statement as true or false. Set options to exactly ` +
    `["True", "False"] and give the correct zero-based index (0 for True, 1 for False).\n` +
    `- "fill_blank": the source has a sentence with a missing word/phrase (e.g. a blank line or "_____"). Keep the ` +
    `blank visible in questionText (use "_____" if the original marker is unclear), and give the missing text in ` +
    `correctAnswerText.\n` +
    `- "short_answer": the source asks for a brief written answer that isn't a single fixed word (e.g. "explain why...", ` +
    `"describe..."). Give a concise model answer in correctAnswerText — this type is shown to students as a ` +
    `self-check, not auto-graded, since free-text answers vary too much to grade by exact match.\n\n` +
    `Always include a short, clear, step-by-step explanation a student could learn from, regardless of type. ` +
    `Keep question wording faithful to the original. Return ONLY valid JSON, no markdown fences, no commentary.`
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
          { text: `Exam text:\n"""\n${text.slice(0, MAX_INPUT_CHARS)}\n"""\n\nExtract and solve every question, preserving its original type.` },
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
                type: { type: 'STRING' }, // multiple_choice | true_false | fill_blank | short_answer
                questionText: { type: 'STRING' },
                options: { type: 'ARRAY', items: { type: 'STRING' } }, // multiple_choice / true_false only
                correctOptionIndex: { type: 'INTEGER' }, // multiple_choice / true_false only
                correctAnswerText: { type: 'STRING' }, // fill_blank / short_answer only
                explanation: { type: 'STRING' },
              },
              required: ['type', 'questionText', 'explanation'],
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

  const KNOWN_TYPES = ['multiple_choice', 'true_false', 'fill_blank', 'short_answer'];

  const questions = Array.isArray(parsed.questions) ? parsed.questions : [];
  const cleaned = questions
    .filter((q) => q && typeof q.questionText === 'string')
    .map((q) => {
      let type = KNOWN_TYPES.includes(q.type) ? q.type : 'multiple_choice';
      const base = {
        type,
        questionText: String(q.questionText).trim(),
        explanation: String(q.explanation || '').trim() || 'No explanation provided.',
      };

      if (type === 'multiple_choice' || type === 'true_false') {
        let options;
        if (type === 'true_false') {
          options = ['True', 'False'];
        } else {
          options = Array.isArray(q.options) ? q.options.slice(0, 4).map((o) => String(o)) : [];
          while (options.length < 4) options.push('N/A');
        }
        let correctOptionIndex = Number.isInteger(q.correctOptionIndex) ? q.correctOptionIndex : 0;
        const maxIdx = options.length - 1;
        if (correctOptionIndex < 0 || correctOptionIndex > maxIdx) correctOptionIndex = 0;
        return { ...base, options, correctOptionIndex };
      }

      // fill_blank / short_answer
      const correctAnswerText = String(q.correctAnswerText || '').trim();
      if (!correctAnswerText) {
        // No usable expected answer — safest fallback is to treat it as
        // an ungraded short answer rather than drop the question entirely.
        return { ...base, type: 'short_answer', correctAnswerText: '(no model answer provided)' };
      }
      return { ...base, correctAnswerText };
    });

  if (cleaned.length === 0) {
    throw new Error('Gemini did not identify any solvable questions in this document.');
  }

  return cleaned;
}

module.exports = { solveExamWithGemini };
