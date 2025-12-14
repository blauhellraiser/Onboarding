import "dotenv/config";
import express from "express";
import multer from "multer";
import fs from "fs";
import path from "path";
import OpenAI from "openai";
import pdfParse from "pdf-parse";
import mammoth from "mammoth";

const app = express();
app.use(express.json({ limit: "10mb" }));

// CORS (ok für einfache Mobile-Nutzung)
app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, x-api-token");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
});

const upload = multer({ dest: "uploads/" });
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

let VECTOR_STORE_ID = process.env.VECTOR_STORE_ID || null;
const API_TOKEN = process.env.API_TOKEN || "";

// --- Minimaler Zugriffsschutz für /api/* (wichtig sobald öffentlich) ---
app.use("/api", (req, res, next) => {
  if (!API_TOKEN) return next(); // nicht empfohlen
  const token = req.headers["x-api-token"];
  if (token !== API_TOKEN) return res.status(401).json({ error: "Unauthorized" });
  next();
});

// --- Helpers ---
function safeUnlink(p) {
  fs.unlink(p, () => {});
}

async function ensureVectorStore() {
  if (VECTOR_STORE_ID) return VECTOR_STORE_ID;

  const vs = await openai.vectorStores.create({
    name: "employee_onboarding_kb"
  });

  VECTOR_STORE_ID = vs.id;
  console.log("✅ Created vector store:", VECTOR_STORE_ID);
  console.log("👉 Tipp: Setze VECTOR_STORE_ID als Render Env Var, damit der Index erhalten bleibt.");
  return VECTOR_STORE_ID;
}

function normalizeText(s) {
  return (s || "")
    .replace(/\r\n/g, "\n")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/**
 * Chunking nach Zeichen (nicht Tokens). 8k chars ~ grob ein paar tausend Tokens.
 * Overlap hilft, wenn eine wichtige Info genau an einer Chunk-Grenze liegt.
 */
function chunkTextByChars(text, chunkSize = 8000, overlap = 800) {
  const chunks = [];
  const t = normalizeText(text);
  if (!t) return chunks;

  let i = 0;
  while (i < t.length) {
    const end = Math.min(i + chunkSize, t.length);
    const chunk = t.slice(i, end).trim();
    if (chunk) chunks.push(chunk);
    if (end >= t.length) break;
    i = Math.max(0, end - overlap);
  }
  return chunks;
}

async function extractTextFromFile(localPath, originalName) {
  const ext = path.extname(originalName).toLowerCase();

  if (ext === ".pdf") {
    const buf = fs.readFileSync(localPath);
    const parsed = await pdfParse(buf);
    return normalizeText(parsed.text);
  }

  if (ext === ".docx") {
    const buf = fs.readFileSync(localPath);
    const result = await mammoth.extractRawText({ buffer: buf });
    return normalizeText(result.value);
  }

  if ([".txt", ".md", ".csv", ".html", ".json"].includes(ext)) {
    return normalizeText(fs.readFileSync(localPath, "utf8"));
  }

  // .doc (alt) o. ä. -> kein Extracting
  return null;
}

function makeSafeBaseName(originalName) {
  // Dateinamen „normalisieren“, damit keine komischen Zeichen in tmp-Files landen
  return originalName
    .normalize("NFKD")
    .replace(/[^\w.\- ()äöüÄÖÜß]/g, "_");
}

async function uploadChunkAsTextFile({ vectorStoreId, originalName, chunkIndex, chunkText }) {
  const tmpDir = "uploads";
  if (!fs.existsSync(tmpDir)) fs.mkdirSync(tmpDir, { recursive: true });

  const safeBase = makeSafeBaseName(originalName);
  const tmpName = `${safeBase}.part-${String(chunkIndex).padStart(3, "0")}.txt`;
  const tmpPath = path.join(tmpDir, tmpName);

  fs.writeFileSync(tmpPath, chunkText, "utf8");

  const uploaded = await openai.files.create({
    file: fs.createReadStream(tmpPath),
    purpose: "assistants"
  });

  await openai.vectorStores.files.create(vectorStoreId, { file_id: uploaded.id });

  safeUnlink(tmpPath);
  return { file_id: uploaded.id, part_name: tmpName };
}

// --- Routes ---
app.get("/", (req, res) => {
  res.type("text").send(
    "Onboarding Bot running.\n\n" +
      "GET  /chat\n" +
      "GET  /health\n" +
      "POST /api/upload  (multipart/form-data, field 'files')\n" +
      "POST /api/chat    {\"message\":\"...\"}\n"
  );
});

app.get("/health", (req, res) => res.json({ ok: true }));

// Mobile Web UI (Upload + Chat)
app.get("/chat", (req, res) => {
  const token = (process.env.API_TOKEN || "").replaceAll('"', '\\"');

  res.type("html").send(`<!doctype html>
<html lang="de">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Onboarding Bot</title>
  <style>
    body{font-family:system-ui,-apple-system,Segoe UI,Roboto,Arial,sans-serif;margin:0;background:#f6f7f9}
    header{position:sticky;top:0;background:#fff;padding:12px 14px;border-bottom:1px solid #e6e6e6}
    header h1{margin:0;font-size:16px}
    main{max-width:820px;margin:0 auto;padding:14px}
    .card{background:#fff;border:1px solid #e6e6e6;border-radius:14px;padding:12px;margin:10px 0}
    .u{white-space:pre-wrap}
    .row{display:flex;gap:10px;position:sticky;bottom:0;background:#f6f7f9;padding:12px 14px;border-top:1px solid #e6e6e6}
    input{flex:1;padding:12px;border-radius:12px;border:1px solid #d9d9d9;font-size:16px}
    button{padding:12px 14px;border-radius:12px;border:1px solid #d9d9d9;background:#fff;font-size:16px}
    button:disabled{opacity:.5}
    details{background:#fff;border:1px solid #e6e6e6;border-radius:14px;padding:12px;margin:10px 0}
    .small{opacity:.7;font-size:12px;margin-top:6px}
  </style>
</head>
<body>
  <header>
    <h1>Onboarding Bot</h1>
    <div class="small">iPhone: Teilen → „Zum Home-Bildschirm“ · Android: „Zum Startbildschirm“</div>
  </header>

  <main>
    <details open>
      <summary><b>Dokumente hochladen</b></summary>
      <p class="small">
        PDFs/DOCX werden serverseitig in Text extrahiert und automatisch in Chunks zerlegt (bessere Suche, weniger Rate-Limits).
      </p>
      <input id="files" type="file" multiple />
      <button id="uploadBtn">Upload</button>
      <div id="uploadStatus" class="small"></div>
    </details>

    <div id="log"></div>
  </main>

  <div class="row">
    <input id="msg" placeholder="Frage stellen…" autocomplete="off" />
    <button id="send">Senden</button>
  </div>

<script>
  const API_TOKEN = "${token}";
  const log = document.getElementById('log');
  const msg = document.getElementById('msg');
  const send = document.getElementById('send');

  const files = document.getElementById('files');
  const uploadBtn = document.getElementById('uploadBtn');
  const uploadStatus = document.getElementById('uploadStatus');

  function addCard(title, text){
    const div = document.createElement('div');
    div.className = 'card';
    div.innerHTML = '<b>' + title + '</b><div class="u" style="margin-top:6px"></div>';
    div.querySelector('.u').textContent = text;
    log.appendChild(div);
    window.scrollTo({ top: document.body.scrollHeight, behavior: 'smooth' });
  }

  async function doUpload(){
    if(!files.files.length) return;
    uploadStatus.textContent = "Upload läuft…";

    const fd = new FormData();
    for(const f of files.files) fd.append("files", f);

    try{
      const r = await fetch("/api/upload", {
        method: "POST",
        headers: { "x-api-token": API_TOKEN },
        body: fd
      });
      const data = await r.json();
      if(!r.ok) throw new Error(data.error || "Upload failed");
      uploadStatus.textContent = "✅ Upload OK. Vector Store: " + data.vector_store_id +
        " · Dateien: " + (data.uploaded?.length || 0);
      addCard("System", "Upload abgeschlossen. Du kannst jetzt Fragen stellen.");
    }catch(e){
      uploadStatus.textContent = "❌ " + e.message;
      addCard("Fehler", e.message);
    }
  }

  async function ask(){
    const text = msg.value.trim();
    if(!text) return;
    msg.value = '';
    addCard('Du', text);
    send.disabled = true;

    try{
      const r = await fetch('/api/chat', {
        method:'POST',
        headers:{
          'Content-Type':'application/json',
          'x-api-token': API_TOKEN
        },
        body: JSON.stringify({ message: text })
      });
      const data = await r.json();
      if(!r.ok) throw new Error(data.error || 'Request failed');
      addCard('Bot', data.answer || '(keine Antwort)');
    }catch(e){
      addCard('Fehler', e.message);
    }finally{
      send.disabled = false;
      msg.focus();
    }
  }

  uploadBtn.addEventListener("click", doUpload);
  send.addEventListener('click', ask);
  msg.addEventListener('keydown', (e)=>{ if(e.key==='Enter') ask(); });

  addCard('Bot', 'Hi! Lade Dokumente hoch oder stell direkt eine Frage.');
  msg.focus();
</script>
</body>
</html>`);
});

// Upload docs -> Extract -> Chunk -> Upload .txt parts -> Vector Store
app.post("/api/upload", upload.array("files", 10), async (req, res) => {
  const files = req.files || [];
  if (!files.length) return res.status(400).json({ error: "No files uploaded. Use field name: files" });

  // Tuning (optional als Env Vars setzen)
  const CHUNK_SIZE = Number(process.env.CHUNK_SIZE || 8000);        // chars
  const CHUNK_OVERLAP = Number(process.env.CHUNK_OVERLAP || 800);   // chars
  const PAUSE_MS = Number(process.env.UPLOAD_PAUSE_MS || 600);      // ms, gegen Rate-Limits

  try {
    const vectorStoreId = await ensureVectorStore();
    const results = [];

    for (const f of files) {
      try {
        const extracted = await extractTextFromFile(f.path, f.originalname);

        if (extracted && extracted.length > 0) {
          const chunks = chunkTextByChars(extracted, CHUNK_SIZE, CHUNK_OVERLAP);

          const partUploads = [];
          for (let i = 0; i < Math.max(1, chunks.length); i++) {
            const chunkText = chunks[i] || extracted; // falls chunks leer, dann ganzes Dokument
            const out = await uploadChunkAsTextFile({
              vectorStoreId,
              originalName: f.originalname,
              chunkIndex: i + 1,
              chunkText
            });
            partUploads.push(out);

            if (PAUSE_MS > 0) await new Promise(r => setTimeout(r, PAUSE_MS));
          }

          results.push({
            original_name: f.originalname,
            mode: "chunked",
            chunks: partUploads.length,
            parts: partUploads // {file_id, part_name}
          });
        } else {
          // Fallback: Originaldatei hochladen, wenn Extract nicht geht
          const uploaded = await openai.files.create({
            file: fs.createReadStream(f.path),
            purpose: "assistants"
          });

          await openai.vectorStores.files.create(vectorStoreId, { file_id: uploaded.id });

          results.push({
            original_name: f.originalname,
            mode: "original",
            chunks: 0,
            parts: [{ file_id: uploaded.id, part_name: f.originalname }]
          });
        }
      } finally {
        safeUnlink(f.path);
      }
    }

    res.json({ vector_store_id: vectorStoreId, uploaded: results });
  } catch (err) {
    for (const f of files) safeUnlink(f.path);
    res.status(500).json({ error: err.message });
  }
});

// Chat -> Responses API + file_search
app.post("/api/chat", async (req, res) => {
  const { message } = req.body || {};
  if (!message) return res.status(400).json({ error: "Missing body.message" });

  try {
    const vectorStoreId = await ensureVectorStore();

    const response = await openai.responses.create({
      model: "gpt-4.1-mini",
      input: [
        {
          role: "system",
          content:
            "Du bist ein Mitarbeiter-Onboarding-Assistant. " +
            "Antworte NUR auf Basis der bereitgestellten Onboarding-Dokumente. " +
            "Wenn du nichts Relevantes findest, sag klar: 'Dazu finde ich nichts in den Onboarding-Unterlagen.' " +
            "Gib kurze, umsetzbare Schritte. Keine Spekulation."
        },
        { role: "user", content: message }
      ],
      tools: [{ type: "file_search", vector_store_ids: [vectorStoreId] }]
    });

    res.json({
      answer: response.output_text,
      response_id: response.id,
      vector_store_id: vectorStoreId
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Render: Port muss aus ENV kommen
const port = process.env.PORT || 3000;
app.listen(port, "0.0.0.0", () => console.log("✅ Listening on", port));
