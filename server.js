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

/* Verifica età con Yoti (opzionale): senza queste due variabili, l'endpoint
   di avvio verifica risponde chiaramente "non configurato" invece di fingere
   che funzioni. Si ottengono da hub.yoti.com dopo aver verificato l'azienda. */
const YOTI_SDK_ID = process.env.YOTI_SDK_ID || null;
const YOTI_API_KEY = process.env.YOTI_API_KEY || null;
const YOTI_AGE_THRESHOLD = parseInt(process.env.YOTI_AGE_THRESHOLD || "18", 10);
const YOTI_BASE = "https://age.yoti.com/api/v1";
/* l'indirizzo pubblico di QUESTO backend (es. https://foyerchat-backend-1.onrender.com),
   serve a Yoti per sapere dove mandare l'avviso di fine verifica */
const PUBLIC_URL = (process.env.PUBLIC_URL || "").replace(/\/+$/, "");

/* "Gate età": quando è attivo, Persone, richieste di messaggio, DM e stanza rosa
   richiedono la verifica dell'età (Yoti). Si attiva da solo quando Yoti è
   configurato; si può forzare con ENFORCE_AGE_GATE=true. Senza né l'uno né
   l'altro resta spento (fase di prova) e all'avvio lo dice chiaramente. */
const AGE_GATE = process.env.ENFORCE_AGE_GATE === "true" || !!(YOTI_SDK_ID && YOTI_API_KEY);

/* la rosa: richiesta di messaggio con priorità, a pagamento (saldo simulato per ora) */
const ROSE_COST = 1.99;
const MAX_REQUESTS_PER_DAY = 30; // richieste di messaggio nuove al giorno per persona (anti-spam)

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
  tokens REAL NOT NULL DEFAULT 10,
  age_verified INTEGER NOT NULL DEFAULT 0,
  dm_private INTEGER NOT NULL DEFAULT 0,
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
  thumb_filename TEXT DEFAULT '',
  blur_filename TEXT DEFAULT '',
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
CREATE TABLE IF NOT EXISTS age_verification_sessions (
  session_id TEXT PRIMARY KEY,  -- id generato da Yoti
  user_id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending', -- pending | complete | failed
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS dm_requests (
  from_id TEXT NOT NULL,
  to_id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending', -- pending | accepted | declined
  rose INTEGER NOT NULL DEFAULT 0,
  cost REAL NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (from_id, to_id)
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
ensureColumn("users", "tokens", "REAL NOT NULL DEFAULT 10");
ensureColumn("users", "age_verified", "INTEGER NOT NULL DEFAULT 0");
ensureColumn("users", "dm_private", "INTEGER NOT NULL DEFAULT 0");
ensureColumn("photos", "thumb_filename", "TEXT DEFAULT ''");
ensureColumn("photos", "blur_filename", "TEXT DEFAULT ''");

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

/* ————————————————— VERIFICA ETÀ / MATCH / RICHIESTE (helper) ————————————————— */

/* con il gate spento (nessun Yoti configurato) tutti risultano "a posto" */
function isVerified(userId) {
  if (!AGE_GATE) return true;
  return !!db.prepare("SELECT age_verified FROM users WHERE id = ?").get(userId)?.age_verified;
}
const AGE_GATE_ERROR = { error: "Per usare questa funzione devi prima verificare la tua età.", code: "AGE_GATE" };
function requireVerified(req, res, next) {
  if (!isVerified(req.user.id)) return res.status(403).json(AGE_GATE_ERROR);
  next();
}

/* like reciproco */
function areMatched(x, y) {
  const n = db.prepare("SELECT COUNT(*) AS n FROM swipes WHERE action = 'like' AND ((swiper_id = ? AND target_id = ?) OR (swiper_id = ? AND target_id = ?))")
    .get(x, y, y, x).n;
  return n === 2;
}
function getDm(x, y) {
  const [a, b] = pairIds(x, y);
  return db.prepare("SELECT * FROM dms WHERE user_a = ? AND user_b = ?").get(a, b);
}
function getRequest(fromId, toId) {
  return db.prepare("SELECT * FROM dm_requests WHERE from_id = ? AND to_id = ?").get(fromId, toId);
}

/* apre la conversazione tra due persone. "visibleTo" decide chi la vede in elenco
   finché è vuota: "both" per le richieste accettate (entrambi hanno acconsentito),
   l'id di chi l'ha aperta quando è un amico/match che clicca "Scrivi" (l'altro la
   vedrà solo al primo messaggio, senza conversazioni vuote che compaiono dal nulla) */
function openDmChannel(x, y, visibleTo = "both") {
  let dm = getDm(x, y);
  if (!dm) {
    const [a, b] = pairIds(x, y);
    dm = { id: `dm-${uid()}`, user_a: a, user_b: b, creator_id: visibleTo, created_at: nowMs() };
    db.prepare("INSERT INTO dms (id, user_a, user_b, creator_id, created_at) VALUES (?,?,?,?,?)")
      .run(dm.id, a, b, dm.creator_id, dm.created_at);
  }
  return dm;
}

/* si può scrivere subito (senza richiesta) se c'è già un canale, o amicizia, o match,
   o una richiesta accettata */
function canOpenDirect(x, y) {
  if (getDm(x, y)) return true;
  if (areFriends(x, y) || areMatched(x, y)) return true;
  return getRequest(x, y)?.status === "accepted" || getRequest(y, x)?.status === "accepted";
}

/* Come posso contattare questa persona? Una sola fonte di verità per il client:
   self | open | request | rose | pending | incoming | closed */
function contactState(me, u) {
  if (u.id === me) return "self";
  if (isBlockedEither(me, u.id)) return "closed";
  if (AGE_GATE && !u.age_verified) return "closed";
  if (canOpenDirect(me, u.id)) return "open";
  const out = getRequest(me, u.id);
  if (out?.status === "pending") return "pending";
  if (out?.status === "declined") return "closed";   // niente nuovi tentativi (né a pagamento)
  const inc = getRequest(u.id, me);
  if (inc?.status === "pending") return "incoming";  // mi ha già chiesto lui: basta accettare
  return u.dm_private ? "rose" : "request";
}

/* Profilo "completo" così come lo vede chi lo guarda (viewerId).
   - il titolare e gli amici accettati vedono tutte le foto
   - agli altri le foto "sfocate dal titolare" arrivano SOLO come versione sfocata
     (un file a parte, minuscolo): l'originale e la miniatura non vengono mai
     inviati, quindi non si possono recuperare con gli strumenti del browser */
function publicUser(u, viewerId = u.id) {
  const seesAll = viewerId === u.id || areFriends(u.id, viewerId);
  const rows = db.prepare("SELECT id, filename, thumb_filename, blur_filename, position, friends_only FROM photos WHERE user_id = ? ORDER BY position").all(u.id);
  const photos = rows.map((p) => {
    if (p.friends_only && !seesAll) {
      return { id: p.id, hidden: true, blur: p.blur_filename ? `/uploads/${p.blur_filename}` : null };
    }
    return {
      id: p.id, hidden: false,
      url: `/uploads/${p.filename}`,
      thumb: `/uploads/${p.thumb_filename || p.filename}`,
      friends_only: !!p.friends_only,
    };
  });
  const prompts = db.prepare("SELECT question, answer FROM prompts WHERE user_id = ? ORDER BY position").all(u.id);
  return {
    /* "name" coincide sempre col nickname: in registrazione non si chiede
       più un nome separato, solo il nickname (handle) */
    id: u.id, name: u.handle, age: u.age, handle: u.handle, city: u.city, gender: u.gender,
    age_verified: !!u.age_verified,
    bio: u.bio, vibe: u.vibe, avatar: u.avatar, streak: u.streak, private: !!u.private,
    dm_private: !!u.dm_private,
    friend_count: friendCount(u.id),
    photos,
    prompts: prompts.map((p) => [p.question, p.answer]),
  };
}

/* Come publicUser, ma con le regole di accesso al profilo:
   - profilo privato: chi non è il titolare né un suo amico vede solo nickname/età/genere
   - con il gate età attivo, un profilo NON verificato è visibile così solo a se stesso:
     potrebbe appartenere a un minorenne, quindi nessuno vede le sue foto o la sua bio */
function profileFor(u, viewerId) {
  const unverified = AGE_GATE && !u.age_verified && u.id !== viewerId;
  const privateBlocked = u.private && u.id !== viewerId && !areFriends(u.id, viewerId);
  let out;
  if (unverified || privateBlocked) {
    /* "restricted" = vista limitata (il client mostra il lucchetto); "private" è invece
       l'impostazione del profilo, presente anche nella vista completa */
    out = { id: u.id, name: u.handle, handle: u.handle, age: u.age, gender: u.gender, age_verified: !!u.age_verified,
            dm_private: !!u.dm_private, private: !!u.private, restricted: true, unverified };
  } else {
    out = publicUser(u, viewerId);
  }
  out.contact = contactState(viewerId, u);
  return out;
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
  res.json({ ...publicUser(u), email: u.email, tokens: u.tokens, age_gate: AGE_GATE });
});

app.patch("/api/me", auth, (req, res) => {
  const { bio, vibe, city, avatar, private: priv, dm_private: dmPriv } = req.body || {};
  const privValue = priv === undefined ? null : (priv ? 1 : 0);
  const dmPrivValue = dmPriv === undefined ? null : (dmPriv ? 1 : 0);
  db.prepare("UPDATE users SET bio = COALESCE(?, bio), vibe = COALESCE(?, vibe), city = COALESCE(?, city), avatar = COALESCE(?, avatar), private = COALESCE(?, private), dm_private = COALESCE(?, dm_private) WHERE id = ?")
    .run(bio ?? null, vibe ?? null, city ?? null, avatar ?? null, privValue, dmPrivValue, req.user.id);
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

/* ————————————————— VERIFICA ETÀ (Yoti) ————————————————— */

/* chiede a Yoti il risultato vero di una sessione, usando la NOSTRA chiave
   API come fonte di verità — non ci si fida mai del solo corpo del webhook */
async function fetchYotiResult(sessionId) {
  const res = await fetch(`${YOTI_BASE}/sessions/${sessionId}/result`, {
    headers: { Authorization: `Bearer ${YOTI_API_KEY}`, "Yoti-Sdk-Id": YOTI_SDK_ID },
  });
  if (!res.ok) throw new Error(`Yoti ha risposto ${res.status}`);
  return res.json();
}

/* avvia una verifica: crea la sessione su Yoti e restituisce l'indirizzo a
   cui mandare la persona per completarla */
app.post("/api/verify-age/start", auth, async (req, res) => {
  if (!YOTI_SDK_ID || !YOTI_API_KEY)
    return res.status(501).json({ error: "Verifica età non ancora configurata su questo server" });

  const me = req.user.id;
  const u = db.prepare("SELECT age_verified FROM users WHERE id = ?").get(me);
  if (u?.age_verified) return res.json({ already: true });

  try {
    const ref = `${me}-${nowMs()}`;
    const ySession = await fetch(`${YOTI_BASE}/sessions`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${YOTI_API_KEY}`,
        "Yoti-Sdk-Id": YOTI_SDK_ID,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        type: "OVER",
        age_estimation: { allowed: true, threshold: YOTI_AGE_THRESHOLD, level: "PASSIVE" },
        ttl: 900,
        reference_id: ref,
        callback: { auto: true, url: `${FRONTEND_URLS[0] || ""}/?ageverify=done` },
        notification_url: `${PUBLIC_URL}/api/verify-age/webhook`,
      }),
    }).then((r) => r.json());

    if (!ySession?.id) return res.status(502).json({ error: "Risposta inattesa da Yoti" });

    db.prepare("INSERT INTO age_verification_sessions (session_id, user_id, status, created_at) VALUES (?,?,?,?)")
      .run(ySession.id, me, "pending", nowMs());

    res.json({ url: ySession.user_tracking_url || ySession.url, sessionId: ySession.id });
  } catch (e) {
    console.error("Errore avvio verifica età:", e.message);
    res.status(502).json({ error: "Impossibile contattare Yoti, riprova" });
  }
});

/* Yoti chiama questo indirizzo quando una sessione si conclude. Lo trattiamo
   solo come un "ricontrolla ora": il risultato vero lo chiediamo sempre
   direttamente a Yoti con la nostra chiave, non ci fidiamo del corpo ricevuto. */
app.post("/api/verify-age/webhook", async (req, res) => {
  const sessionId = req.body?.session_id || req.body?.sessionId || req.body?.id;
  if (!sessionId) return res.status(400).json({ error: "session_id mancante" });

  const row = db.prepare("SELECT * FROM age_verification_sessions WHERE session_id = ?").get(sessionId);
  if (!row) return res.status(404).json({ error: "Sessione sconosciuta" }); // non è un nostro invito: ignorata

  try {
    const result = await fetchYotiResult(sessionId);
    const passed = result?.status === "COMPLETE" && result?.result !== false;
    db.prepare("UPDATE age_verification_sessions SET status = ? WHERE session_id = ?")
      .run(passed ? "complete" : "failed", sessionId);
    if (passed) {
      db.prepare("UPDATE users SET age_verified = 1 WHERE id = ?").run(row.user_id);
      io.emit("people-changed");
      notifyUser(row.user_id, "age-verified");
    }
    res.json({ ok: true });
  } catch (e) {
    console.error("Errore verifica webhook Yoti:", e.message);
    res.status(502).json({ error: "Impossibile confermare con Yoti" });
  }
});

/* il mio stato attuale (per il pulsante nel profilo) */
app.get("/api/verify-age/status", auth, (req, res) => {
  const u = db.prepare("SELECT age_verified FROM users WHERE id = ?").get(req.user.id);
  res.json({ verified: !!u?.age_verified, configured: !!(YOTI_SDK_ID && YOTI_API_KEY) });
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

/* elenco persone (la griglia): a pagine, dal più recente. Il cursore è opaco per il
   client. Con il gate età attivo compaiono solo persone verificate: la griglia è il
   posto dove adulti verificati incontrano altri adulti verificati. */
app.get("/api/people", auth, requireVerified, (req, res) => {
  const me = req.user.id;
  const q = req.query || {};
  const limit = Math.min(Math.max(parseInt(q.limit, 10) || 36, 1), 60);
  let cur = null;
  if (q.cursor) {
    try { cur = JSON.parse(Buffer.from(String(q.cursor), "base64url").toString("utf8")); } catch { cur = null; }
  }
  const gate = AGE_GATE ? 1 : 0;
  const rows = cur && Number.isFinite(cur.t) && typeof cur.i === "string"
    ? db.prepare(`SELECT * FROM users WHERE verified = 1 AND id != ? AND (? = 0 OR age_verified = 1)
                  AND (created_at < ? OR (created_at = ? AND id < ?)) ORDER BY created_at DESC, id DESC LIMIT ?`)
        .all(me, gate, cur.t, cur.t, cur.i, limit + 1)
    : db.prepare(`SELECT * FROM users WHERE verified = 1 AND id != ? AND (? = 0 OR age_verified = 1)
                  ORDER BY created_at DESC, id DESC LIMIT ?`).all(me, gate, limit + 1);

  const hasMore = rows.length > limit;
  const page = rows.slice(0, limit);
  const next = hasMore
    ? Buffer.from(JSON.stringify({ t: page[page.length - 1].created_at, i: page[page.length - 1].id })).toString("base64url")
    : null;

  const liked = new Set(db.prepare("SELECT target_id FROM swipes WHERE swiper_id = ? AND action = 'like'").all(me).map((r) => r.target_id));
  /* i bloccati (in entrambe le direzioni) non compaiono; privacy e foto sfocate
     sono applicate qui, lato server, per ogni persona */
  const people = page
    .filter((u) => !isBlockedEither(me, u.id))
    .map((u) => ({ ...profileFor(u, me), liked: liked.has(u.id), matched: areMatched(me, u.id) }));
  res.json({ people, next });
});

/* mette "mi piace" (o passa); se il like è reciproco, è un match */
app.post("/api/swipes/:userId", auth, requireVerified, (req, res) => {
  const other = relationTarget(req, res); if (!other) return;
  const me = req.user.id;
  if (isBlockedEither(me, other)) return res.status(403).json({ error: "Azione non disponibile" });
  if (AGE_GATE && !db.prepare("SELECT age_verified FROM users WHERE id = ?").get(other)?.age_verified)
    return res.status(403).json({ error: "Questa persona non ha ancora verificato l'età" });
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
app.get("/api/swipes/likes-me", auth, requireVerified, (req, res) => {
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
app.get("/api/swipes/matches", auth, requireVerified, (req, res) => {
  const me = req.user.id;
  const rows = db.prepare(`
    SELECT s.target_id AS id FROM swipes s
    WHERE s.swiper_id = ? AND s.action = 'like'
      AND EXISTS (SELECT 1 FROM swipes s2 WHERE s2.swiper_id = s.target_id AND s2.target_id = ? AND s2.action = 'like')
    ORDER BY s.created_at DESC
  `).all(me, me);
  res.json(rows.map((r) => userSummary(r.id)).filter((u) => u && !isBlockedEither(me, u.id)));
});

app.get("/api/people/:id", auth, requireVerified, (req, res) => {
  const u = db.prepare("SELECT * FROM users WHERE id = ? AND verified = 1").get(req.params.id);
  if (!u || isBlockedEither(req.user.id, u.id)) return res.status(404).json({ error: "Profilo non disponibile" });
  res.json(profileFor(u, req.user.id));
});

/* ————————————————— FOTO ————————————————— */

/* ogni foto arriva in tre versioni, preparate dal browser di chi la carica:
   "photo" (grande), "thumb" (miniatura per la griglia) e "blur" (minuscola e sfocata,
   l'unica che vedono gli altri se la foto è nascosta). Così la griglia è leggera e
   la sfocatura non è un effetto grafico sopra la foto vera, ma un file diverso. */
const photoUpload = upload.fields([
  { name: "photo", maxCount: 1 },
  { name: "thumb", maxCount: 1 },
  { name: "blur", maxCount: 1 },
]);
const MAX_THUMB_BYTES = 400 * 1024;
const MAX_BLUR_BYTES = 100 * 1024;

function removeUploads(...names) {
  for (const n of names) {
    if (!n) continue;
    const p = path.join(uploadDir, n);
    try { if (fs.existsSync(p)) fs.unlinkSync(p); } catch { /* già rimosso */ }
  }
}

app.post("/api/me/photos", auth, photoUpload, (req, res) => {
  const f = req.files?.photo?.[0];
  const th = req.files?.thumb?.[0];
  const bl = req.files?.blur?.[0];
  const cleanup = () => removeUploads(f?.filename, th?.filename, bl?.filename);

  if (!f) { cleanup(); return res.status(400).json({ error: "Nessun file" }); }
  if ((th && th.size > MAX_THUMB_BYTES) || (bl && bl.size > MAX_BLUR_BYTES)) {
    cleanup();
    return res.status(400).json({ error: "Anteprima troppo grande" });
  }
  const count = db.prepare("SELECT COUNT(*) AS n FROM photos WHERE user_id = ?").get(req.user.id).n;
  if (count >= 6) { cleanup(); return res.status(400).json({ error: "Massimo 6 foto" }); }

  const id = uid();
  db.prepare("INSERT INTO photos (id, user_id, filename, thumb_filename, blur_filename, position, created_at) VALUES (?,?,?,?,?,?,?)")
    .run(id, req.user.id, f.filename, th?.filename || "", bl?.filename || "", count, nowMs());
  io.emit("people-changed");
  res.json({
    id, hidden: false, friends_only: false,
    url: `/uploads/${f.filename}`,
    thumb: `/uploads/${th?.filename || f.filename}`,
  });
});

app.delete("/api/me/photos/:photoId", auth, (req, res) => {
  const photo = db.prepare("SELECT * FROM photos WHERE id = ? AND user_id = ?").get(req.params.photoId, req.user.id);
  if (!photo) return res.status(404).json({ error: "Foto non trovata" });
  db.prepare("DELETE FROM photos WHERE id = ?").run(photo.id);
  removeUploads(photo.filename, photo.thumb_filename, photo.blur_filename);
  io.emit("people-changed");
  res.json({ ok: true });
});

/* "sfocata": se attivo, gli altri vedono di questa foto solo la versione sfocata;
   la vedono nitida solo il titolare e i suoi amici accettati */
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
    let who = null;
    try { who = jwt.verify(token, JWT_SECRET); } catch { who = null; }
    if (!who?.id) return res.status(403).json({ error: "Stanza riservata agli iscritti" });
    if (!isVerified(who.id)) return res.status(403).json(AGE_GATE_ERROR);
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

/* ————————————————— RICHIESTE DI MESSAGGIO / ROSE ————————————————— */

/* Per scrivere a una persona nuova si chiede, e lei accetta o rifiuta:
   - amici, match e richieste già accettate: si scrive direttamente
   - altrimenti: richiesta gratuita, oppure — se la persona ha attivato "DM privati" —
     solo con una rosa (richiesta con priorità, a pagamento)
   La rosa compra la priorità, non l'accesso: la persona decide sempre. Se rifiuta,
   non si può riprovare (né a pagamento) e la rosa non viene restituita. */
app.post("/api/dm-requests/:userId", auth, requireVerified, (req, res) => {
  const other = relationTarget(req, res); if (!other) return;
  const me = req.user.id;
  if (isBlockedEither(me, other)) return res.status(403).json({ error: "Azione non disponibile" });
  const target = db.prepare("SELECT * FROM users WHERE id = ?").get(other);
  if (AGE_GATE && !target.age_verified)
    return res.status(403).json({ error: "Questa persona non ha ancora verificato l'età" });
  const rose = !!req.body?.rose;

  /* già possibile scrivere: apro il canale e basta */
  if (canOpenDirect(me, other)) {
    const dm = openDmChannel(me, other, me);
    return res.json({ ok: true, dm });
  }

  const outgoing = getRequest(me, other);
  if (outgoing?.status === "pending") return res.status(409).json({ error: "Hai già inviato una richiesta a questa persona" });
  if (outgoing?.status === "declined") return res.status(403).json({ error: "Questa persona non ha accettato la tua richiesta" });

  /* mi aveva già chiesto lei/lui: l'intenzione è reciproca, si apre subito */
  const incoming = getRequest(other, me);
  if (incoming?.status === "pending") {
    db.prepare("UPDATE dm_requests SET status = 'accepted' WHERE from_id = ? AND to_id = ?").run(other, me);
    const dm = openDmChannel(me, other);
    notifyUser(other, "dm-request-accepted"); notifyUser(me, "dm-request-accepted");
    return res.json({ ok: true, dm, accepted: true });
  }

  if (target.dm_private && !rose)
    return res.status(403).json({ error: "Questa persona accetta messaggi solo con una rosa", code: "ROSE_REQUIRED" });

  /* anti-spam: un numero massimo di richieste nuove al giorno */
  const recent = db.prepare("SELECT COUNT(*) AS n FROM dm_requests WHERE from_id = ? AND created_at > ?")
    .get(me, nowMs() - 24 * 60 * 60 * 1000).n;
  if (recent >= MAX_REQUESTS_PER_DAY)
    return res.status(429).json({ error: "Hai raggiunto il limite di richieste di oggi, riprova domani" });

  const ok = db.transaction(() => {
    if (rose) {
      const u = db.prepare("SELECT tokens FROM users WHERE id = ?").get(me);
      if ((u?.tokens || 0) < ROSE_COST) return false;
      db.prepare("UPDATE users SET tokens = tokens - ? WHERE id = ?").run(ROSE_COST, me);
    }
    db.prepare("INSERT INTO dm_requests (from_id, to_id, status, rose, cost, created_at) VALUES (?,?,?,?,?,?)")
      .run(me, other, "pending", rose ? 1 : 0, rose ? ROSE_COST : 0, nowMs());
    return true;
  })();
  if (!ok) return res.status(402).json({ error: "Saldo insufficiente per inviare una rosa" });

  notifyUser(other, "dm-request-received");
  const tokens = db.prepare("SELECT tokens FROM users WHERE id = ?").get(me).tokens;
  res.json({ ok: true, requested: true, rose, tokens });
});

/* le richieste che ho ricevuto (le rose in cima) e a chi ne ho inviata una */
app.get("/api/dm-requests", auth, (req, res) => {
  const me = req.user.id;
  const incoming = db.prepare("SELECT * FROM dm_requests WHERE to_id = ? AND status = 'pending' ORDER BY rose DESC, created_at DESC").all(me)
    .map((r) => ({ from: userSummary(r.from_id), rose: !!r.rose, created_at: r.created_at }))
    .filter((r) => r.from && !isBlockedEither(me, r.from.id));
  const outgoing = db.prepare("SELECT to_id FROM dm_requests WHERE from_id = ? AND status = 'pending'").all(me).map((r) => r.to_id);
  res.json({ incoming, outgoing });
});

app.post("/api/dm-requests/:userId/accept", auth, requireVerified, (req, res) => {
  const other = relationTarget(req, res); if (!other) return;
  const me = req.user.id;
  if (isBlockedEither(me, other)) return res.status(403).json({ error: "Azione non disponibile" });
  const r = getRequest(other, me);
  if (!r || r.status !== "pending") return res.status(404).json({ error: "Nessuna richiesta da accettare" });
  db.prepare("UPDATE dm_requests SET status = 'accepted' WHERE from_id = ? AND to_id = ?").run(other, me);
  const dm = openDmChannel(me, other);
  notifyUser(other, "dm-request-accepted"); notifyUser(me, "dm-request-accepted");
  res.json({ ok: true, dm });
});

/* rifiuto silenzioso: chi ha inviato la richiesta non riceve nessun avviso */
app.post("/api/dm-requests/:userId/decline", auth, (req, res) => {
  const other = relationTarget(req, res); if (!other) return;
  const r = getRequest(other, req.user.id);
  if (!r || r.status !== "pending") return res.status(404).json({ error: "Nessuna richiesta da rifiutare" });
  db.prepare("UPDATE dm_requests SET status = 'declined' WHERE from_id = ? AND to_id = ?").run(other, req.user.id);
  notifyUser(req.user.id, "dm-request-accepted"); // solo per far ricaricare l'elenco a chi ha rifiutato
  res.json({ ok: true });
});

/* ————————————————— DM ————————————————— */

/* apre una conversazione: possibile subito solo con amici, match o richieste
   accettate; con tutti gli altri bisogna passare dalla richiesta */
app.post("/api/dms/:otherUserId", auth, requireVerified, (req, res) => {
  const other = db.prepare("SELECT id FROM users WHERE id = ? AND verified = 1").get(req.params.otherUserId);
  if (!other) return res.status(404).json({ error: "Utente non trovato" });
  if (other.id === req.user.id) return res.status(400).json({ error: "Non puoi scrivere a te stesso" });
  if (isBlockedEither(req.user.id, other.id))
    return res.status(403).json({ error: "Non puoi scrivere a questo utente." });
  const existing = getDm(req.user.id, other.id);
  if (existing) return res.json(existing);
  if (!canOpenDirect(req.user.id, other.id))
    return res.status(403).json({ error: "Per scrivere a questa persona serve prima una richiesta.", code: "REQUEST_REQUIRED" });
  res.json(openDmChannel(req.user.id, other.id, req.user.id));
});

/* le mie conversazioni: quelle aperte da me o da entrambi, più quelle in cui
   qualcuno mi ha già scritto */
app.get("/api/dms", auth, (req, res) => {
  const me = req.user.id;
  const list = db.prepare(`
    SELECT d.*,
      (SELECT COUNT(*) FROM messages m WHERE m.room_id = d.id) AS msg_count,
      (SELECT MAX(m.created_at) FROM messages m WHERE m.room_id = d.id) AS last_at
    FROM dms d WHERE d.user_a = ? OR d.user_b = ?
  `).all(me, me);
  const enriched = list
    .filter((dm) => dm.creator_id === me || dm.creator_id === "both" || dm.msg_count > 0)
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
      if (room.access === "members" && !isVerified(socket.data.user.id))
        return socket.emit("errorMsg", AGE_GATE_ERROR.error);
    }
    socket.join(roomId);
  });

  socket.on("message", ({ roomId, text, image, sensitive }) => {
    if (typeof roomId !== "string") return;
    /* i guest sono solo lettura, in ogni stanza e in ogni conversazione */
    if (socket.data.guest) return socket.emit("errorMsg", "Registrati per scrivere");
    const userId = socket.data.user.id;
    const isDm = roomId.startsWith("dm-");
    let dmRow = null;

    if (isDm) {
      /* messaggi privati: solo tra partecipanti, mai con un bloccato, e (con il
         gate attivo) solo da chi ha verificato l'età */
      if (!isVerified(userId)) return socket.emit("errorMsg", AGE_GATE_ERROR.error);
      dmRow = db.prepare("SELECT * FROM dms WHERE id = ?").get(roomId);
      if (!dmRow || (dmRow.user_a !== userId && dmRow.user_b !== userId))
        return socket.emit("errorMsg", "DM non trovata");
      const otherId = dmRow.user_a === userId ? dmRow.user_b : dmRow.user_a;
      if (isBlockedEither(userId, otherId))
        return socket.emit("errorMsg", "Non puoi inviare messaggi a questo utente.");
    } else {
      const room = db.prepare("SELECT * FROM rooms WHERE id = ?").get(roomId);
      if (!room) return;
      if (room.access === "members" && !isVerified(userId))
        return socket.emit("errorMsg", AGE_GATE_ERROR.error);
    }

    const u = db.prepare("SELECT name, handle, avatar FROM users WHERE id = ?").get(userId);
    const msg = {
      id: uid(), room_id: roomId, user_id: userId,
      text: String(text || "").slice(0, 2000),
      image: image || null, sensitive: sensitive ? 1 : 0,
      created_at: nowMs(),
    };
    db.prepare("INSERT INTO messages (id, room_id, user_id, text, image, sensitive, created_at) VALUES (?,?,?,?,?,?,?)")
      .run(msg.id, msg.room_id, msg.user_id, msg.text, msg.image, msg.sensitive, msg.created_at);
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
  console.log(AGE_GATE
    ? "Verifica età ATTIVA: Persone, richieste/DM e stanza rosa richiedono la verifica."
    : "⚠ Verifica età NON attiva (nessun Yoti configurato): Persone, DM e stanza rosa sono aperti a tutti i registrati.");
  console.log(process.env.DATA_DIR
    ? `Dati salvati in ${DATA_DIR} (disco persistente: gli account restano dopo riavvii e deploy)`
    : "⚠ DATA_DIR non impostata: database e foto stanno su disco temporaneo e si cancellano a ogni riavvio/deploy");
  if (!RESEND_API_KEY) console.log("⚠ RESEND_API_KEY non impostata: i codici email vengono stampati qui nel log");
  if (JWT_SECRET === "cambiami-in-produzione") console.log("⚠ JWT_SECRET di default: impostane uno vero prima di andare online");
});
