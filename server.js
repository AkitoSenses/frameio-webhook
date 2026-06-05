const express = require("express");
const fetch   = require("node-fetch");

const app = express();
app.use(express.json());

// ─── CONFIG ───────────────────────────────────────────
// Ces valeurs sont lues depuis les variables d'environnement
const FRAMEIO_TOKEN = process.env.FRAMEIO_TOKEN; // token Frame.io V4
const SLACK_TOKEN   = process.env.SLACK_TOKEN;   // token Slack Bot
const PORT          = process.env.PORT || 3000;

// ─── RÈGLES DE ROUTING ────────────────────────────────
// Détecte le dossier cible selon le nom du fichier
function detectFolder(filename) {
  const name = filename.toUpperCase().replace(/\.[^/.]+$/, ""); // sans extension

  // DELIVERY : commence par LIVRAISON_
  if (name.startsWith("LIVRAISON_")) return "06. DELIVERY";

  // FINALISATION : CONFO ou FINALISATION
  if (/CONFO|FINALISATION/.test(name)) return "05. FINALISATION";

  // GRADING
  if (/GRADING|_GRADE|_LUT/.test(name)) return "04. GRADING";

  // 3D / VFX
  if (/\b3D\b|_VFX|_COMPO/.test(name)) return "03. 3D";

  // ALL RUSHES
  if (/ALLRUSHES|ALL_RUSHES|DERUSH|RUSHES/.test(name)) return "01. ALL RUSHES-DERUSH";

  // Par défaut : EDIT
  return "02. EDIT";
}

// Extrait la clé projet depuis le nom de fichier (2 premiers segments séparés par _)
function extractProjectKey(filename) {
  const name = filename.replace(/\.[^/.]+$/, ""); // sans extension
  return name.split("_").slice(0, 2).join("_");
}

// Normalise un nom pour la comparaison (accents, casse, tirets)
function normalize(str) {
  return str.toLowerCase()
    .replace(/[éèêë]/g, "e").replace(/[àâä]/g, "a").replace(/[ùûü]/g, "u")
    .replace(/[îï]/g, "i").replace(/[ôö]/g, "o").replace(/ç/g, "c")
    .replace(/[^a-z0-9]/g, "");
}

// Date du jour au format AAMMDD
function todayStr() {
  const d = new Date();
  return String(d.getFullYear()).slice(-2) +
    String(d.getMonth() + 1).padStart(2, "0") +
    String(d.getDate()).padStart(2, "0");
}

// ─── FRAME.IO V4 API ─────────────────────────────────
const FIO_BASE = "https://api.frame.io/v4";

async function fioFetch(endpoint, options = {}) {
  const resp = await fetch(`${FIO_BASE}${endpoint}`, {
    ...options,
    headers: {
      "Authorization": `Bearer ${FRAMEIO_TOKEN}`,
      "Content-Type": "application/json",
      ...(options.headers || {})
    }
  });
  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`Frame.io ${resp.status}: ${text}`);
  }
  return resp.json();
}

// Trouve un projet par nom (recherche floue sur la clé projet)
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

// Trouve un dossier enfant par nom dans un dossier parent
async function findFolder(parentId, name) {
  const resp = await fioFetch(`/folders/${parentId}/children?filter[type]=folder`);
  const list = resp.data || resp;
  return list.find(f => f.name === name) || null;
}

// Crée un dossier enfant
async function createFolder(parentId, name) {
  const resp = await fioFetch(`/folders/${parentId}/children`, {
    method: "POST",
    body: JSON.stringify({ name, type: "folder" })
  });
  return resp.data || resp;
}

// Trouve ou crée un dossier
async function findOrCreate(parentId, name) {
  const existing = await findFolder(parentId, name);
  if (existing) return existing;
  return await createFolder(parentId, name);
}

// Déplace un asset vers un dossier cible
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
  if (!data.ok) throw new Error(`Slack channels: ${data.error}`);
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
  return data;
}

// Trouve le channel Slack correspondant au projet
async function findSlackChannel(projectKey) {
  const channels = await getSlackChannels();
  const key = normalize(projectKey);
  return channels.find(ch => {
    const chKey = normalize(ch.name);
    return chKey.includes(key) || key.includes(chKey);
  }) || null;
}

// ─── WEBHOOK HANDLER ─────────────────────────────────
app.post("/webhook", async (req, res) => {
  // Répond immédiatement pour éviter le timeout Frame.io
  res.status(200).json({ ok: true });

  const event = req.body;
  console.log("Webhook reçu:", JSON.stringify(event, null, 2));

  // Ne traite que les événements d'upload terminé
  const eventType = event.type || event.event_type;
  if (!eventType || !eventType.includes("asset")) {
    console.log("Événement ignoré:", eventType);
    return;
  }

  // Extrait les données de l'asset
  const asset      = event.data || event.asset || event.resource || {};
  const assetId    = asset.id;
  const assetName  = asset.name;
  const assetType  = asset.type;

  if (!assetName || assetType === "folder") {
    console.log("Pas un fichier vidéo, ignoré");
    return;
  }

  console.log(`Traitement: ${assetName} (${assetId})`);

  try {
    // 1. Détecte le projet depuis le nom du fichier
    const projectKey  = extractProjectKey(assetName);
    const targetFolder = detectFolder(assetName);
    const today        = todayStr();

    console.log(`Projet détecté: ${projectKey}`);
    console.log(`Dossier cible: ${targetFolder} / ${today}`);

    // 2. Trouve le projet Frame.io
    const project = await findProject(projectKey);
    if (!project) {
      console.warn(`Projet Frame.io introuvable pour: ${projectKey}`);
      return;
    }
    console.log(`Projet Frame.io trouvé: ${project.name} (${project.id})`);

    // 3. Navigue dans l'arborescence : projet → dossier → date
    const rootId    = project.root_asset_id || project.id;
    const folderObj = await findOrCreate(rootId, targetFolder);
    const dateObj   = await findOrCreate(folderObj.id, today);

    console.log(`Dossier cible créé/trouvé: ${targetFolder}/${today} (${dateObj.id})`);

    // 4. Déplace l'asset si nécessaire
    if (asset.parent_id !== dateObj.id) {
      await moveAsset(assetId, dateObj.id);
      console.log(`Asset déplacé vers ${targetFolder}/${today}`);
    }

    // 5. Construit le lien de review
    const reviewLink = `https://app.frame.io/reviews/${assetId}`;

    // 6. Trouve le channel Slack et envoie la notification
    const slackChannel = await findSlackChannel(projectKey);
    if (!slackChannel) {
      console.warn(`Channel Slack introuvable pour: ${projectKey}`);
      return;
    }

    const message = `Voici le lien de la vidéo : ${assetName}\n${reviewLink}`;
    await sendSlack(slackChannel.id, message);
    console.log(`Slack notifié: #${slackChannel.name}`);

  } catch(e) {
    console.error("Erreur traitement webhook:", e.message);
  }
});

// Health check
app.get("/", (req, res) => {
  res.json({ status: "ok", service: "frameio-webhook" });
});

app.listen(PORT, () => {
  console.log(`Serveur webhook démarré sur le port ${PORT}`);
});
