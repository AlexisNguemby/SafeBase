package main

import (
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"testing"
)

// Ces tests ne lancent ni pg_dump ni psql : ils vérifient les contrôles
// qui ont lieu AVANT l'appel aux outils Postgres (validation, chemins, rétention).

func TestSafeBackupPath(t *testing.T) {
	storage := t.TempDir()

	tests := []struct {
		name     string
		filename string
		wantErr  bool
	}{
		{"nom horodaté valide", "client_db_20261022_030000.sql", false},
		{"nom latest valide", "client_db_latest.sql", false},
		{"remontée de dossier", "../evil.sql", true},
		{"remontée cachée dans un sous-dossier", "a/../../evil.sql", true},
		{"chemin absolu", "/etc/passwd.sql", true},
		{"sous-dossier", "sub/file.sql", true},
		{"extension autre que .sql", "dump.sh", true},
		{"nom vide", "", true},
		{"seulement l'extension", ".sql", true},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got, err := safeBackupPath(storage, tt.filename)

			if tt.wantErr {
				if err == nil {
					t.Fatalf("safeBackupPath(%q) aurait dû être refusé, chemin obtenu : %s", tt.filename, got)
				}
				return
			}

			if err != nil {
				t.Fatalf("safeBackupPath(%q) refusé à tort : %v", tt.filename, err)
			}
			if filepath.Dir(got) != storage {
				t.Fatalf("le fichier doit être dans %s, obtenu %s", storage, got)
			}
		})
	}
}

func TestHandleBackupRejectsInvalidInput(t *testing.T) {
	storage := t.TempDir()
	t.Setenv("STORAGE_PATH", storage)

	tests := []struct {
		name string
		body string
	}{
		{"custom_filename avec ../", `{"db_name":"client_db","custom_filename":"../evil.sql"}`},
		{"db_name avec /", `{"db_name":"../client_db"}`},
		{"db_name vide", `{"db_name":""}`},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			rec := httptest.NewRecorder()
			req := httptest.NewRequest(http.MethodPost, "/backup", strings.NewReader(tt.body))

			handleBackup(rec, req)

			if rec.Code != http.StatusBadRequest {
				t.Fatalf("code attendu 400, obtenu %d (%s)", rec.Code, rec.Body.String())
			}
			if !strings.Contains(rec.Body.String(), `"status":"error"`) {
				t.Fatalf("réponse JSON d'erreur attendue, obtenu %s", rec.Body.String())
			}
		})
	}

	// Aucun fichier ne doit avoir été créé, ni dans le dossier ni à côté
	assertDirEmpty(t, storage)
	if _, err := os.Stat(filepath.Join(filepath.Dir(storage), "evil.sql")); err == nil {
		t.Fatal("evil.sql a été créé hors du dossier de stockage")
	}
}

func TestHandleRestore(t *testing.T) {
	storage := t.TempDir()
	t.Setenv("STORAGE_PATH", storage)

	tests := []struct {
		name     string
		method   string
		body     string
		wantCode int
	}{
		{"méthode GET refusée", http.MethodGet, ``, http.StatusMethodNotAllowed},
		{"JSON invalide", http.MethodPost, `{pas du json`, http.StatusBadRequest},
		{"remontée de dossier", http.MethodPost, `{"db_name":"client_db","filename":"../main.go"}`, http.StatusBadRequest},
		{"db_name invalide", http.MethodPost, `{"db_name":"client db","filename":"x.sql"}`, http.StatusBadRequest},
		{"fichier inexistant", http.MethodPost, `{"db_name":"client_db","filename":"absent.sql"}`, http.StatusNotFound},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			rec := httptest.NewRecorder()
			req := httptest.NewRequest(tt.method, "/restore", strings.NewReader(tt.body))

			handleRestore(rec, req)

			if rec.Code != tt.wantCode {
				t.Fatalf("code attendu %d, obtenu %d (%s)", tt.wantCode, rec.Code, rec.Body.String())
			}
		})
	}
}

func TestPruneOldBackups(t *testing.T) {
	files := []string{
		"safebase_db_20261020_030000.sql",
		"safebase_db_20261021_030000.sql",
		"safebase_db_20261022_030000.sql",
		"safebase_db_latest.sql",
		// Même préfixe "safebase_" mais autre base : ne doit jamais être touché
		"safebase_20261001_030000.sql",
		"client_db_20261001_030000.sql",
		"notes.txt",
	}

	t.Run("garde les N plus récentes de la base et ne touche à rien d'autre", func(t *testing.T) {
		storage := createFiles(t, files)
		t.Setenv("BACKUP_RETENTION", "2")

		pruneOldBackups(storage, "safebase_db")

		assertFiles(t, storage, []string{
			"client_db_20261001_030000.sql",
			"notes.txt",
			"safebase_20261001_030000.sql",
			"safebase_db_20261021_030000.sql",
			"safebase_db_20261022_030000.sql",
			"safebase_db_latest.sql",
		})
	})

	t.Run("une base au nom plus court ne supprime pas les fichiers d'une autre base", func(t *testing.T) {
		storage := createFiles(t, files)
		t.Setenv("BACKUP_RETENTION", "1")

		// "safebase" est un préfixe de "safebase_db" : seuls ses propres fichiers comptent
		pruneOldBackups(storage, "safebase")

		assertFiles(t, storage, files)
	})

	for _, retention := range []string{"", "0", "-1", "abc"} {
		t.Run("rétention désactivée avec BACKUP_RETENTION="+retention, func(t *testing.T) {
			storage := createFiles(t, files)
			t.Setenv("BACKUP_RETENTION", retention)

			pruneOldBackups(storage, "safebase_db")

			assertFiles(t, storage, files)
		})
	}
}

// --- helpers ---

func createFiles(t *testing.T, names []string) string {
	t.Helper()
	dir := t.TempDir()
	for _, name := range names {
		if err := os.WriteFile(filepath.Join(dir, name), []byte("-- dump"), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	return dir
}

func assertFiles(t *testing.T, dir string, want []string) {
	t.Helper()
	entries, err := os.ReadDir(dir)
	if err != nil {
		t.Fatal(err)
	}

	got := make([]string, 0, len(entries))
	for _, entry := range entries {
		got = append(got, entry.Name())
	}

	want = append([]string(nil), want...)
	sort.Strings(got)
	sort.Strings(want)

	if strings.Join(got, ",") != strings.Join(want, ",") {
		t.Fatalf("fichiers restants :\n  obtenu  %v\n  attendu %v", got, want)
	}
}

func assertDirEmpty(t *testing.T, dir string) {
	t.Helper()
	assertFiles(t, dir, nil)
}
