FROM golang:1.22-alpine3.20

# Installation des CLI client SQL pour effectuer les dumps/restaurations
# Le client Postgres doit avoir la même version majeure que les bases (postgres:15) :
# un dump fait par pg_dump 17 contient des commandes que Postgres 15 refuse à la restauration
RUN apk add --no-cache postgresql15-client mysql-client gzip

WORKDIR /app

# Les crochets [m] permettent de ne pas faire planter Docker si go.sum n'existe pas encore
COPY go.mod go.su[m] ./
RUN go mod download || true

COPY . .

EXPOSE 8080

CMD ["go", "run", "main.go"]