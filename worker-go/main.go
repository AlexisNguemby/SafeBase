package main

import (
	"encoding/json"
	"fmt"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"time"
)

type BackupRequest struct {
	Host           string `json:"host"`
	Port           int    `json:"port"`
	DBName         string `json:"db_name"`
	User           string `json:"user"`
	Password       string `json:"password"`
	CustomFilename string `json:"custom_filename,omitempty"` // Permet de fixer le nom pour écraser
}

func main() {
	port := os.Getenv("PORT")
	if port == "" {
		port = "8080"
	}

	http.HandleFunc("/backup", handleBackup)

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

	storagePath := os.Getenv("STORAGE_PATH")
	if storagePath == "" {
		storagePath = "./backups"
	}
	_ = os.MkdirAll(storagePath, os.ModePerm)

	// Si un nom personnalisé est fourni, on l'utilise (écrasement), sinon nom horodaté
	filename := req.CustomFilename
	if filename == "" {
		filename = fmt.Sprintf("%s_%s.sql", req.DBName, time.Now().Format("20060102_150405"))
	}
	filePath := filepath.Join(storagePath, filename)

	cmd := exec.Command("pg_dump",
		"-h", req.Host,
		"-p", fmt.Sprintf("%d", req.Port),
		"-U", req.User,
		"-d", req.DBName,
		"-f", filePath,
	)

	cmd.Env = append(os.Environ(), fmt.Sprintf("PGPASSWORD=%s", req.Password))

	err = cmd.Run()
	if err != nil {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusInternalServerError)
		json.NewEncoder(w).Encode(map[string]string{
			"status": "error",
			"error":  "Backup failed: " + err.Error(),
		})
		return
	}

	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusOK)
	json.NewEncoder(w).Encode(map[string]string{
		"status":   "success",
		"file":     filename,
		"filePath": filePath,
	})
}
