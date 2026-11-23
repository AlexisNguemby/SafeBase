# Étape 1 : compilation. Seul le binaire en sortira, pas la chaîne de compilation Go.
FROM golang:1.27-alpine AS build
WORKDIR /src
COPY . .
# CGO_ENABLED=0 : binaire statique, qui tourne sur n'importe quel Alpine
RUN CGO_ENABLED=0 go build -o /worker .

# Étape 2 : image finale, utilisée en dev comme en prod pour que pg_dump soit toujours en version 15.
# Le client Postgres doit avoir la même version majeure que les bases (postgres:15) :
# un dump fait par pg_dump 17 contient des commandes que Postgres 15 refuse à la restauration.
# Alpine 3.22 est la dernière version qui fournit postgresql15-client (support jusqu'au 1er mai 2027).
FROM alpine:3.22
RUN apk add --no-cache postgresql15-client mysql-client gzip
WORKDIR /app
COPY --from=build /worker /usr/local/bin/worker
ENV STORAGE_PATH=/app/backups
EXPOSE 8080
CMD ["worker"]
