# Deux étapes dans ce fichier :
# - dev  : utilisée par docker-compose.yml (code monté en volume, rechargement à chaud)
# - prod : la dernière étape, donc celle construite par défaut (CI et images publiées)

FROM node:24-alpine AS base
# Prisma a besoin d'OpenSSL sur Alpine
RUN apk add --no-cache openssl
WORKDIR /app
COPY package*.json ./

FROM base AS dev
RUN npm ci
COPY . .
EXPOSE 3000
CMD ["npm", "run", "dev"]

FROM base AS prod
ENV NODE_ENV=production
# --omit=dev : pas de vitest, supertest... dans l'image (prisma est dans "dependencies" pour les migrations)
RUN npm ci --omit=dev
COPY . .
RUN npx prisma generate
# Ne pas tourner en root dans le conteneur
USER node
EXPOSE 3000
# Applique les migrations au démarrage, puis "exec" remplace le shell par Node :
# Node reçoit directement le signal d'arrêt (docker stop) et s'arrête proprement
CMD ["sh", "-c", "npx prisma migrate deploy && exec node --import tsx index.ts"]
