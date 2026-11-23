# Trois étapes :
# - dev   : serveur de développement Vite, utilisé par docker-compose.yml
# - build : compile le site en fichiers statiques (dist/)
# - prod  : la dernière, construite par défaut : nginx sert les fichiers statiques

FROM node:24-alpine AS dev
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
EXPOSE 5173
CMD ["npm", "run", "dev"]

FROM dev AS build
# Vite remplace VITE_API_URL dans le code AU MOMENT DU BUILD : changer l'URL impose de reconstruire.
# Elle doit être joignable depuis le navigateur de l'utilisateur (pas un nom de service Docker).
ARG VITE_API_URL=http://localhost:3000
ENV VITE_API_URL=$VITE_API_URL
RUN npm run build

FROM nginx:1.30-alpine AS prod
COPY nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/dist /usr/share/nginx/html
EXPOSE 80
