# 1. Récupérer le projet
git clone https://github.com/AlexisNguemby/SafeBase.git
cd SafeBase

# 2. Créer le fichier d'environnement local
# (Copier le modèle d'environnement ou créer un fichier .env avec les variables de BDD)
cp .env.example .env   # Ou créer un .env manuellement

# 3. Lancer les conteneurs Docker (PostgreSQL + Node)
# Si la stack a déjà tourné avec d'autres identifiants, lancer d'abord
# `docker-compose down -v` : Postgres ne réinitialise pas un volume existant.
# -V recrée le volume node_modules : sans lui, une dépendance ajoutée
# au package.json n'est pas visible dans le conteneur.
docker-compose up -d --build -V

# 4. Appliquer les migrations de la base de données
docker-compose exec server-node npx prisma migrate dev

# 5. (Optionnel) Générer le client Prisma si besoin
docker-compose exec server-node npx prisma generate

## Sauvegardes planifiées et rétention

Deux variables du `.env` règlent les sauvegardes automatiques :

| Variable | Exemple | Rôle |
|---|---|---|
| `BACKUP_CRON` | `0 3 * * *` | Quand sauvegarder, au format cron `minute heure jour mois jour-de-semaine` (ici tous les jours à 3h00). Vide = désactivé. Pour tester : `* * * * *` (chaque minute). |
| `BACKUP_RETENTION` | `7` | Nombre de sauvegardes horodatées gardées par base. Les plus anciennes sont supprimées. Le fichier `<base>_latest.sql` n'est jamais supprimé. `0` = tout garder. |

Les sauvegardes planifiées apparaissent dans l'historique de tous les utilisateurs avec la mention « (auto) ».

## Restauration

Le bouton « Restaurer » de l'historique rejoue une sauvegarde dans sa base d'origine. Les données actuelles de la base sont remplacées.

La base `safebase_db` n'est pas restaurable depuis l'interface : elle contient les comptes et l'historique de SafeBase lui-même, qu'une restauration effacerait.

## CI/CD

Le pipeline `.github/workflows/ci.yml` tourne sur chaque PR vers `main`, sur chaque push sur `main` et sur chaque tag `v*` :

1. **CI** (en parallèle) :
   - `server` : vérification des types (`npm run typecheck`) et tests (`npm test`)
   - `prisma` : les migrations s'appliquent sur un Postgres 15 vide et correspondent à `schema.prisma`
   - `worker-go` : `go vet`, tests, `govulncheck` (failles connues)
   - `integration` : vraie sauvegarde (`pg_dump` 15) puis vraie restauration (`psql`) sur Postgres 15
   - `client` : build du client React
2. **CD** (si tout passe) : construction des 3 images de production (étape `prod` des Dockerfiles). Sur une PR, elles sont seulement construites. Sinon, elles sont publiées sur GitHub Container Registry :
   - `ghcr.io/alexisnguemby/safebase-server`
   - `ghcr.io/alexisnguemby/safebase-worker-go`
   - `ghcr.io/alexisnguemby/safebase-client`

   | Événement | Tags publiés |
   |---|---|
   | push sur `main` | `latest`, `sha-<commit>` |
   | tag `v1.2.3` | `1.2.3`, `1.2`, `sha-<commit>` |
3. **Déploiement** (tag `v*` uniquement, si la variable `DEPLOY_HOST` est définie) : copie `docker-compose.prod.yml` sur le serveur par SSH puis lance `docker compose pull && up -d` avec la version du tag.

Lancer le test d'intégration en local (Postgres 15 et client 15 requis) :

```bash
cd worker-go
PGHOST=localhost PGUSER=client_user PGPASSWORD=client_password PGDATABASE=client_db \
  go test -tags=integration -run Integration -v ./...
```

### Faire une release

```bash
git tag v1.0.0
git push origin v1.0.0
```

### Mettre en place le déploiement (une seule fois)

Sur le serveur : installer Docker, créer `~/safebase/.env` (mêmes variables que `.env.example`, avec de vrais secrets, `chmod 600`), et si les images sont privées, `docker login ghcr.io`.

Dans GitHub (Settings > Secrets and variables > Actions) :

| Type | Nom | Valeur |
|---|---|---|
| Variable | `DEPLOY_HOST` | adresse du serveur |
| Variable | `DEPLOY_USER` | utilisateur SSH |
| Variable | `VITE_API_URL` | URL publique de l'API (ex. `https://api.exemple.fr`) |
| Secret | `DEPLOY_SSH_KEY` | clé privée SSH dédiée au déploiement |
| Secret | `DEPLOY_KNOWN_HOSTS` | sortie de `ssh-keyscan <serveur>` |

Retour arrière : sur le serveur, `cd ~/safebase && TAG=1.0.0 docker compose -f docker-compose.prod.yml up -d` avec la version précédente. Attention : les migrations Prisma ne reviennent pas en arrière, seules les images changent.
