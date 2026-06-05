const express = require("express");
const fetch   = require("node-fetch");
const crypto  = require("crypto");
const fs      = require("fs");
const path    = require("path");

const app = express();
app.use(express.json());

// ─── CONFIG ───────────────────────────────────────────
const SLACK_TOKEN    = process.env.SLACK_TOKEN;
const PORT           = process.env.PORT || 3000;
const CLIENT_ID      = "85bccc906ca944d9a271d04f798e0bde";
const CLIENT_SECRET  = process.env.CLIENT_SECRET;
const REDIRECT_URI   = "https://frameio-webhook-production.up.railway.app/callback";
const TOKEN_FILE     = "/tmp/frameio_tokens.json";

// Stockage token en mémoire + fichier
let tokens = {};
try { if (fs.existsSync(TOKEN_FILE)) tokens = JSON.parse(fs.readFileSync(TOKEN_FILE)); } catch(e) {}

function saveTokens() {
  try { fs.writeFileSync(TOKEN_FILE, JSON.stringify(tokens)); } catch(e) {}
}

// PKCE
const codeVerifiers = {};
function genVerifier()  { return crypto.randomBytes(32).toString("base64url"); }
function genChallenge(v){ return crypto.createHash("sha256").update(v).digest("base64url"); }

// ─── OAUTH ROUTES ─────────────────────────────────────

// Page d'accueil avec bouton login
app.get("/", (req, res) => {
  const isLoggedIn = tokens.access_token && tokens.expiry > Date.now();
  res.send(`
    <html>
    <head>
      <title>Frame.io Webhook</title>
      <style>
        body { font-family: -apple-system, sans-serif; padding: 40px; background: #1e1e1e; color: #fff; max-width: 600px; margin: 0 auto; }
        h1 { color: #0d99ff; }
        .status { padding: 12px 16px; border-radius: 8px; margin: 20px 0; }
        .ok  { background: #1d9e7522; border: 1px solid #1d9e75; color: #6fcf97; }
        .err { background: #eb575722; border: 1px solid #eb5757; color: #eb5757; }
        a.btn { display: inline-block; padding: 12px 24px; background: #0d99ff; color: #fff; border-radius: 8px; text-decoration: none; font-weight: 600; margin-top: 16px; }
        a.btn:hover { background: #0077cc; }
        code { background: #333; padding: 2px 6px; border-radius: 4px; font-size: 13px; }
      </style>
    </head>
    <body>
      <h1>Frame.io Webhook Server</h1>
      ${isLoggedIn
        ? `<div class="status ok">✓ Connecté à Adobe / Frame.io — token valide</div>`
        : `<div class="status err">✗ Non connecté — clique sur le bouton pour te connecter</div>`
      }
      <a class="btn" href="/login">Se connecter avec Adobe</a>
      <hr style="border-color:#333;margin:30px 0">
      <h3>Webhook URL</h3>
      <p>Configure cette URL dans Frame.io → Settings → Webhooks :</p>
      <code>https://frameio-webhook-production.up.railway.app/webhook</code>
      <p style="margin-top:16px;color:#888;font-size:13px">Event à sélectionner : <strong>asset.ready</strong></p>
    </body>
    </html>
  `);
});

// Lance le flux OAuth Adobe
app.get("/login", (req, res) => {
  const verifier  = genVerifier();
  const challenge = genChallenge(verifier);
  const state     = crypto.randomBytes(8).toString("hex");

  // Stocke le verifier associé au state
  codeVerifiers[state] = verifier;

  // Nettoie les vieux states après 10 min
  setTimeout(() => delete codeVerifiers[state], 600000);

  const url = new URL("https://ims-na1.adobelogin.com/ims/authorize/v2");
  url.searchParams.set("client_id",             CLIENT_ID);
  url.searchParams.set("redirect_uri",          REDIRECT_URI);
  url.searchParams.set("response_type",         "code");
  url.searchParams.set("scope",                 "openid,profile,email,offline_access");
  url.searchParams.set("state",                 state);
  url.searchParams.set("code_challenge",        challenge);
  url.searchParams.set("code_challenge_method", "S256");

  res.redirect(url.toString());
});

// Reçoit le code OAuth et l'échange contre un token
app.get("/callback", async (req, res) => {
  const { code, state, error } = req.query;

  if (error) {
    return res.send(`<html><body style="font-family:sans-serif;padding:40px;background:#1e1e1e;color:#eb5757"><h2>Erreur : ${error}</h2><a href="/" style="color:#0d99ff">Retour</a></body></html>`);
  }

  if (!code) {
    return res.send(`<html><body style="font-family:sans-serif;padding:40px;background:#1e1e1e;color:#eb5757"><h2>Code manquant</h2><a href="/" style="color:#0d99ff">Retour</a></body></html>`);
  }

  const verifier = codeVerifiers[state];
  if (!verifier) {
    return res.status(400).send("State invalide ou expiré");
  }
  delete codeVerifiers[state];

  try {
    // Échange le code contre un token
    const tokenResp = await fetch("https://ims-na1.adobelogin.com/ims/token/v3", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type:    "authorization_code",
        client_id:     CLIENT_ID,
        client_secret: CLIENT_SECRET,
        code,
        redirect_uri:  REDIRECT_URI,
        code_verifier: verifier
      })
    });

    if (!tokenResp.ok) {
      const err = await tokenResp.text();
      throw new Error(`Token exchange : ${err}`);
    }

    const data = await tokenResp.json();
    tokens.access_token  = data.access_token;
    tokens.refresh_token = data.refresh_token;
    tokens.expiry        = Date.now() + data.expires_in * 1000;
    saveTokens();

    res.send(`
      <html>
      <head><title>Connexion réussie</title></head>
      <body style="font-family:-apple-system,sans-serif;padding:40px;background:#1e1e1e;color:#fff;text-align:center">
        <h2 style="color:#6fcf97">✓ Connexion réussie !</h2>
        <p>Le serveur est maintenant connecté à Frame.io.</p>
        <p style="margin-top:20px"><a href="/" style="color:#0d99ff">Retour au dashboard</a></p>
      </body>
      </html>
    `);
  } catch(e) {
    res.send(`<html><body style="font-family:sans-serif;padding:40px;background:#1e1e1e;color:#eb5757"><h2>Erreur : ${e.message}</h2><a href="/" style="color:#0d99ff">Retour</a></body></html>`);
  }
});

// Rafraîchit le token si nécessaire
async function getValidToken() {
  if (tokens.access_token && tokens.expiry > Date.now() + 300000) {
    return tokens.access_token;
  }
  if (!tokens.refresh_token) return null;
  try {
    const r = await fetch("https://ims-na1.adobelogin.com/ims/token/v3", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type:    "refresh_token",
        client_id:     CLIENT_ID,
        client_secret: CLIENT_SECRET,
        refresh_token: tokens.refresh_token
      })
    });
    if (!r.ok) return null;
    const d = await r.json();
    tokens.access_token  = d.access_token;
    tokens.refresh_token = d.refresh_token || tokens.refresh_token;
    tokens.expiry        = Date.now() + d.expires_in * 1000;
    saveTokens();
    return d.access_token;
  } catch(e) { return null; }
}

// ─── RÈGLES DE ROUTING ────────────────────────────────
function detectFolder(filename) {
  const name = filename.toUpperCase().replace(/\.[^/.]+$/, "");
  if (name.startsWith("LIVRAISON_"))          return "06. DELIVERY";
  if (/CONFO|FINALISATION/.test(name))        return "05. FINALISATION";
  if (/GRADING|_GRADE|_LUT/.test(name))       return "04. GRADING";
  if (/\b3D\b|_VFX|_COMPO/.test(name))        return "03. 3D";
  if (/ALLRUSHES|ALL_RUSHES|DERUSH|RUSHES/.test(name)) return "01. ALL RUSHES-DERUSH";
  return "02. EDIT";
}

function extractProjectKey(filename) {
  return filename.replace(/\.[^/.]+$/, "").split("_").slice(0, 2).join("_");
}

function normalize(str) {
  return str.toLowerCase()
    .replace(/[éèêë]/g,"e").replace(/[àâä]/g,"a").replace(/[ùûü]/g,"u")
    .replace(/[îï]/g,"i").replace(/[ôö]/g,"o").replace(/ç/g,"c")
    .replace(/[^a-z0-9]/g,"");
}

function todayStr() {
  const d = new Date();
  return String(d.getFullYear()).slice(-2) +
    String(d.getMonth()+1).padStart(2,"0") +
    String(d.getDate()).padStart(2,"0");
}

// ─── FRAME.IO V4 API ─────────────────────────────────
const FIO_BASE = "https://api.frame.io/v4";

async function fioFetch(endpoint, options = {}) {
  const token = await getValidToken();
  if (!token) throw new Error("Non connecté — va sur https://frameio-webhook-production.up.railway.app pour te connecter");
  const resp = await fetch(`${FIO_BASE}${endpoint}`, {
    ...options,
    headers: {
      "Authorization": `Bearer ${token}`,
      "Content-Type": "application/json",
      ...(options.headers || {})
    }
  });
  if (!resp.ok) throw new Error(`Frame.io ${resp.status}: ${await resp.text()}`);
  return resp.json();
}

async function findProject(projectKey) {
  const accountsResp = await fioFetch("/accounts");
  const accounts = accountsResp.data || accountsResp;
  for (const acc of accounts) {
    const projResp = await fioFetch(`/accounts/${acc.id}/projects`);
    const projects = projResp.data || projResp;
    for (const p of projects) {
      if (normalize(p.name).includes(normalize(projectKey)) ||
          normalize(projectKey).includes(normalize(p.name))) {
        return p;
      }
    }
  }
  return null;
}

async function findFolder(parentId, name) {
  const resp = await fioFetch(`/folders/${parentId}/children?filter[type]=folder`);
  const list = resp.data || resp;
  return list.find(f => f.name === name) || null;
}

async function createFolder(parentId, name) {
  const resp = await fioFetch(`/folders/${parentId}/children`, {
    method: "POST",
    body: JSON.stringify({ name, type: "folder" })
  });
  return resp.data || resp;
}

async function findOrCreate(parentId, name) {
  const existing = await findFolder(parentId, name);
  if (existing) return existing;
  return await createFolder(parentId, name);
}

async function moveAsset(assetId, targetFolderId) {
  return fioFetch(`/assets/${assetId}`, {
    method: "PATCH",
    body: JSON.stringify({ parent_id: targetFolderId })
  });
}

// ─── SLACK API ────────────────────────────────────────
async function getSlackChannels() {
  const resp = await fetch("https://slack.com/api/conversations.list?limit=200&exclude_archived=true&types=public_channel,private_channel", {
    headers: { "Authorization": `Bearer ${SLACK_TOKEN}` }
  });
  const data = await resp.json();
  if (!data.ok) throw new Error(`Slack: ${data.error}`);
  return data.channels || [];
}

async function sendSlack(channelId, message) {
  const resp = await fetch("https://slack.com/api/chat.postMessage", {
    method: "POST",
    headers: { "Authorization": `Bearer ${SLACK_TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify({ channel: channelId, text: message })
  });
  const data = await resp.json();
  if (!data.ok) throw new Error(`Slack send: ${data.error}`);
}

async function findSlackChannel(projectKey) {
  const channels = await getSlackChannels();
  const key = normalize(projectKey);
  return channels.find(ch => {
    const chKey = normalize(ch.name);
    return chKey.includes(key) || key.includes(chKey);
  }) || null;
}

// ─── WEBHOOK ─────────────────────────────────────────
app.post("/webhook", async (req, res) => {
  res.status(200).json({ ok: true });

  const event     = req.body;
  const eventType = event.type || event.event_type || "";
  console.log("Webhook:", eventType, JSON.stringify(event).slice(0, 200));

  if (!eventType.includes("asset")) return;

  const asset     = event.data || event.asset || event.resource || {};
  const assetId   = asset.id;
  const assetName = asset.name;

  if (!assetName || asset.type === "folder") return;

  console.log(`Traitement: ${assetName}`);

  try {
    const projectKey   = extractProjectKey(assetName);
    const targetFolder = detectFolder(assetName);
    const today        = todayStr();

    const project = await findProject(projectKey);
    if (!project) { console.warn(`Projet introuvable: ${projectKey}`); return; }

    const rootId    = project.root_asset_id || project.id;
    const folderObj = await findOrCreate(rootId, targetFolder);
    const dateObj   = await findOrCreate(folderObj.id, today);

    if (asset.parent_id !== dateObj.id) {
      await moveAsset(assetId, dateObj.id);
    }

    const reviewLink   = `https://app.frame.io/reviews/${assetId}`;
    const slackChannel = await findSlackChannel(projectKey);

    if (slackChannel) {
      await sendSlack(slackChannel.id, `Voici le lien de la vidéo : ${assetName}\n${reviewLink}`);
      console.log(`Slack notifié: #${slackChannel.name}`);
    } else {
      console.warn(`Channel Slack introuvable: ${projectKey}`);
    }

  } catch(e) {
    console.error("Erreur:", e.message);
  }
});

app.listen(PORT, () => console.log(`Serveur démarré sur le port ${PORT}`));
