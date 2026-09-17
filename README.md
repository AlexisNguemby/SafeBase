# SafeBase - Configuration Docker Initial

Ce projet contient l'environnement Docker complet pour **SafeBase**.

## 🚀 Démarrage Rapide

1. Copier le fichier d'environnement d'exemple :
   ```bash
   cp .env.example .env
   ```

2. Lancer l'ensemble des services :
   ```bash
   docker-compose up -d --build
   ```

3. Vérifier que les conteneurs fonctionnent :
   ```bash
   docker-compose ps
   ```

## 📍 Accès aux Services

* **Frontend React (Vite)** : http://localhost:5173
* **Backend Node.js (Express)** : http://localhost:3000
* **Worker Go Engine** : http://localhost:8080/health
* **PostgreSQL** : `localhost:5432`
