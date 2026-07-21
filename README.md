# AI Solver Backend (for `upload.html`)

This is the missing piece `upload.html` was already trying to call at
`http://localhost:5000`. It doesn't touch your Firebase database at all —
`upload.html` still writes the solved questions straight to Firestore
itself, exactly like it already does. This service's only job is:

**raw exam text (or PDF) in → solved questions (JSON) out.**

## Setup

```bash
cd ai-solver-backend
npm install
cp .env.example .env
```

Edit `.env` and add your real Gemini key:
```
GEMINI_API_KEY=your_real_key_here
GEMINI_MODEL=gemini-3.5-flash
PORT=5000
```

Run it:
```bash
npm start
```

Leave this running in its own terminal **whenever a teacher needs to
upload a past paper**. Your actual site (`upload.html`, `select_exam.html`,
`past_paper.html`, etc.) can be opened however you already open them —
double-clicking the file, VS Code Live Server, or a static host — this
backend just needs to be reachable at `localhost:5000` from that browser.

## What it does

- `POST /api/process-text` — `upload.html` sends `{ text, subject }` here
  after extracting a `.docx`'s text client-side with mammoth.js. Returns
  `{ success: true, data: { questions: [...] } }`.
- `POST /api/process-paper` — `upload.html` sends the raw `.pdf` file here
  (multipart, field name `paper`). The server extracts the text itself
  (`pdf-parse`) and solves it the same way.

Both return questions shaped as:
```json
{ "questionText": "...", "options": ["...", "...", "...", "..."], "correctOptionIndex": 0, "explanation": "..." }
```

This exact shape is what gets saved into your `past_papers` Firestore
collection, and it's what `past_paper.html` now expects when reading it
back — don't rename these fields in one place without updating the other.

## Once this is running, the full pipeline is:

1. Teacher logs into `upload.html`, picks **Past Exam Paper**, uploads a
   `.docx`/`.pdf`
2. Browser extracts text (docx) or sends the raw file (pdf) to this backend
3. This backend calls Gemini, returns solved questions
4. `upload.html` writes them to `Firestore: past_papers/{subject}_{type}_{year}`
5. A student on `select_exam.html` → picks type/year → lands on
   `past_paper.html?subject=...&type=...&year=...`, which now actually
   reads that same Firestore doc and lets them take the quiz

## Background processing (no more waiting on the upload screen)

As of this update, uploading a past paper no longer blocks the teacher on
a loading screen. The flow is now:

1. Teacher clicks **Push to Live Vault**
2. This backend immediately writes a placeholder to Firestore
   (`status: "processing"`) and responds right away — the teacher can
   close the tab immediately
3. In the background, this backend extracts the text, calls Gemini, and
   updates that same Firestore doc with the real questions
   (`status: "ready"`), or `status: "failed"` with an error message if
   something went wrong
4. Students on `past_paper.html` check that `status` field: they see a
   friendly "still being prepared" message if it's not ready yet, instead
   of nothing or an error

This means the backend now needs **write access to your Firestore**, not
just read access to Gemini. That requires a Firebase **service account**
key (different from the public `apiKey` already in your HTML files).

### Getting your service account key

1. Go to the [Firebase console](https://console.firebase.google.com/) →
   your project (`school-portal-7b692`) → ⚙️ **Project settings** →
   **Service accounts** tab
2. Click **Generate new private key** — this downloads a `.json` file
3. **Never commit this file to git or put it in any HTML file** — it
   grants full read/write access to your entire database
4. Base64-encode its contents so it can safely live in one env var:

   **Mac/Linux:**
   ```bash
   base64 -i path/to/your-key.json | tr -d '\n' > key.base64.txt
   ```
   **Windows (PowerShell):**
   ```powershell
   [Convert]::ToBase64String([IO.File]::ReadAllBytes("path\to\your-key.json")) | Out-File key.base64.txt
   ```
5. Copy the resulting single long string into:
   - Local `.env`: `FIREBASE_SERVICE_ACCOUNT_BASE64=<paste it>`
   - Render dashboard → Environment tab → same variable name

### After adding this locally

```bash
npm install     # picks up the new firebase-admin dependency
npm start
```

### After adding this on Render

Add `FIREBASE_SERVICE_ACCOUNT_BASE64` in the Environment tab (alongside
your existing `GEMINI_API_KEY` and `GEMINI_MODEL`), then trigger a
redeploy (Render usually does this automatically when you push a commit
that changes `package.json`, since this update added the `firebase-admin`
dependency).

## Note on the Firebase API key

The `apiKey` in your HTML files (`AIzaSyB5...`) is a **Firebase client
key**, not a secret — it's meant to be public in browser code, that's how
Firebase is designed (your actual protection is Firestore Security Rules,
which you should double check are locked down appropriately for writes).
The **Gemini key** in this backend's `.env`, on the other hand, *is*
secret — never put that one in any `.html` file.

## Deploying to Render (so it doesn't depend on your laptop being on)

Once deployed, this stops being a `localhost:5000` thing and becomes a
real always-on URL like `https://ai-solver-backend-xxxx.onrender.com`.

**1. Put this folder in a GitHub repo**

Only `ai-solver-backend/` needs to go in the repo — it can be its own
tiny repo, separate from your site's HTML files. Make sure `.env` is
NOT committed (it's already in `.gitignore`) — your Gemini key stays
private.

```bash
cd ai-solver-backend
git init
git add .
git commit -m "AI solver backend"
# create a repo on GitHub, then:
git remote add origin <your-repo-url>
git push -u origin main
```

**2. Create the service on Render**

1. Go to https://render.com, sign in (GitHub login is easiest)
2. **New** → **Web Service** → connect the repo you just pushed
3. Render should auto-detect Node. If it asks:
   - **Build Command:** `npm install`
   - **Start Command:** `npm start`
   - (There's also a `render.yaml` in this folder — if Render offers to
     use it as a "Blueprint", that fills in these settings for you.)

**3. Add your environment variables**

In the service's **Environment** tab on Render, add:
- `GEMINI_API_KEY` → your real key (this is where it belongs now — not
  in a `.env` file, not in any HTML file)
- `GEMINI_MODEL` → `gemini-3.5-flash`

Don't set `PORT` — Render sets it automatically, and `server.js` already
reads `process.env.PORT`.

**4. Deploy**

Render builds and deploys automatically. Once it's live, you'll get a
URL like:
```
https://ai-solver-backend-xxxx.onrender.com
```

**5. Point `upload.html` at it**

Open `upload.html`, find this line near the top of the `<script>` block:
```js
const AI_BACKEND_URL = "http://localhost:5000";
```
Change it to your Render URL (no trailing slash):
```js
const AI_BACKEND_URL = "https://ai-solver-backend-xxxx.onrender.com";
```
Save, re-open `upload.html`, and try uploading a past paper. You can
close your laptop entirely now — the backend keeps running on Render.

### Two things to expect on Render's free tier

- **Cold starts:** a free-tier service "sleeps" after 15 minutes of no
  traffic. The next upload after a quiet period will take an extra
  10–30 seconds while it wakes up — that's normal, not broken. Later
  requests are fast again.
- **No persistent state needed here** — this backend doesn't store
  anything (no database, no files), it just processes one request and
  responds, so the free tier's ephemeral disk isn't a concern for it
  (unlike an app with its own database, which would need a persistent
  disk or a hosted DB).

