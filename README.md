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
