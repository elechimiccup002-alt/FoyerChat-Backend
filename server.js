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
const RESEND_API_KEY = process.env.RESEND_API_KEY || null;

/* FRONTEND_URL può contenere PIÙ indirizzi separati da virgola
   (es. il sito su Netlify E quello su Cloudflare insieme).
   Ogni indirizzo viene ripulito da spazi e dallo slash finale,
   che altrimenti fa fallire il confronto con l'origine del browser. */
const FRONTEND_URLS = (process.env.FRONTEND_URL || "*")
  .split(",")
  .map((u) => u.trim().replace(/\/+$/, ""))
  .filter(Boolean);

function corsOriginCheck(origin, callback) {
  /* richieste senza origin (es. curl, health check) sempre permesse;
     "*" nella lista permette qualunque origine (utile in fase di test) */
  if (!origin || FRONTEND_URLS.includes("*") || FRONTEND_URLS.includes(origin)) {
    return callback(null, true);
  }
  callback(new Error("Origine non autorizzata (CORS): " + origin));
}

/* ———— email (Resend) ———— */
let resend = null;
if (RESEND_API_KEY) {
  const { Resend } = await import("resend");
  resend = new Resend(RESEND_API_KEY);
}

async function sendVerificationEmail(to, code) {
  if (!resend) {
    console.log(`[DEV] RESEND_API_KEY non impostata — codice di verifica per ${to}: ${code}`);
    return;
  }
  const { data, error } = await resend.emails.send({
    from: "Foyer <noreply@foyerchat.com>",
    to,
    subject: `${code} è il tuo codice Foyer`,
    html: `<div style="font-family:sans-serif;max-width:420px;margin:0 auto">
      <h2>Benvenuto su Foyer 👋</h2>
      <p>Il tuo codice di verifica è:</p>
      <p style="font-size:32px;letter-spacing:8px;font-weight:bold">${code}</p>
      <p style="color:#888">Scade tra 15 minuti. Se non hai richiesto tu questo codice, ignora questa mail.</p>
    </div>`,
  });
  /* il SDK di Resend NON lancia un'eccezione sugli errori dell'API:
     restituisce { data, error } anche quando l'invio fallisce.
     Senza questo controllo l'errore passava inosservato e il codice
     finiva comunque nel database senza che l'email partisse mai. */
  if (error) {
    throw new Error(`Resend ha rifiutato l'invio: ${error.message || JSON.stringify(error)}`);
  }
  console.log(`Email di verifica inviata a ${to}, id Resend: ${data?.id}`);
}

/* ———— database ———— */
/* Dove salvare database e foto. Senza DATA_DIR usa la cartella del codice (come prima).
   Su un servizio con disco persistente si imposta DATA_DIR sul percorso del disco
   (es. /var/data): così database e foto sopravvivono a riavvii e deploy. */
const DATA_DIR = process.env.DATA_DIR || __dirname;
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
const db = new Database(path.join(DATA_DIR, "foyer.db"));
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
  private INTEGER DEFAULT 0,
  gender TEXT NOT NULL DEFAULT 'M',
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
  friends_only INTEGER DEFAULT 0,
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
  creator_id TEXT DEFAULT '',
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
CREATE TABLE IF NOT EXISTS friendships (
  user_a TEXT NOT NULL,          -- sempre l'id "minore" (ordine alfabetico)
  user_b TEXT NOT NULL,
  requester_id TEXT NOT NULL,    -- chi ha mandato la richiesta
  status TEXT NOT NULL DEFAULT 'pending', -- pending | accepted
  created_at INTEGER NOT NULL,
  PRIMARY KEY (user_a, user_b)
);
CREATE TABLE IF NOT EXISTS blocks (
  blocker_id TEXT NOT NULL,
  blocked_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (blocker_id, blocked_id)
);
CREATE TABLE IF NOT EXISTS mutes (
  user_id TEXT NOT NULL,
  muted_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, muted_id)
);
CREATE TABLE IF NOT EXISTS swipes (
  swiper_id TEXT NOT NULL,
  target_id TEXT NOT NULL,
  action TEXT NOT NULL, -- 'like' | 'pass'
  created_at INTEGER NOT NULL,
  PRIMARY KEY (swiper_id, target_id)
);
`);

/* se il database esiste già (es. disco persistente), CREATE TABLE IF NOT EXISTS
   non aggiunge le colonne nuove: le aggiungiamo qui senza perdere i dati */
function ensureColumn(table, column, ddl) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name);
  if (!cols.includes(column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${ddl}`);
}
ensureColumn("users", "private", "INTEGER DEFAULT 0");
ensureColumn("users", "gender", "TEXT NOT NULL DEFAULT 'M'");
ensureColumn("photos", "friends_only", "INTEGER DEFAULT 0");
ensureColumn("dms", "creator_id", "TEXT DEFAULT ''");

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
const io = new Server(httpServer, { cors: { origin: corsOriginCheck } });

app.use(cors({ origin: corsOriginCheck }));
app.use(express.json({ limit: "1mb" }));

/* upload foto su disco */
const uploadDir = path.join(DATA_DIR, "uploads");
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

/* ————————————————— AMICIZIE / BLOCCHI (helper) ————————————————— */

function pairIds(x, y) { return x < y ? [x, y] : [y, x]; }

function getFriendship(x, y) {
  const [a, b] = pairIds(x, y);
  return db.prepare("SELECT * FROM friendships WHERE user_a = ? AND user_b = ?").get(a, b);
}
function areFriends(x, y) {
  const f = getFriendship(x, y);
  return !!f && f.status === "accepted";
}
function friendCount(userId) {
  return db.prepare("SELECT COUNT(*) AS n FROM friendships WHERE status = 'accepted' AND (user_a = ? OR user_b = ?)")
    .get(userId, userId).n;
}
function isBlockedEither(x, y) {
  return !!db.prepare("SELECT 1 FROM blocks WHERE (blocker_id = ? AND blocked_id = ?) OR (blocker_id = ? AND blocked_id = ?)")
    .get(x, y, y, x);
}
function userSummary(id) {
  const u = db.prepare("SELECT id, handle, age, gender, avatar FROM users WHERE id = ?").get(id);
  return u ? { id: u.id, name: u.handle, handle: u.handle, age: u.age, gender: u.gender, avatar: u.avatar } : null;
}
function notifyUser(userId, event) { io.to(`user:${userId}`).emit(event); }

/* Profilo "completo" così come lo vede chi lo guarda (viewerId).
   - il titolare vede tutto, comprese le foto "solo amici"
   - gli amici accettati vedono tutto
   - tutti gli altri NON ricevono proprio le foto "solo amici" (filtrate qui,
     lato server, quindi non compaiono né nel profilo né nello swipe) */
function publicUser(u, viewerId = u.id) {
  const seesAll = viewerId === u.id || areFriends(u.id, viewerId);
  let photos = db.prepare("SELECT id, filename, position, friends_only FROM photos WHERE user_id = ? ORDER BY position").all(u.id);
  if (!seesAll) photos = photos.filter((p) => !p.friends_only);
  const prompts = db.prepare("SELECT question, answer FROM prompts WHERE user_id = ? ORDER BY position").all(u.id);
  return {
    /* "name" coincide sempre col nickname: in registrazione non si chiede
       più un nome separato, solo il nickname (handle) */
    id: u.id, name: u.handle, age: u.age, handle: u.handle, city: u.city, gender: u.gender,
    bio: u.bio, vibe: u.vibe, avatar: u.avatar, streak: u.streak, private: !!u.private,
    friend_count: friendCount(u.id),
    photos: photos.map((p) => ({ id: p.id, url: `/uploads/${p.filename}`, friends_only: !!p.friends_only })),
    prompts: prompts.map((p) => [p.question, p.answer]),
  };
}

/* Come publicUser, ma rispetta il profilo privato: chi non è il titolare né
   un suo amico vede solo nickname, età e genere (niente foto, bio, prompt) */
function profileFor(u, viewerId) {
  if (u.private && u.id !== viewerId && !areFriends(u.id, viewerId)) {
    /* "restricted" = questa è una vista limitata (il client mostra il lucchetto);
       "private" è invece l'impostazione del profilo, presente anche nella vista completa */
    return { id: u.id, name: u.handle, handle: u.handle, age: u.age, gender: u.gender, private: true, restricted: true };
  }
  return publicUser(u, viewerId);
}

/* ————————————————— AUTH ————————————————— */

/* step 1: registrazione → invia codice email */
app.post("/api/auth/register", async (req, res) => {
  const { email, password, age, handle, city, gender } = req.body || {};
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email))
    return res.status(400).json({ error: "Email non valida" });
  if (!password || password.length < 8)
    return res.status(400).json({ error: "Password: minimo 8 caratteri" });
  const a = parseInt(age, 10);
  if (!a || a < 18) return res.status(400).json({ error: "Riservato ai maggiorenni (18+)" });
  if (!handle?.trim()) return res.status(400).json({ error: "Nickname obbligatorio" });
  const genderClean = String(gender || "").trim().toUpperCase();
  if (genderClean !== "F" && genderClean !== "M")
    return res.status(400).json({ error: "Seleziona F o M" });

  const cleanHandle = handle.trim().toLowerCase().replace(/\s+/g, ".");
  const emailLc = email.trim().toLowerCase();

  const existing = db.prepare("SELECT * FROM users WHERE email = ?").get(emailLc);
  /* email già verificata da un account attivo → è un conflitto vero */
  if (existing && existing.verified)
    return res.status(409).json({ error: "Email già registrata. Prova ad accedere." });

  /* handle in uso da un ALTRO utente (verificato o meno) → conflitto */
  const handleOwner = db.prepare("SELECT id FROM users WHERE handle = ?").get(cleanHandle);
  if (handleOwner && (!existing || handleOwner.id !== existing.id))
    return res.status(409).json({ error: "Nickname già in uso" });

  /* non si chiede più un "nome" separato: il campo esiste ancora nello
     schema per compatibilità, ma coincide sempre col nickname */
  let id;
  if (existing) {
    /* registrazione lasciata a metà: riusa l'account non verificato invece
       di bloccare l'utente con "email già registrata" */
    id = existing.id;
    db.prepare(`UPDATE users SET password_hash=?, name=?, age=?, handle=?, city=?, gender=? WHERE id=?`)
      .run(bcrypt.hashSync(password, 10), cleanHandle, a, cleanHandle, (city || "").trim(), genderClean, id);
  } else {
    id = uid();
    db.prepare(`INSERT INTO users (id, email, password_hash, name, age, handle, city, gender, created_at)
                VALUES (?,?,?,?,?,?,?,?,?)`)
      .run(id, emailLc, bcrypt.hashSync(password, 10), cleanHandle, a, cleanHandle, (city || "").trim(), genderClean, nowMs());
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
  const { bio, vibe, city, avatar, private: priv } = req.body || {};
  const privValue = priv === undefined ? null : (priv ? 1 : 0);
  db.prepare("UPDATE users SET bio = COALESCE(?, bio), vibe = COALESCE(?, vibe), city = COALESCE(?, city), avatar = COALESCE(?, avatar), private = COALESCE(?, private) WHERE id = ?")
    .run(bio ?? null, vibe ?? null, city ?? null, avatar ?? null, privValue, req.user.id);
  const u = db.prepare("SELECT * FROM users WHERE id = ?").get(req.user.id);
  io.emit("people-changed"); // chi ha aperto "Persone" ricarica subito il feed
  res.json(publicUser(u));
});

/* carica una foto profilo vera (drag&drop o file picker), al posto degli
   avatar preimpostati scelti in fase di registrazione */
app.post("/api/me/avatar", auth, upload.single("avatar"), (req, res) => {
  if (!req.file) return res.status(400).json({ error: "Nessun file" });
  const url = `/uploads/${req.file.filename}`;
  db.prepare("UPDATE users SET avatar = ? WHERE id = ?").run(url, req.user.id);
  io.emit("people-changed");
  res.json({ avatar: url });
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
  io.emit("people-changed");
  res.json({ ok: true });
});

/* elenco persone (feed) */
app.get("/api/people", auth, (req, res) => {
  const me = req.user.id;
  /* lo swipe (like/pass) è una decisione presa UNA volta: chi ho già
     valutato non torna più nel mazzo */
  const already = new Set(db.prepare("SELECT target_id FROM swipes WHERE swiper_id = ?").all(me).map((r) => r.target_id));
  const users = db.prepare("SELECT * FROM users WHERE verified = 1 AND id != ? ORDER BY created_at DESC LIMIT 100").all(me);
  res.json(users.filter((u) => !already.has(u.id) && !isBlockedEither(me, u.id)).map((u) => profileFor(u, me)));
});

/* registra un like o un pass; se è un like reciproco, è un match */
app.post("/api/swipes/:userId", auth, (req, res) => {
  const other = relationTarget(req, res); if (!other) return;
  const me = req.user.id;
  if (isBlockedEither(me, other)) return res.status(403).json({ error: "Azione non disponibile" });
  const { action } = req.body || {};
  if (action !== "like" && action !== "pass") return res.status(400).json({ error: "Azione non valida" });

  db.prepare(`INSERT INTO swipes (swiper_id, target_id, action, created_at) VALUES (?,?,?,?)
              ON CONFLICT(swiper_id, target_id) DO UPDATE SET action = excluded.action, created_at = excluded.created_at`)
    .run(me, other, action, nowMs());

  let match = false;
  if (action === "like") {
    const theirs = db.prepare("SELECT action FROM swipes WHERE swiper_id = ? AND target_id = ?").get(other, me);
    if (theirs && theirs.action === "like") {
      match = true;
      /* l'altro potrebbe non essere connesso in questo momento; lo saprà
         al prossimo accesso, e in tempo reale se lo è */
      notifyUser(other, "match-changed");
    }
  }
  res.json({ ok: true, match });
});

/* chi mi ha messo like e non ho ancora valutato (si riduce quando rispondo) */
app.get("/api/swipes/likes-me", auth, (req, res) => {
  const me = req.user.id;
  const rows = db.prepare(`
    SELECT s.swiper_id AS id FROM swipes s
    WHERE s.target_id = ? AND s.action = 'like'
      AND NOT EXISTS (SELECT 1 FROM swipes s2 WHERE s2.swiper_id = ? AND s2.target_id = s.swiper_id)
    ORDER BY s.created_at DESC
  `).all(me, me);
  res.json(rows.map((r) => userSummary(r.id)).filter((u) => u && !isBlockedEither(me, u.id)));
});

/* i miei match: like reciproci */
app.get("/api/swipes/matches", auth, (req, res) => {
  const me = req.user.id;
  const rows = db.prepare(`
    SELECT s.target_id AS id FROM swipes s
    WHERE s.swiper_id = ? AND s.action = 'like'
      AND EXISTS (SELECT 1 FROM swipes s2 WHERE s2.swiper_id = s.target_id AND s2.target_id = ? AND s2.action = 'like')
    ORDER BY s.created_at DESC
  `).all(me, me);
  res.json(rows.map((r) => userSummary(r.id)).filter((u) => u && !isBlockedEither(me, u.id)));
});

app.get("/api/people/:id", auth, (req, res) => {
  const u = db.prepare("SELECT * FROM users WHERE id = ? AND verified = 1").get(req.params.id);
  if (!u || isBlockedEither(req.user.id, u.id)) return res.status(404).json({ error: "Profilo non disponibile" });
  res.json(profileFor(u, req.user.id));
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
  io.emit("people-changed");
  res.json({ id, url: `/uploads/${req.file.filename}`, friends_only: false });
});

app.delete("/api/me/photos/:photoId", auth, (req, res) => {
  const photo = db.prepare("SELECT * FROM photos WHERE id = ? AND user_id = ?").get(req.params.photoId, req.user.id);
  if (!photo) return res.status(404).json({ error: "Foto non trovata" });
  db.prepare("DELETE FROM photos WHERE id = ?").run(photo.id);
  const filePath = path.join(uploadDir, photo.filename);
  if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
  io.emit("people-changed");
  res.json({ ok: true });
});

/* "solo amici": se attivo, la foto la vedono solo il titolare e i suoi amici
   accettati (né nel profilo, né nello swipe di Persone) */
app.patch("/api/me/photos/:photoId", auth, (req, res) => {
  const photo = db.prepare("SELECT * FROM photos WHERE id = ? AND user_id = ?").get(req.params.photoId, req.user.id);
  if (!photo) return res.status(404).json({ error: "Foto non trovata" });
  const { friends_only } = req.body || {};
  if (friends_only !== undefined) {
    db.prepare("UPDATE photos SET friends_only = ? WHERE id = ?").run(friends_only ? 1 : 0, photo.id);
    io.emit("people-changed");
  }
  res.json({ ok: true, friends_only: !!friends_only });
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

/* ————————————————— AMICI / BLOCCHI / SILENZIATI ————————————————— */

/* tutto ciò che riguarda me: amici, richieste ricevute/inviate, bloccati, silenziati */
app.get("/api/relations", auth, (req, res) => {
  const me = req.user.id;
  const rows = db.prepare("SELECT * FROM friendships WHERE user_a = ? OR user_b = ?").all(me, me);
  const friends = [], incoming = [], outgoing = [];
  for (const r of rows) {
    const other = userSummary(r.user_a === me ? r.user_b : r.user_a);
    if (!other) continue;
    if (r.status === "accepted") friends.push(other);
    else if (r.requester_id === me) outgoing.push(other);
    else incoming.push(other);
  }
  const blocked = db.prepare("SELECT blocked_id AS id FROM blocks WHERE blocker_id = ?").all(me)
    .map((r) => userSummary(r.id)).filter(Boolean);
  const muted = db.prepare("SELECT muted_id AS id FROM mutes WHERE user_id = ?").all(me)
    .map((r) => userSummary(r.id)).filter(Boolean);
  res.json({ friends, incoming, outgoing, blocked, muted });
});

/* controlli comuni: l'altro utente esiste e non sono io */
function relationTarget(req, res) {
  const other = req.params.userId;
  if (other === req.user.id) { res.status(400).json({ error: "Azione non valida su te stesso" }); return null; }
  const target = db.prepare("SELECT id FROM users WHERE id = ? AND verified = 1").get(other);
  if (!target) { res.status(404).json({ error: "Utente non trovato" }); return null; }
  return other;
}
/* avvisa i due utenti coinvolti: ricaricano relazioni e feed in tempo reale */
function relationsChanged(a, b) {
  for (const id of [a, b]) { notifyUser(id, "relations-changed"); notifyUser(id, "people-changed"); }
}

/* richiesta di amicizia (se l'altro me l'aveva già mandata, diventiamo amici) */
app.post("/api/friends/:userId", auth, (req, res) => {
  const other = relationTarget(req, res); if (!other) return;
  const me = req.user.id;
  if (isBlockedEither(me, other)) return res.status(403).json({ error: "Azione non disponibile" });
  const [a, b] = pairIds(me, other);
  const existing = getFriendship(me, other);
  if (!existing) {
    db.prepare("INSERT INTO friendships (user_a, user_b, requester_id, status, created_at) VALUES (?,?,?,?,?)")
      .run(a, b, me, "pending", nowMs());
  } else if (existing.status === "pending" && existing.requester_id !== me) {
    db.prepare("UPDATE friendships SET status = 'accepted' WHERE user_a = ? AND user_b = ?").run(a, b);
  }
  relationsChanged(me, other);
  res.json({ ok: true });
});

app.post("/api/friends/:userId/accept", auth, (req, res) => {
  const other = relationTarget(req, res); if (!other) return;
  const me = req.user.id;
  const f = getFriendship(me, other);
  if (!f || f.status !== "pending" || f.requester_id === me)
    return res.status(404).json({ error: "Nessuna richiesta da accettare" });
  const [a, b] = pairIds(me, other);
  db.prepare("UPDATE friendships SET status = 'accepted' WHERE user_a = ? AND user_b = ?").run(a, b);
  relationsChanged(me, other);
  res.json({ ok: true });
});

/* rimuove un amico, rifiuta una richiesta ricevuta o annulla una inviata */
app.delete("/api/friends/:userId", auth, (req, res) => {
  const other = relationTarget(req, res); if (!other) return;
  const [a, b] = pairIds(req.user.id, other);
  db.prepare("DELETE FROM friendships WHERE user_a = ? AND user_b = ?").run(a, b);
  relationsChanged(req.user.id, other);
  res.json({ ok: true });
});

/* blocco: chiude l'amicizia, impedisce DM e visibilità reciproca */
app.post("/api/blocks/:userId", auth, (req, res) => {
  const other = relationTarget(req, res); if (!other) return;
  const me = req.user.id;
  const [a, b] = pairIds(me, other);
  db.transaction(() => {
    db.prepare("INSERT OR IGNORE INTO blocks (blocker_id, blocked_id, created_at) VALUES (?,?,?)").run(me, other, nowMs());
    db.prepare("DELETE FROM friendships WHERE user_a = ? AND user_b = ?").run(a, b);
  })();
  relationsChanged(me, other);
  res.json({ ok: true });
});
app.delete("/api/blocks/:userId", auth, (req, res) => {
  const other = relationTarget(req, res); if (!other) return;
  db.prepare("DELETE FROM blocks WHERE blocker_id = ? AND blocked_id = ?").run(req.user.id, other);
  relationsChanged(req.user.id, other);
  res.json({ ok: true });
});

/* silenzia: solo per me, l'altro non viene avvisato */
app.post("/api/mutes/:userId", auth, (req, res) => {
  const other = relationTarget(req, res); if (!other) return;
  db.prepare("INSERT OR IGNORE INTO mutes (user_id, muted_id, created_at) VALUES (?,?,?)").run(req.user.id, other, nowMs());
  res.json({ ok: true });
});
app.delete("/api/mutes/:userId", auth, (req, res) => {
  const other = relationTarget(req, res); if (!other) return;
  db.prepare("DELETE FROM mutes WHERE user_id = ? AND muted_id = ?").run(req.user.id, other);
  res.json({ ok: true });
});

/* ————————————————— DM ————————————————— */

app.post("/api/dms/:otherUserId", auth, (req, res) => {
  const other = db.prepare("SELECT id FROM users WHERE id = ? AND verified = 1").get(req.params.otherUserId);
  if (!other) return res.status(404).json({ error: "Utente non trovato" });
  if (other.id === req.user.id) return res.status(400).json({ error: "Non puoi scrivere a te stesso" });
  if (isBlockedEither(req.user.id, other.id))
    return res.status(403).json({ error: "Non puoi scrivere a questo utente." });
  const [a, b] = [req.user.id, other.id].sort();
  let dm = db.prepare("SELECT * FROM dms WHERE user_a = ? AND user_b = ?").get(a, b);
  if (!dm) {
    dm = { id: `dm-${uid()}`, user_a: a, user_b: b, creator_id: req.user.id, created_at: nowMs() };
    db.prepare("INSERT INTO dms (id, user_a, user_b, creator_id, created_at) VALUES (?,?,?,?,?)")
      .run(dm.id, a, b, dm.creator_id, dm.created_at);
  }
  res.json(dm);
});

/* le mie conversazioni: quelle che ho aperto io, più quelle in cui qualcuno
   mi ha già scritto (le DM vuote aperte da altri non compaiono) */
app.get("/api/dms", auth, (req, res) => {
  const me = req.user.id;
  const list = db.prepare(`
    SELECT d.*,
      (SELECT COUNT(*) FROM messages m WHERE m.room_id = d.id) AS msg_count,
      (SELECT MAX(m.created_at) FROM messages m WHERE m.room_id = d.id) AS last_at
    FROM dms d WHERE d.user_a = ? OR d.user_b = ?
  `).all(me, me);
  const enriched = list
    .filter((dm) => dm.creator_id === me || dm.msg_count > 0)
    .map((dm) => ({ ...dm, other: userSummary(dm.user_a === me ? dm.user_b : dm.user_a) }))
    .filter((dm) => dm.other)
    .sort((x, y) => (y.last_at || y.created_at) - (x.last_at || x.created_at));
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

/* chi è davvero connesso in questo momento: id utente → quante schede/dispositivi
   ha aperti (così non risulta "offline" chiudendo una sola scheda su più aperte) */
const onlineCounts = new Map();
function isOnline(id) { return (onlineCounts.get(id) || 0) > 0; }

app.get("/api/online", auth, (req, res) => {
  res.json([...onlineCounts.keys()].filter((id) => onlineCounts.get(id) > 0));
});

io.on("connection", (socket) => {
  /* ogni utente registrato entra nella sua "stanza personale": serve per
     recapitargli le DM e gli aggiornamenti anche se non ha quella chat aperta */
  if (!socket.data.guest) {
    const me = socket.data.user.id;
    socket.join(`user:${me}`);
    const wasOffline = !isOnline(me);
    onlineCounts.set(me, (onlineCounts.get(me) || 0) + 1);
    if (wasOffline) io.emit("presence", { userId: me, online: true });

    socket.on("disconnect", () => {
      const left = (onlineCounts.get(me) || 1) - 1;
      onlineCounts.set(me, Math.max(0, left));
      if (left <= 0) io.emit("presence", { userId: me, online: false });
    });
  }

  socket.on("join", ({ roomId }) => {
    if (typeof roomId !== "string") return;
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
    if (typeof roomId !== "string") return;
    const isDm = roomId.startsWith("dm-");
    let dmRow = null;

    if (isDm) {
      /* le DM richiedono sempre un utente registrato e partecipante */
      if (socket.data.guest) return socket.emit("errorMsg", "Registrati per scrivere");
      dmRow = db.prepare("SELECT * FROM dms WHERE id = ?").get(roomId);
      if (!dmRow || (dmRow.user_a !== socket.data.user.id && dmRow.user_b !== socket.data.user.id))
        return socket.emit("errorMsg", "DM non trovata");
      const otherId = dmRow.user_a === socket.data.user.id ? dmRow.user_b : dmRow.user_a;
      if (isBlockedEither(socket.data.user.id, otherId))
        return socket.emit("errorMsg", "Non puoi inviare messaggi a questo utente.");
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
    const payload = { ...msg, ...u };
    if (isDm) {
      /* arriva a tutte le sessioni di entrambi i partecipanti: chi riceve la
         DM la vede comparire in lista anche senza aver aperto quella chat */
      io.to(`user:${dmRow.user_a}`).to(`user:${dmRow.user_b}`).emit("message", payload);
    } else {
      io.to(roomId).emit("message", payload);
    }
  });

  socket.on("leave", ({ roomId }) => socket.leave(roomId));
});

/* ———— avvio ———— */
httpServer.listen(PORT, () => {
  console.log(`Foyer backend in ascolto sulla porta ${PORT}`);
  console.log(process.env.DATA_DIR
    ? `Dati salvati in ${DATA_DIR} (disco persistente: gli account restano dopo riavvii e deploy)`
    : "⚠ DATA_DIR non impostata: database e foto stanno su disco temporaneo e si cancellano a ogni riavvio/deploy");
  if (!RESEND_API_KEY) console.log("⚠ RESEND_API_KEY non impostata: i codici email vengono stampati qui nel log");
  if (JWT_SECRET === "cambiami-in-produzione") console.log("⚠ JWT_SECRET di default: impostane uno vero prima di andare online");
});
