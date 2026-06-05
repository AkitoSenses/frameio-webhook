# Frame.io Webhook Server

Serveur qui reçoit les webhooks Frame.io et :
1. Détecte le projet depuis le nom du fichier
2. Range automatiquement le fichier dans le bon dossier
3. Envoie une notification Slack avec le lien de review

## Déploiement sur Railway (gratuit)

### 1. Crée un compte Railway
Va sur [railway.app](https://railway.app) et connecte-toi avec GitHub.

### 2. Déploie le serveur
1. Crée un nouveau projet → **Deploy from GitHub repo**
2. Upload ce dossier sur GitHub ou utilise **Deploy from local**
3. Ou utilise le CLI Railway :
```bash
npm install -g @railway/cli
railway login
railway init
railway up
```

### 3. Configure les variables d'environnement
Dans Railway → ton projet → **Variables** :
- `FRAMEIO_TOKEN` : ton token Frame.io V4 (Adobe IMS)
- `SLACK_TOKEN` : ton token Slack Bot (`xoxb-...`)

### 4. Récupère l'URL publique
Railway te donne une URL du type `https://frameio-webhook-xxx.railway.app`

### 5. Configure le webhook dans Frame.io
1. Va dans Frame.io → **Settings** → **Webhooks**
2. Crée un nouveau webhook :
   - **URL** : `https://frameio-webhook-xxx.railway.app/webhook`
   - **Events** : `asset.ready` (fichier uploadé et traité)
   - **Team** : ta team

## Règles de routing

| Mot-clé dans le nom | Dossier Frame.io |
|---------------------|------------------|
| Commence par `LIVRAISON_` | `06. DELIVERY` |
| `CONFO`, `FINALISATION` | `05. FINALISATION` |
| `GRADING`, `GRADE`, `LUT` | `04. GRADING` |
| `3D`, `VFX`, `COMPO` | `03. 3D` |
| `ALLRUSHES`, `DERUSH`, `RUSHES` | `01. ALL RUSHES-DERUSH` |
| Aucun match | `02. EDIT` |

Le fichier est ensuite rangé dans un sous-dossier `AAMMDD` (date du jour).

## Exemples
- `CONDÉ-NAST_GQ-SANTOS_CARTIER_CONFO_16x9_260601.mp4`
  → projet `CONDÉ-NAST_GQ-SANTOS` / `05. FINALISATION` / `260605`
- `CONDÉ-NAST_GQ-SANTOS_CARTIER_GRADING_260601.mp4`
  → projet `CONDÉ-NAST_GQ-SANTOS` / `04. GRADING` / `260605`
- `LIVRAISON_CONDÉ-NAST_GQ-SANTOS_260601.mp4`
  → projet `CONDÉ-NAST_GQ-SANTOS` / `06. DELIVERY` / `260605`
- `CONDÉ-NAST_GQ-SANTOS_260601.mp4`
  → projet `CONDÉ-NAST_GQ-SANTOS` / `02. EDIT` / `260605`
