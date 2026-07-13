# Foyer — guida per andare online con ~10 tester

## Cosa hai in mano
- **Frontend**: `foyer-chat-v3.jsx` (React) — ora è una demo con dati finti
- **Backend**: questa cartella (`server.js`) — API vere: registrazione con email, login, profili, foto, stanze, chat in tempo reale, DM, like ai prompt

## Cosa ti serve (tutto gratis per 10 tester)

| Cosa | Servizio consigliato | Costo |
|---|---|---|
| Hosting backend | Render.com o Railway.app | gratis (free tier) |
| Hosting frontend | Vercel.com o Netlify | gratis |
| Invio email di verifica | Resend.com | gratis fino a 100 mail/giorno |
| Dominio (facoltativo) | Namecheap/Cloudflare | ~10€/anno, puoi saltarlo |

## Passi, in ordine

### 1. Prepara il frontend come progetto vero
La demo `.jsx` va inserita in un progetto React reale:
```bash
npm create vite@latest foyer-app -- --template react
cd foyer-app && npm install
# copia il componente in src/App.jsx
# installa tailwind seguendo tailwindcss.com/docs/installation/using-vite
```
Poi vanno sostituiti i dati finti con chiamate alle API del backend
(fetch verso /api/... e socket.io-client per la chat). Questo è il
lavoro di integrazione più consistente rimasto: la demo usa stato
in-memory, il prodotto vero deve leggere/scrivere dal server.

### 2. Metti online il backend
1. Crea un repository GitHub e carica questa cartella
2. Su Render.com: New → Web Service → collega il repo
3. Build command: `npm install` — Start command: `npm start`
4. Imposta le variabili d'ambiente:
   - `JWT_SECRET` → una frase lunga e casuale (generane una: `openssl rand -hex 32`)
   - `RESEND_API_KEY` → la chiave presa da resend.com (registrati, è immediato)
   - `FRONTEND_URL` → l'URL del frontend (lo avrai al passo 3), es. `https://foyer.vercel.app`
5. Deploy → ottieni un URL tipo `https://foyer-backend.onrender.com`

**Nota SQLite su Render free**: il filesystem è effimero, il database si azzera
ad ogni redeploy. Per 10 tester va bene per un weekend di test; per qualcosa
di più stabile aggiungi un "Persistent Disk" (a pagamento, ~7$/mese) oppure
migra su Postgres gratuito (Neon.tech o Supabase).

### 3. Metti online il frontend
1. Carica il progetto Vite su GitHub
2. Su Vercel: Add New → Project → importa il repo → Deploy
3. Nelle env del frontend metti l'URL del backend (es. `VITE_API_URL=https://foyer-backend.onrender.com`)

### 4. Email di verifica
- Registrati su resend.com → API Keys → crea una chiave
- Senza dominio proprio puoi inviare da `onboarding@resend.dev` (ok per i test)
- Con un dominio tuo: verificalo su Resend e cambia il campo `from` in server.js

### 5. Invita i 10 tester
Manda loro il link Vercel. Si registrano con la loro email vera,
ricevono il codice, entrano.

## Cosa NON è ancora coperto (da sapere prima di andare oltre i test)
- **Moderazione immagini vera**: il filtro attuale è un'euristica client-side.
  Per un pubblico reale serve un servizio server-side (AWS Rekognition,
  Google Vision, Hive) che analizzi le foto PRIMA di salvarle
- **Privacy/GDPR**: se raccogli email e foto di utenti reali in UE servono
  privacy policy, base giuridica, possibilità di cancellare l'account.
  Per 10 amici che sanno di testare è tollerabile, per il pubblico no
- **Termini di servizio e verifica età reale**: la checkbox 18+ è
  autodichiarazione, per un prodotto vero valuta soluzioni più solide
- **Backup del database** e **rate limiting** sulle API (per i test va bene così)
- **HTTPS**: Render e Vercel lo danno già di default, nulla da fare

## Test in locale (prima di deployare)
```bash
cd foyer-backend
npm install
JWT_SECRET=test npm start
# senza RESEND_API_KEY i codici email appaiono nel terminale
```
API su http://localhost:3001 — il frontend in dev punta lì.
