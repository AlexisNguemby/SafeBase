FROM golang:1.22-alpine

# Installation des CLI client SQL pour effectuer les dumps/restaurations
RUN apk add --no-cache postgresql-client mysql-client gzip

WORKDIR /app

# Les crochets [m] permettent de ne pas faire planter Docker si go.sum n'existe pas encore
COPY go.mod go.su[m] ./
RUN go mod download || true

COPY . .

EXPOSE 8080

CMD ["go", "run", "main.go"]