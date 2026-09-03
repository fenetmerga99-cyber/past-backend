// Turns raw exam text into structured, solved questions.
//
// Each question gets a "type": multiple_choice | true_false | fill_blank | short_answer
//   multiple_choice -> options: [4 strings], correctOptionIndex: 0-3
//   true_false      -> options: ["True","False"], correctOptionIndex: 0 or 1
//   fill_blank      -> correctAnswerText: "the missing word/phrase"
//   short_answer    -> correctAnswerText: "a model answer" (self-check only,
//                       free text is too varied to auto-grade reliably)
//
// Questions can also carry a "passage" — shared reading text (a comprehension
// passage, poem, dialogue, etc.) that one or more questions depend on. When
// several consecutive questions share the same passage text, past_paper.html
// renders that passage once above the group instead of repeating it per question.
//
// past_paper.html renders each type differently, so don't rename fields
// without updating that file too.

const MAX_INPUT_CHARS = 12000;

// worth retrying on these — usually just a short overload/rate-limit blip
const RETRYABLE_STATUS_CODES = new Set([429, 500, 502, 503, 504]);
const MAX_ATTEMPTS = 3;
const RETRY_DELAYS_MS = [1000, 3000];

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function callGeminiOnce(url, payload) {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });

  if (!response.ok) {
    const errBody = await response.text().catch(() => '');
    const err = new Error(`Gemini API error (${response.status}): ${errBody.slice(0, 300)}`);
    err.status = response.status;
    throw err;
  }

  return response.json();
}

async function callGeminiWithRetry(url, payload) {
  let lastErr;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      return await callGeminiOnce(url, payload);
    } catch (err) {
      lastErr = err;
      const isRetryable = RETRYABLE_STATUS_CODES.has(err.status);
      const isLastAttempt = attempt === MAX_ATTEMPTS;
      if (!isRetryable || isLastAttempt) {
        throw err;
      }
      console.warn(
        `Gemini call failed (attempt ${attempt}/${MAX_ATTEMPTS}, status ${err.status}) — retrying in ${RETRY_DELAYS_MS[attempt - 1]}ms...`
      );
      await sleep(RETRY_DELAYS_MS[attempt - 1]);
    }
  }
  throw lastErr;
}

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
    `Keep question wording faithful to the original.\\n\\n` +
    `SHARED PASSAGES: some questions depend on a shared reading passage, poem, dialogue, or short text printed ` +
    `once before a group of questions (e.g. "Read the passage below and answer questions 1-5"). When this occurs, ` +
    `copy that shared text verbatim into the "passage" field on EVERY question that depends on it — repeat the ` +
    `identical passage text on each one, do not summarize or shorten it. For questions that do NOT depend on a ` +
    `shared passage, leave "passage" as an empty string. Never invent a passage that wasn't in the source text.\\n\\n` +
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
                passage: { type: 'STRING' }, // shared reading passage, repeated verbatim on every question that depends on it; empty string if none
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

  const result = await callGeminiWithRetry(url, payload);
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
        passage: String(q.passage || '').trim(),
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

// Study Buddy chat — powers the floating widget. Separate from
// solveExamWithGemini above (that one returns structured JSON for a whole
// exam, this one is just back-and-forth conversation) but reuses the same
// retry logic.

const CHAT_SYSTEM_PROMPT =
  `You are "Study Buddy," a friendly study assistant built into an Ethiopian Grade 9-12 online ` +
  `learning platform called eLEARNING. You have two jobs:\n\n` +
  `1. Answer educational questions clearly, at a level appropriate for a grade 9-12 student — ` +
  `explain concepts (e.g. "what is force" in physics, math problems, biology, chemistry, history, ` +
  `English, etc.), give worked examples, and help the student actually understand rather than just ` +
  `handing over a final answer to copy. Keep explanations simple, clear, and encouraging.\n\n` +
  `2. Help students navigate and troubleshoot the platform itself. The platform has 4 resource ` +
  `categories per grade: Textbooks, Notes/Handouts, Past Papers (Final/Mid/Quiz exams), and — for ` +
  `Grade 12 only — National Exam past papers (pick subject, then year). If a student says an exam ` +
  `or paper isn't loading, explain that the automatic solving step can occasionally fail if the ` +
  `servers are briefly overloaded, and the fix is just to ask a teacher to re-upload it — it usually ` +
  `works on retry.\n\n` +
  `Keep every response short — a few sentences, or a short step-by-step list for worked problems — ` +
  `since you're shown in a small chat widget, not a full page. Since your users are school-age ` +
  `students, keep all responses school-appropriate and educational. If asked to write a full essay, ` +
  `assignment, or homework answer for a student to submit as their own work, gently decline and help ` +
  `them understand the topic well enough to write it themselves instead.`;

async function chatWithGemini(history, userMessage) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    throw new Error('GEMINI_API_KEY is not set on the server. Add it to your .env file.');
  }

  const model = process.env.GEMINI_CHAT_MODEL || process.env.GEMINI_MODEL || 'gemini-3.5-flash';
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;

  // Gemini wants alternating user/model turns
  const contents = (Array.isArray(history) ? history : [])
    .filter((m) => m && typeof m.content === 'string' && (m.role === 'user' || m.role === 'assistant'))
    .slice(-16)
    .map((m) => ({ role: m.role === 'assistant' ? 'model' : 'user', parts: [{ text: m.content }] }));

  contents.push({ role: 'user', parts: [{ text: userMessage }] });

  const payload = {
    systemInstruction: { parts: [{ text: CHAT_SYSTEM_PROMPT }] },
    contents,
    generationConfig: {
      temperature: 0.7,
      maxOutputTokens: 800,
    },
  };

  const result = await callGeminiWithRetry(url, payload);
  const reply = result?.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!reply) {
    throw new Error('Gemini returned no reply — the message may have been blocked by safety filters.');
  }
  return reply.trim();
}

module.exports = { solveExamWithGemini, chatWithGemini };
