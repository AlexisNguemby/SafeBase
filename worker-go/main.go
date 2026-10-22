package main

import (
	"encoding/json"
	"fmt"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"time"
)

var (
	validFilename = regexp.MustCompile(`^[A-Za-z0-9_-]+\.sql$`)
	validDBName   = regexp.MustCompile(`^[A-Za-z0-9_-]+$`)
)

type BackupRequest struct {
	Host           string `json:"host"`
	Port           int    `json:"port"`
	DBName         string `json:"db_name"`
	User           string `json:"user"`
	Password       string `json:"password"`
	CustomFilename string `json:"custom_filename,omitempty"` // Permet de fixer le nom pour écraser
}

type RestoreRequest struct {
	Host     string `json:"host"`
	Port     int    `json:"port"`
	DBName   string `json:"db_name"`
	User     string `json:"user"`
	Password string `json:"password"`
	Filename string `json:"filename"` // Fichier de backups/ à rejouer dans la base
}

func main() {
	port := os.Getenv("PORT")
	if port == "" {
		port = "8080"
	}

	http.HandleFunc("/backup", handleBackup)
	http.HandleFunc("/restore", handleRestore)

	fmt.Printf("Worker Go running on port %s\n", port)
	if err := http.ListenAndServe(":"+port, nil); err != nil {
		fmt.Printf("Server failed: %s\n", err)
	}
}

func handleBackup(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
		return
	}

	var req BackupRequest
	err := json.NewDecoder(r.Body).Decode(&req)
	if err != nil {
		http.Error(w, "Invalid JSON body", http.StatusBadRequest)
		return
	}

	// Le nom de la base entre dans le nom horodaté
	if !validDBName.MatchString(req.DBName) {
		writeError(w, http.StatusBadRequest, "Invalid db_name")
		return
	}

	storagePath := getStoragePath()
	_ = os.MkdirAll(storagePath, os.ModePerm)

	// Si un nom personnalisé est fourni, on l'utilise (écrasement), sinon nom horodaté
	filename := req.CustomFilename
	if filename == "" {
		filename = fmt.Sprintf("%s_%s.sql", req.DBName, time.Now().Format("20060102_150405"))
	}
	filePath, err := safeBackupPath(storagePath, filename)
	if err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}

	// --clean --if-exists ajoute des DROP ... IF EXISTS en tête du dump,
	// pour pouvoir le restaurer sur une base qui contient déjà les tables
	cmd := exec.Command("pg_dump",
		"--clean", "--if-exists",
		"-h", req.Host,
		"-p", fmt.Sprintf("%d", req.Port),
		"-U", req.User,
		"-d", req.DBName,
		"-f", filePath,
	)

	cmd.Env = append(os.Environ(), fmt.Sprintf("PGPASSWORD=%s", req.Password))

	err = cmd.Run()
	if err != nil {
		writeError(w, http.StatusInternalServerError, "Backup failed: "+err.Error())
		return
	}

	// La rétention ne concerne que les sauvegardes horodatées, jamais le fichier _latest
	if req.CustomFilename == "" {
		pruneOldBackups(storagePath, req.DBName)
	}

	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusOK)
	json.NewEncoder(w).Encode(map[string]string{
		"status":   "success",
		"file":     filename,
		"filePath": filePath,
	})
}

func handleRestore(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
		return
	}

	var req RestoreRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, "Invalid JSON body", http.StatusBadRequest)
		return
	}

	if !validDBName.MatchString(req.DBName) {
		writeError(w, http.StatusBadRequest, "Invalid db_name")
		return
	}

	filePath, err := safeBackupPath(getStoragePath(), req.Filename)
	if err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}

	if _, err := os.Stat(filePath); err != nil {
		writeError(w, http.StatusNotFound, "Backup file not found")
		return
	}

	// ON_ERROR_STOP=1 : psql s'arrête à la première erreur et renvoie un code d'échec,
	// sinon il continue et la restauration paraît réussie alors qu'elle est incomplète
	cmd := exec.Command("psql",
		"-h", req.Host,
		"-p", fmt.Sprintf("%d", req.Port),
		"-U", req.User,
		"-d", req.DBName,
		"-v", "ON_ERROR_STOP=1",
		"-f", filePath,
	)

	cmd.Env = append(os.Environ(), fmt.Sprintf("PGPASSWORD=%s", req.Password))

	if output, err := cmd.CombinedOutput(); err != nil {
		writeError(w, http.StatusInternalServerError, "Restore failed: "+strings.TrimSpace(string(output)))
		return
	}

	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusOK)
	json.NewEncoder(w).Encode(map[string]string{
		"status": "success",
		"file":   req.Filename,
	})
}

// pruneOldBackups garde les BACKUP_RETENTION sauvegardes horodatées les plus récentes
// de la base et supprime les autres. 0 ou absent = pas de suppression.
func pruneOldBackups(storagePath, dbName string) {
	keep, err := strconv.Atoi(os.Getenv("BACKUP_RETENTION"))
	if err != nil || keep <= 0 {
		return
	}

	// Nom exact <db_name>_AAAAMMJJ_HHMMSS.sql : un simple "safebase_*" attraperait
	// aussi les fichiers de "safebase_db"
	pattern := regexp.MustCompile(`^` + regexp.QuoteMeta(dbName) + `_\d{8}_\d{6}\.sql$`)

	entries, err := os.ReadDir(storagePath)
	if err != nil {
		fmt.Printf("Retention: cannot read %s: %s\n", storagePath, err)
		return
	}

	var backups []string
	for _, entry := range entries {
		if !entry.IsDir() && pattern.MatchString(entry.Name()) {
			backups = append(backups, entry.Name())
		}
	}

	if len(backups) <= keep {
		return
	}

	// L'horodatage AAAAMMJJ_HHMMSS se trie dans l'ordre chronologique comme du texte
	sort.Strings(backups)
	for _, name := range backups[:len(backups)-keep] {
		if err := os.Remove(filepath.Join(storagePath, name)); err != nil {
			fmt.Printf("Retention: cannot remove %s: %s\n", name, err)
			continue
		}
		fmt.Printf("Retention: removed %s\n", name)
	}
}

func getStoragePath() string {
	storagePath := os.Getenv("STORAGE_PATH")
	if storagePath == "" {
		storagePath = "./backups"
	}
	return storagePath
}

// safeBackupPath vérifie un nom de fichier et renvoie son chemin dans le dossier de stockage.
// Utilisé par le backup et la restauration : la règle de sécurité n'est écrite qu'une fois.
func safeBackupPath(storagePath, filename string) (string, error) {
	if !validFilename.MatchString(filename) {
		return "", fmt.Errorf("Invalid filename")
	}

	filePath := filepath.Join(storagePath, filename)

	// Défense en profondeur : le fichier doit rester dans le dossier de stockage
	if rel, err := filepath.Rel(storagePath, filePath); err != nil || strings.HasPrefix(rel, "..") {
		return "", fmt.Errorf("Invalid file path")
	}

	return filePath, nil
}

func writeError(w http.ResponseWriter, status int, message string) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	json.NewEncoder(w).Encode(map[string]string{
		"status": "error",
		"error":  message,
	})
}
