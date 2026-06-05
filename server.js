// ============================================================
// Frame.io V4 Webhook Server
// Events : file.ready
// Actions : lookup file → range dans dossier AAMMDD → notify Slack
// ============================================================

const express = require("express");
const app     = express();
const PORT    = process.env.PORT || 3000;

// ── Variables d'environnement ──────────────────────────────
const FRAMEIO_TOKEN = process.env.FRAMEIO_TOKEN; // OAuth V4 Bearer token
const SLACK_TOKEN   = process.env.SLACK_TOKEN;   // xoxb-...

app.use(express.json());

// ── Helpers date ──────────────────────────────────────────
function todayStr() {
  const d  = new Date();
  const yy = String(d.getFullYear()).slice(2);
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return yy + mm + dd; // AAMMDD
}

// ── Détection du dossier cible depuis le nom de fichier ──
function detectFolder(name) {
  const n = name.toUpperCase();
  if (n.startsWith("LIVRAISON_"))                         return "06. DELIVERY";
  if (n.includes("CONFO") || n.includes("FINALISATION")) return "05. FINALISATION";
  if (n.includes("GRADING") || n.includes("GRADE") || n.includes("LUT")) return "04. GRADING";
  if (n.includes("3D") || n.includes("VFX") || n.includes("COMPO"))      return "03. 3D";
  if (n.includes("ALLRUSHES") || n.includes("DERUSH") || n.includes("RUSHES")) return "01. ALL RUSHES-DERUSH";
  return "02. EDIT";
}

// ── Extraction de la clé projet depuis le nom de fichier ─
// Ex: "CONDE-NAST_GQ-SANTOS_240601_v2.mov" → "CONDE-NAST_GQ-SANTOS"
function extractProjectKey(name) {
  const parts = name.replace(/\.[^.]+$/, "").split("_");
  if (parts.length >= 2) return `${parts[0]}_${parts[1]}`;
  return parts[0];
}

// ── API Frame.io V4 ───────────────────────────────────────

// Récupère les détails d'un fichier par son ID
async function getFileDetails(fileId) {
  const res = await fetch(`https://api.frame.io/v4/files/${fileId}`, {
    headers: { Authorization: `Bearer ${FRAMEIO_TOKEN}` }
  });
  if (!res.ok) throw new Error(`Frame.io getFile ${res.status}: ${await res.text()}`);
  return res.json();
}

// Liste les enfants d'un dossier (folder_id)
async function listChildren(folderId) {
  const res = await fetch(`https://api.frame.io/v4/folders/${folderId}/children`, {
    headers: { Authorization: `Bearer ${FRAMEIO_TOKEN}` }
  });
  if (!res.ok) throw new Error(`Frame.io listChildren ${res.status}`);
  const data = await res.json();
  return data.items || data || [];
}

// Crée un sous-dossier
async function createFolder(parentId, name) {
  const res = await fetch(`https://api.frame.io/v4/folders`, {
    method:  "POST",
    headers: {
      Authorization:  `Bearer ${FRAMEIO_TOKEN}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({ name, parent_id: parentId })
  });
  if (!res.ok) throw new Error(`Frame.io createFolder ${res.status}: ${await res.text()}`);
  return res.json();
}

// Trouve ou crée un sous-dossier par nom
async function findOrCreate(parentId, folderName) {
  const children = await listChildren(parentId);
  const existing = children.find(c => c.type === "folder" && c.name === folderName);
  if (existing) return existing;
  return createFolder(parentId, folderName);
}

// Déplace un fichier vers un dossier
async function moveFile(fileId, targetFolderId) {
  const res = await fetch(`https://api.frame.io/v4/files/${fileId}`, {
    method:  "PATCH",
    headers: {
      Authorization:  `Bearer ${FRAMEIO_TOKEN}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({ parent_id: targetFolderId })
  });
  if (!res.ok) throw new Error(`Frame.io moveFile ${res.status}: ${await res.text()}`);
  return res.json();
}

// Récupère les projets du workspace
async function listProjects(accountId, workspaceId) {
  const res = await fetch(
    `https://api.frame.io/v4/accounts/${accountId}/workspaces/${workspaceId}/projects`,
    { headers: { Authorization: `Bearer ${FRAMEIO_TOKEN}` } }
  );
  if (!res.ok) throw new Error(`Frame.io listProjects ${res.status}`);
  const data = await res.json();
  return data.items || data || [];
}

// Trouve le projet correspondant à la clé (matching insensible casse)
async function findProject(accountId, workspaceId, projectKey) {
  const projects = await listProjects(accountId, workspaceId);
  const key = projectKey.toUpperCase().replace(/[^A-Z0-9]/g, "");
  return projects.find(p => {
    const name = p.name.toUpperCase().replace(/[^A-Z0-9]/g, "");
    return name.includes(key) || key.includes(name.slice(0, 8));
  });
}

// ── API Slack ─────────────────────────────────────────────

async function findSlackChannel(projectKey) {
  const res = await fetch("https://slack.com/api/conversations.list?limit=200&types=public_channel,private_channel", {
    headers: { Authorization: `Bearer ${SLACK_TOKEN}` }
  });
  const data = await res.json();
  if (!data.ok) throw new Error(`Slack conversations.list: ${data.error}`);

  const key = projectKey.toLowerCase().replace(/[^a-z0-9]/g, "");
  return data.channels.find(c => {
    const name = c.name.toLowerCase().replace(/[^a-z0-9]/g, "");
    return name.includes(key) || key.includes(name);
  });
}

async function sendSlack(channelId, text) {
  const res = await fetch("https://slack.com/api/chat.postMessage", {
    method:  "POST",
    headers: {
      Authorization:  `Bearer ${SLACK_TOKEN}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({ channel: channelId, text })
  });
  const data = await res.json();
  if (!data.ok) throw new Error(`Slack postMessage: ${data.error}`);
}

// ── Route webhook ─────────────────────────────────────────
app.post("/webhook", async (req, res) => {
  res.sendStatus(200); // Répondre immédiatement à Frame.io

  const payload   = req.body;
  const eventType = payload.type;

  console.log("Webhook reçu:", eventType);

  if (eventType !== "file.ready") return;

  const fileId       = payload.resource?.id;
  const projectId    = payload.project?.id;
  const accountId    = payload.account?.id;
  const workspaceId  = payload.workspace?.id;

  if (!fileId) { console.warn("Pas de resource.id dans le payload"); return; }

  try {
    // 1. Récupère les détails du fichier (nom, parent_id, etc.)
    const fileDetails = await getFileDetails(fileId);
    const fileName    = fileDetails.name;
    const parentId    = fileDetails.parent_id;

    console.log(`Fichier: ${fileName}`);

    // 2. Détecte le dossier cible et la clé projet
    const projectKey   = extractProjectKey(fileName);
    const targetFolder = detectFolder(fileName);
    const today        = todayStr();

    console.log(`Projet: ${projectKey} | Dossier: ${targetFolder} | Date: ${today}`);

    // 3. Trouve le projet Frame.io
    const project = await findProject(accountId, workspaceId, projectKey);
    if (!project) {
      console.warn(`Projet Frame.io introuvable pour: ${projectKey}`);
      return;
    }

    // 4. Trouve/crée le dossier cible puis le sous-dossier date
    const rootId     = project.root_folder_id || project.id;
    const folderObj  = await findOrCreate(rootId, targetFolder);
    const dateObj    = await findOrCreate(folderObj.id, today);

    // 5. Déplace si le fichier n'est pas déjà au bon endroit
    if (parentId !== dateObj.id) {
      await moveFile(fileId, dateObj.id);
      console.log(`Fichier déplacé → ${targetFolder}/${today}`);
    } else {
      console.log("Fichier déjà au bon endroit");
    }

    // 6. Construit le lien de review et notifie Slack
    const reviewLink   = `https://app.frame.io/reviews/${fileId}`;
    const slackChannel = await findSlackChannel(projectKey);

    if (slackChannel) {
      await sendSlack(
        slackChannel.id,
        `📹 *${fileName}*\n${reviewLink}`
      );
      console.log(`Slack notifié: #${slackChannel.name}`);
    } else {
      console.warn(`Channel Slack introuvable pour: ${projectKey}`);
    }

  } catch (e) {
    console.error("Erreur traitement webhook:", e.message);
  }
});

// ── Health check ──────────────────────────────────────────
app.get("/", (req, res) => {
  res.json({ status: "ok", service: "frameio-webhook-v4" });
});

app.listen(PORT, () => {
  console.log(`Serveur démarré sur le port ${PORT}`);
});
