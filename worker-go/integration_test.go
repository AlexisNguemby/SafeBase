//go:build integration

package main

// Test d'intégration : lance le vrai pg_dump puis le vrai psql contre une base Postgres.
// Il n'est compilé qu'avec le build tag "integration", donc `go test ./...` reste rapide :
//   go test -tags=integration -run Integration ./...
// La connexion se fait par les variables standard PGHOST, PGPORT, PGUSER, PGPASSWORD, PGDATABASE.

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"strconv"
	"strings"
	"testing"
)

func TestIntegrationBackupThenRestore(t *testing.T) {
	for _, name := range []string{"PGHOST", "PGUSER", "PGPASSWORD", "PGDATABASE"} {
		if os.Getenv(name) == "" {
			t.Fatalf("variable %s manquante : ce test a besoin d'une vraie base Postgres", name)
		}
	}
	port := 5432
	if p := os.Getenv("PGPORT"); p != "" {
		port, _ = strconv.Atoi(p)
	}
	t.Setenv("STORAGE_PATH", t.TempDir())

	db := map[string]any{
		"host":     os.Getenv("PGHOST"),
		"port":     port,
		"db_name":  os.Getenv("PGDATABASE"),
		"user":     os.Getenv("PGUSER"),
		"password": os.Getenv("PGPASSWORD"),
	}

	// 1. Données de départ
	runSQL(t, `DROP TABLE IF EXISTS items;
		CREATE TABLE items (id int PRIMARY KEY, name text);
		INSERT INTO items VALUES (1, 'alpha'), (2, 'beta');`)

	// 2. Sauvegarde
	rec := callHandler(t, handleBackup, "/backup", db)
	var backup struct{ File string }
	if err := json.Unmarshal(rec.Body.Bytes(), &backup); err != nil || backup.File == "" {
		t.Fatalf("réponse de sauvegarde inattendue : %s", rec.Body.String())
	}

	// 3. Les données changent après la sauvegarde
	runSQL(t, `DELETE FROM items WHERE id = 1; INSERT INTO items VALUES (3, 'gamma');`)

	// 4. Restauration
	db["filename"] = backup.File
	callHandler(t, handleRestore, "/restore", db)

	// 5. La base doit être revenue exactement à l'état sauvegardé
	if got := runSQL(t, `SELECT string_agg(name, ',' ORDER BY id) FROM items`); got != "alpha,beta" {
		t.Fatalf("après restauration : obtenu %q, attendu %q", got, "alpha,beta")
	}
}

// callHandler appelle un handler du worker et échoue si la réponse n'est pas 200.
func callHandler(t *testing.T, handler http.HandlerFunc, path string, body map[string]any) *httptest.ResponseRecorder {
	t.Helper()
	payload, _ := json.Marshal(body)
	rec := httptest.NewRecorder()
	handler(rec, httptest.NewRequest(http.MethodPost, path, strings.NewReader(string(payload))))
	if rec.Code != http.StatusOK {
		t.Fatalf("%s : code %d (%s)", path, rec.Code, rec.Body.String())
	}
	return rec
}

// runSQL exécute du SQL avec psql et renvoie la sortie brute (sans en-têtes).
func runSQL(t *testing.T, sql string) string {
	t.Helper()
	out, err := exec.Command("psql", "-v", "ON_ERROR_STOP=1", "-tA", "-c", sql).CombinedOutput()
	if err != nil {
		t.Fatalf("psql : %v\n%s", err, out)
	}
	return strings.TrimSpace(string(out))
}
