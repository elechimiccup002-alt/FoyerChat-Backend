/* ————————————————————————————————————————————————————————————
   FOYER BACKEND — server.js
   Stack: Express + Socket.io + SQLite (better-sqlite3) + JWT
   Email di verifica: Resend (https://resend.com — 100 mail/giorno gratis)

   Avvio locale:
     npm install
     RESEND_API_KEY=re_xxx JWT_SECRET=una-frase-lunga-casuale npm start

   Se RESEND_API_KEY non è impostata, il codice di verifica viene
   stampato nel log del server (modalità sviluppo/test).
——————————————————————————————————————————————————————————— */

import express from "express";
import { createServer } from "http";
import { Server } from "socket.io";
import Database from "better-sqlite3";
import jwt from "jsonwebtoken";
import bcrypt from "bcryptjs";
import multer from "multer";
import cors from "cors";
import crypto from "crypto";
import path from "path";
import fs from "fs";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 3001;
const JWT_SECRET = process.env.JWT_SECRET || "cambiami-in-produzione";
const FRONTEND_URL = process.env.FRONTEND_URL || "*";
const RESEND_API_KEY = process.env.RESEND_API_KEY || null;

/* ———— email (Resend) ———— */
let resend = null;
if (RESEND_API_KEY) {
  const { Resend } = await import("resend");
  resend = new Resend(RESEND_API_KEY);
}

async function sendVerificationEmail(to, code) {
  if (!resend) {
    console.log(`[DEV] Codice di verifica per ${to}: ${code}`);
    return;
  }
  await resend.emails.send({
    from: "Foyer <onboarding@resend.dev>", // sostituisci col tuo dominio verificato
    to,
    subject: `${code} è il tuo codice Foyer`,
    html: `<div style="font-family:sans-serif;max-width:420px;margin:0 auto">
      <h2>Benvenuto su Foyer 👋</h2>
      <p>Il tuo codice di verifica è:</p>
      <p style="font-size:32px;letter-spacing:8px;font-weight:bold">${code}</p>
      <p style="color:#888">Scade tra 15 minuti. Se non hai richiesto tu questo codice, ignora questa mail.</p>
    </div>`,
  });
}

/* ———— database ———— */
const db = new Database(path.join(__dirname, "foyer.db"));
db.pragma("journal_mode = WAL");

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  email TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  name TEXT NOT NULL,
  age INTEGER NOT NULL,
  handle TEXT UNIQUE NOT NULL,
  city TEXT DEFAULT '',
  bio TEXT DEFAULT '',
  vibe TEXT DEFAULT '',
  avatar TEXT DEFAULT '',
  verified INTEGER DEFAULT 0,
  streak INTEGER DEFAULT 1,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS verification_codes (
  email TEXT PRIMARY KEY,
  code TEXT NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS photos (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  filename TEXT NOT NULL,
  position INTEGER DEFAULT 0,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS rooms (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  topic TEXT DEFAULT '',
  access TEXT NOT NULL DEFAULT 'open', -- open | view | members
  hue TEXT DEFAULT '#6C4DFF'
);
CREATE TABLE IF NOT EXISTS messages (
  id TEXT PRIMARY KEY,
  room_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  text TEXT DEFAULT '',
  image TEXT DEFAULT NULL,
  sensitive INTEGER DEFAULT 0,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS dms (
  id TEXT PRIMARY KEY,
  user_a TEXT NOT NULL,
  user_b TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  UNIQUE(user_a, user_b)
);
CREATE TABLE IF NOT EXISTS prompt_likes (
  user_id TEXT NOT NULL,
  target_user_id TEXT NOT NULL,
  prompt_index INTEGER NOT NULL,
  PRIMARY KEY (user_id, target_user_id, prompt_index)
);
CREATE TABLE IF NOT EXISTS prompts (
  user_id TEXT NOT NULL,
  position INTEGER NOT NULL,
  question TEXT NOT NULL,
  answer TEXT NOT NULL,
  PRIMARY KEY (user_id, position)
);
`);

/* stanze di default */
const seedRooms = db.prepare("SELECT COUNT(*) AS n FROM rooms").get();
if (seedRooms.n === 0) {
  const ins = db.prepare("INSERT INTO rooms (id, name, topic, access, hue) VALUES (?,?,?,?,?)");
  ins.run("r1", "salotto", "la stanza aperta a tutti — presentati!", "open", "#6C4DFF");
  ins.run("r2", "romantic", "conversazioni con un po' di batticuore — i guest possono ascoltare", "view", "#B44DFF");
  ins.run("r3", "rosa", "la stanza riservata — solo profili registrati e completi", "members", "#FF4D8D");
}

/* ———— app ———— */
const app = express();
const httpServer = createServer(app);
const io = new Server(httpServer, { cors: { origin: FRONTEND_URL } });

app.use(cors({ origin: FRONTEND_URL }));
app.use(express.json({ limit: "1mb" }));

/* upload foto su disco */
const uploadDir = path.join(__dirname, "uploads");
if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir, { recursive: true });
const storage = multer.diskStorage({
  destination: uploadDir,
  filename: (_req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    cb(null, `${crypto.randomUUID()}${ext}`);
  },
});
const upload = multer({
  storage,
  limits: { fileSize: 5 * 1024 * 1024 }, // 5 MB
  fileFilter: (_req, file, cb) => {
    const ok = ["image/jpeg", "image/png", "image/webp", "image/gif"].includes(file.mimetype);
    cb(ok ? null : new Error("Formato non supportato"), ok);
  },
});
app.use("/uploads", express.static(uploadDir));

/* ———— helpers ———— */
const uid = () => crypto.randomUUID();
const nowMs = () => Date.now();

function makeToken(user) {
  return jwt.sign({ id: user.id, handle: user.handle }, JWT_SECRET, { expiresIn: "30d" });
}

function auth(req, res, next) {
  const header = req.headers.authorization || "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : null;
  if (!token) return res.status(401).json({ error: "Token mancante" });
  try {
    req.user = jwt.verify(token, JWT_SECRET);
    next();
  } catch {
    res.status(401).json({ error: "Token non valido o scaduto" });
  }
}

function publicUser(u) {
  const photos = db.prepare("SELECT id, filename, position FROM photos WHERE user_id = ? ORDER BY position").all(u.id);
  const prompts = db.prepare("SELECT question, answer FROM prompts WHERE user_id = ? ORDER BY position").all(u.id);
  return {
    id: u.id, name: u.name, age: u.age, handle: u.handle, city: u.city,
    bio: u.bio, vibe: u.vibe, avatar: u.avatar, streak: u.streak,
    photos: photos.map((p) => ({ id: p.id, url: `/uploads/${p.filename}` })),
    prompts: prompts.map((p) => [p.question, p.answer]),
  };
}

/* ————————————————— AUTH ————————————————— */

/* step 1: registrazione → invia codice email */
app.post("/api/auth/register", async (req, res) => {
  const { email, password, name, age, handle, city } = req.body || {};
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email))
    return res.status(400).json({ error: "Email non valida" });
  if (!password || password.length < 8)
    return res.status(400).json({ error: "Password: minimo 8 caratteri" });
  if (!name?.trim()) return res.status(400).json({ error: "Nome obbligatorio" });
  const a = parseInt(age, 10);
  if (!a || a < 18) return res.status(400).json({ error: "Riservato ai maggiorenni (18+)" });
  if (!handle?.trim()) return res.status(400).json({ error: "Handle obbligatorio" });

  const cleanHandle = handle.trim().toLowerCase().replace(/\s+/g, ".");
  const emailLc = email.trim().toLowerCase();

  const existing = db.prepare("SELECT * FROM users WHERE email = ?").get(emailLc);
  /* email già verificata da un account attivo → è un conflitto vero */
  if (existing && existing.verified)
    return res.status(409).json({ error: "Email già registrata. Prova ad accedere." });

  /* handle in uso da un ALTRO utente (verificato o meno) → conflitto */
  const handleOwner = db.prepare("SELECT id FROM users WHERE handle = ?").get(cleanHandle);
  if (handleOwner && (!existing || handleOwner.id !== existing.id))
    return res.status(409).json({ error: "Handle già in uso" });

  let id;
  if (existing) {
    /* registrazione lasciata a metà: riusa l'account non verificato invece
       di bloccare l'utente con "email già registrata" */
    id = existing.id;
    db.prepare(`UPDATE users SET password_hash=?, name=?, age=?, handle=?, city=? WHERE id=?`)
      .run(bcrypt.hashSync(password, 10), name.trim(), a, cleanHandle, (city || "").trim(), id);
  } else {
    id = uid();
    db.prepare(`INSERT INTO users (id, email, password_hash, name, age, handle, city, created_at)
                VALUES (?,?,?,?,?,?,?,?)`)
      .run(id, emailLc, bcrypt.hashSync(password, 10), name.trim(), a, cleanHandle, (city || "").trim(), nowMs());
  }

  const code = String(Math.floor(100000 + Math.random() * 900000));
  db.prepare("INSERT OR REPLACE INTO verification_codes (email, code, expires_at) VALUES (?,?,?)")
    .run(emailLc, code, nowMs() + 15 * 60 * 1000);

  try {
    await sendVerificationEmail(emailLc, code);
  } catch (e) {
    console.error("Errore invio email:", e.message);
    return res.status(500).json({ error: "Invio email fallito, riprova" });
  }
  res.json({ ok: true, message: "Codice inviato via email", pending: true });
});

/* reinvia un nuovo codice per un account già creato ma non ancora verificato
   (usato quando l'utente torna sul sito con una verifica lasciata a metà) */
app.post("/api/auth/resend-code", async (req, res) => {
  const emailLc = (req.body?.email || "").trim().toLowerCase();
  const user = db.prepare("SELECT * FROM users WHERE email = ?").get(emailLc);
  if (!user) return res.status(404).json({ error: "Nessuna registrazione trovata per questa email" });
  if (user.verified) return res.status(409).json({ error: "Email già verificata, effettua il login" });

  const code = String(Math.floor(100000 + Math.random() * 900000));
  db.prepare("INSERT OR REPLACE INTO verification_codes (email, code, expires_at) VALUES (?,?,?)")
    .run(emailLc, code, nowMs() + 15 * 60 * 1000);
  try {
    await sendVerificationEmail(emailLc, code);
  } catch (e) {
    console.error("Errore invio email:", e.message);
    return res.status(500).json({ error: "Invio email fallito, riprova" });
  }
  res.json({ ok: true });
});

/* step 2: verifica codice → account attivo + token */
app.post("/api/auth/verify", (req, res) => {
  const { email, code } = req.body || {};
  const emailLc = (email || "").trim().toLowerCase();
  const row = db.prepare("SELECT * FROM verification_codes WHERE email = ?").get(emailLc);
  if (!row || row.expires_at < nowMs()) return res.status(400).json({ error: "Codice scaduto, richiedine uno nuovo" });
  if (row.code !== String(code).trim()) return res.status(400).json({ error: "Codice non corretto" });

  db.prepare("UPDATE users SET verified = 1 WHERE email = ?").run(emailLc);
  db.prepare("DELETE FROM verification_codes WHERE email = ?").run(emailLc);
  const user = db.prepare("SELECT * FROM users WHERE email = ?").get(emailLc);
  res.json({ token: makeToken(user), user: publicUser(user) });
});

/* login */
app.post("/api/auth/login", (req, res) => {
  const { email, password } = req.body || {};
  const user = db.prepare("SELECT * FROM users WHERE email = ?").get((email || "").trim().toLowerCase());
  if (!user || !bcrypt.compareSync(password || "", user.password_hash))
    return res.status(401).json({ error: "Credenziali errate" });
  if (!user.verified) return res.status(403).json({ error: "Email non ancora verificata" });
  res.json({ token: makeToken(user), user: publicUser(user) });
});

/* ————————————————— PROFILI ————————————————— */

app.get("/api/me", auth, (req, res) => {
  const u = db.prepare("SELECT * FROM users WHERE id = ?").get(req.user.id);
  if (!u) return res.status(404).json({ error: "Utente non trovato" });
  res.json({ ...publicUser(u), email: u.email });
});

app.patch("/api/me", auth, (req, res) => {
  const { bio, vibe, city, avatar } = req.body || {};
  db.prepare("UPDATE users SET bio = COALESCE(?, bio), vibe = COALESCE(?, vibe), city = COALESCE(?, city), avatar = COALESCE(?, avatar) WHERE id = ?")
    .run(bio ?? null, vibe ?? null, city ?? null, avatar ?? null, req.user.id);
  const u = db.prepare("SELECT * FROM users WHERE id = ?").get(req.user.id);
  res.json(publicUser(u));
});

/* prompt del profilo (max 3) */
app.put("/api/me/prompts", auth, (req, res) => {
  const { prompts } = req.body || {}; // [[domanda, risposta], ...]
  if (!Array.isArray(prompts) || prompts.length > 3)
    return res.status(400).json({ error: "Massimo 3 prompt" });
  const del = db.prepare("DELETE FROM prompts WHERE user_id = ?");
  const ins = db.prepare("INSERT INTO prompts (user_id, position, question, answer) VALUES (?,?,?,?)");
  const tx = db.transaction(() => {
    del.run(req.user.id);
    prompts.forEach(([q, a], i) => ins.run(req.user.id, i, String(q).slice(0, 120), String(a).slice(0, 300)));
  });
  tx();
  res.json({ ok: true });
});

/* elenco persone (feed) */
app.get("/api/people", auth, (req, res) => {
  const users = db.prepare("SELECT * FROM users WHERE verified = 1 AND id != ? ORDER BY created_at DESC LIMIT 50").all(req.user.id);
  res.json(users.map(publicUser));
});

app.get("/api/people/:id", auth, (req, res) => {
  const u = db.prepare("SELECT * FROM users WHERE id = ? AND verified = 1").get(req.params.id);
  if (!u) return res.status(404).json({ error: "Profilo non trovato" });
  res.json(publicUser(u));
});

/* ————————————————— FOTO ————————————————— */

app.post("/api/me/photos", auth, upload.single("photo"), (req, res) => {
  if (!req.file) return res.status(400).json({ error: "Nessun file" });
  const count = db.prepare("SELECT COUNT(*) AS n FROM photos WHERE user_id = ?").get(req.user.id).n;
  if (count >= 6) {
    fs.unlinkSync(req.file.path);
    return res.status(400).json({ error: "Massimo 6 foto" });
  }
  const id = uid();
  db.prepare("INSERT INTO photos (id, user_id, filename, position, created_at) VALUES (?,?,?,?,?)")
    .run(id, req.user.id, req.file.filename, count, nowMs());
  res.json({ id, url: `/uploads/${req.file.filename}` });
});

app.delete("/api/me/photos/:photoId", auth, (req, res) => {
  const photo = db.prepare("SELECT * FROM photos WHERE id = ? AND user_id = ?").get(req.params.photoId, req.user.id);
  if (!photo) return res.status(404).json({ error: "Foto non trovata" });
  db.prepare("DELETE FROM photos WHERE id = ?").run(photo.id);
  const filePath = path.join(uploadDir, photo.filename);
  if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
  res.json({ ok: true });
});

/* ————————————————— LIKE AI PROMPT ————————————————— */

app.post("/api/likes/:targetUserId/:promptIndex", auth, (req, res) => {
  const { targetUserId, promptIndex } = req.params;
  const existing = db.prepare("SELECT 1 FROM prompt_likes WHERE user_id = ? AND target_user_id = ? AND prompt_index = ?")
    .get(req.user.id, targetUserId, promptIndex);
  if (existing) {
    db.prepare("DELETE FROM prompt_likes WHERE user_id = ? AND target_user_id = ? AND prompt_index = ?")
      .run(req.user.id, targetUserId, promptIndex);
  } else {
    db.prepare("INSERT INTO prompt_likes (user_id, target_user_id, prompt_index) VALUES (?,?,?)")
      .run(req.user.id, targetUserId, promptIndex);
  }
  const count = db.prepare("SELECT COUNT(*) AS n FROM prompt_likes WHERE target_user_id = ? AND prompt_index = ?")
    .get(targetUserId, promptIndex).n;
  res.json({ liked: !existing, count });
});

/* ————————————————— STANZE & MESSAGGI ————————————————— */

app.get("/api/rooms", (req, res) => {
  res.json(db.prepare("SELECT * FROM rooms").all());
});

app.get("/api/rooms/:roomId/messages", (req, res) => {
  /* i guest possono leggere open e view; members richiede token */
  const room = db.prepare("SELECT * FROM rooms WHERE id = ?").get(req.params.roomId);
  if (!room) return res.status(404).json({ error: "Stanza non trovata" });

  if (room.access === "members") {
    const header = req.headers.authorization || "";
    const token = header.startsWith("Bearer ") ? header.slice(7) : null;
    try { jwt.verify(token, JWT_SECRET); }
    catch { return res.status(403).json({ error: "Stanza riservata agli iscritti" }); }
  }

  const msgs = db.prepare(`
    SELECT m.*, u.name, u.handle, u.avatar FROM messages m
    JOIN users u ON u.id = m.user_id
    WHERE m.room_id = ? ORDER BY m.created_at ASC LIMIT 200
  `).all(req.params.roomId);
  res.json(msgs);
});

/* ————————————————— DM ————————————————— */

app.post("/api/dms/:otherUserId", auth, (req, res) => {
  const other = db.prepare("SELECT id FROM users WHERE id = ? AND verified = 1").get(req.params.otherUserId);
  if (!other) return res.status(404).json({ error: "Utente non trovato" });
  const [a, b] = [req.user.id, other.id].sort();
  let dm = db.prepare("SELECT * FROM dms WHERE user_a = ? AND user_b = ?").get(a, b);
  if (!dm) {
    dm = { id: `dm-${uid()}`, user_a: a, user_b: b, created_at: nowMs() };
    db.prepare("INSERT INTO dms (id, user_a, user_b, created_at) VALUES (?,?,?,?)")
      .run(dm.id, a, b, dm.created_at);
  }
  res.json(dm);
});

app.get("/api/dms", auth, (req, res) => {
  const list = db.prepare("SELECT * FROM dms WHERE user_a = ? OR user_b = ?").all(req.user.id, req.user.id);
  /* aggiunge i dati dell'altro utente per mostrare nome/avatar in lista */
  const enriched = list.map((dm) => {
    const otherId = dm.user_a === req.user.id ? dm.user_b : dm.user_a;
    const other = db.prepare("SELECT id, name, handle, avatar FROM users WHERE id = ?").get(otherId);
    return { ...dm, other };
  });
  res.json(enriched);
});

/* cronologia messaggi di una DM (solo i due partecipanti) */
app.get("/api/dms/:dmId/messages", auth, (req, res) => {
  const dm = db.prepare("SELECT * FROM dms WHERE id = ?").get(req.params.dmId);
  if (!dm || (dm.user_a !== req.user.id && dm.user_b !== req.user.id))
    return res.status(404).json({ error: "DM non trovata" });
  const msgs = db.prepare(`
    SELECT m.*, u.name, u.handle, u.avatar FROM messages m
    JOIN users u ON u.id = m.user_id
    WHERE m.room_id = ? ORDER BY m.created_at ASC LIMIT 200
  `).all(dm.id);
  res.json(msgs);
});

/* ————————————————— SOCKET.IO (chat in tempo reale) ————————————————— */

io.use((socket, next) => {
  const token = socket.handshake.auth?.token;
  if (!token) {
    socket.data.guest = true; // i guest possono solo ascoltare
    return next();
  }
  try {
    socket.data.user = jwt.verify(token, JWT_SECRET);
    next();
  } catch {
    next(new Error("Token non valido"));
  }
});

io.on("connection", (socket) => {
  socket.on("join", ({ roomId }) => {
    const room = db.prepare("SELECT * FROM rooms WHERE id = ?").get(roomId);
    const isDm = roomId.startsWith("dm-");
    if (isDm) {
      if (socket.data.guest) return socket.emit("errorMsg", "Accedi per le DM");
      const dm = db.prepare("SELECT * FROM dms WHERE id = ?").get(roomId);
      if (!dm || (dm.user_a !== socket.data.user.id && dm.user_b !== socket.data.user.id))
        return socket.emit("errorMsg", "DM non trovata");
    } else {
      if (!room) return socket.emit("errorMsg", "Stanza non trovata");
      if (room.access === "members" && socket.data.guest)
        return socket.emit("errorMsg", "Stanza riservata agli iscritti");
    }
    socket.join(roomId);
  });

  socket.on("message", ({ roomId, text, image, sensitive }) => {
    const isDm = roomId.startsWith("dm-");

    if (isDm) {
      /* le DM richiedono sempre un utente registrato e partecipante */
      if (socket.data.guest) return socket.emit("errorMsg", "Registrati per scrivere");
      const dm = db.prepare("SELECT * FROM dms WHERE id = ?").get(roomId);
      if (!dm || (dm.user_a !== socket.data.user.id && dm.user_b !== socket.data.user.id))
        return socket.emit("errorMsg", "DM non trovata");
    } else {
      const room = db.prepare("SELECT * FROM rooms WHERE id = ?").get(roomId);
      if (!room) return;
      /* i guest possono scrivere SOLO nelle stanze ad accesso "open" */
      if (socket.data.guest && room.access !== "open")
        return socket.emit("errorMsg", "Registrati per scrivere in questa stanza");
    }

    /* utente: registrato normale, oppure guest anonimo con id generato per il socket */
    let userId, u;
    if (socket.data.guest) {
      if (!socket.data.guestId) socket.data.guestId = `guest-${socket.id}`;
      userId = socket.data.guestId;
      u = { name: "Guest", handle: "guest", avatar: "" };
    } else {
      userId = socket.data.user.id;
      u = db.prepare("SELECT name, handle, avatar FROM users WHERE id = ?").get(userId);
    }

    const msg = {
      id: uid(), room_id: roomId, user_id: userId,
      text: String(text || "").slice(0, 2000),
      image: image || null, sensitive: sensitive ? 1 : 0,
      created_at: nowMs(),
    };
    /* i messaggi dei guest anonimi non vengono salvati in cronologia
       (non hanno un utente reale in tabella users da referenziare) */
    if (!socket.data.guest) {
      db.prepare("INSERT INTO messages (id, room_id, user_id, text, image, sensitive, created_at) VALUES (?,?,?,?,?,?,?)")
        .run(msg.id, msg.room_id, msg.user_id, msg.text, msg.image, msg.sensitive, msg.created_at);
    }
    io.to(roomId).emit("message", { ...msg, ...u });
  });

  socket.on("leave", ({ roomId }) => socket.leave(roomId));
});

/* ———— avvio ———— */
httpServer.listen(PORT, () => {
  console.log(`Foyer backend in ascolto sulla porta ${PORT}`);
  if (!RESEND_API_KEY) console.log("⚠ RESEND_API_KEY non impostata: i codici email vengono stampati qui nel log");
  if (JWT_SECRET === "cambiami-in-produzione") console.log("⚠ JWT_SECRET di default: impostane uno vero prima di andare online");
});
