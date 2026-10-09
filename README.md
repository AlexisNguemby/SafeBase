# 1. Récupérer le projet
git clone https://github.com/AlexisNguemby/SafeBase.git
cd SafeBase

# 2. Créer le fichier d'environnement local
# (Copier le modèle d'environnement ou créer un fichier .env avec les variables de BDD)
cp .env.example .env   # Ou créer un .env manuellement

# 3. Lancer les conteneurs Docker (PostgreSQL + Node)
docker-compose up -d --build

# 4. Appliquer les migrations de la base de données
docker-compose exec server-node npx prisma migrate dev

# 5. (Optionnel) Générer le client Prisma si besoin
docker-compose exec server-node npx prisma generate
