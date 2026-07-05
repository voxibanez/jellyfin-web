package main

import (
	"compress/gzip"
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"log"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"time"
)

const defaultConfigPath = "/etc/jellyfin-log-collector/config.toml"
const maxGzipValidationBytes = 256 << 20

type Config struct {
	JellyfinBaseURL          string
	ListenAddr               string
	StorageDir               string
	RetentionDays            int
	MaxCompressedUploadBytes int64
	AllowedOrigins           []string
	TokenTTLSeconds          int
	HMACSecretPath           string
}

type Server struct {
	config Config
	client *http.Client
	secret []byte
	tokens map[string]uploadToken
	mu     sync.Mutex
}

type uploadToken struct {
	ID        string
	TokenHash string
	ExpiresAt time.Time
	Used      bool
	Metadata  initRequest
	UserID    string
	Username  string
}

type initRequest struct {
	RunID         string `json:"runId"`
	ItemID        string `json:"itemId"`
	PlaySessionID string `json:"playSessionId"`
	StartedAt     string `json:"startedAt"`
	EndedAt       string `json:"endedAt"`
}

type initResponse struct {
	UploadID  string `json:"uploadId"`
	Token     string `json:"token"`
	UploadURL string `json:"uploadUrl"`
	ExpiresAt string `json:"expiresAt"`
}

type jellyfinUser struct {
	ID   string `json:"Id"`
	Name string `json:"Name"`
}

func defaultConfig() Config {
	return Config{
		JellyfinBaseURL:          "https://jellyfin.motofactory.net",
		ListenAddr:               "127.0.0.1:8099",
		StorageDir:               "/var/lib/jellyfin-log-collector/uploads",
		RetentionDays:            30,
		MaxCompressedUploadBytes: 209715200,
		AllowedOrigins:           []string{"https://jellyfin.motofactory.net"},
		TokenTTLSeconds:          300,
		HMACSecretPath:           "/var/lib/jellyfin-log-collector/hmac.key",
	}
}

func main() {
	configPath := flag.String("config", defaultConfigPath, "config file path")
	flag.Parse()

	config, err := loadConfig(*configPath)
	if err != nil {
		log.Fatalf("load config: %v", err)
	}

	secret, err := loadOrCreateSecret(config.HMACSecretPath)
	if err != nil {
		log.Fatalf("load secret: %v", err)
	}

	if err := os.MkdirAll(config.StorageDir, 0750); err != nil {
		log.Fatalf("create storage dir: %v", err)
	}

	server := &Server{
		config: config,
		client: &http.Client{Timeout: 10 * time.Second},
		secret: secret,
		tokens: map[string]uploadToken{},
	}

	mux := http.NewServeMux()
	mux.HandleFunc("GET /healthz", server.health)
	mux.HandleFunc("POST /v1/uploads/init", server.initUpload)
	mux.HandleFunc("POST /v1/uploads/", server.receiveUpload)

	go server.retentionLoop()

	log.Printf("listening on %s", config.ListenAddr)
	if err := http.ListenAndServe(config.ListenAddr, server.withCORS(mux)); err != nil {
		log.Fatal(err)
	}
}

func loadConfig(path string) (Config, error) {
	config := defaultConfig()
	content, err := os.ReadFile(path)
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return config, nil
		}
		return config, err
	}

	for _, line := range strings.Split(string(content), "\n") {
		line = strings.TrimSpace(line)
		if line == "" || strings.HasPrefix(line, "#") {
			continue
		}
		parts := strings.SplitN(line, "=", 2)
		if len(parts) != 2 {
			return config, fmt.Errorf("invalid config line %q", line)
		}
		key := strings.TrimSpace(parts[0])
		value := strings.Trim(strings.TrimSpace(parts[1]), `"`)

		switch key {
		case "jellyfin_base_url":
			config.JellyfinBaseURL = strings.TrimRight(value, "/")
		case "listen_addr":
			config.ListenAddr = value
		case "storage_dir":
			config.StorageDir = value
		case "retention_days":
			config.RetentionDays = atoi(value, config.RetentionDays)
		case "max_compressed_upload_bytes":
			config.MaxCompressedUploadBytes = int64(atoi(value, int(config.MaxCompressedUploadBytes)))
		case "allowed_origins":
			config.AllowedOrigins = parseList(value)
		case "token_ttl_seconds":
			config.TokenTTLSeconds = atoi(value, config.TokenTTLSeconds)
		case "hmac_secret_path":
			config.HMACSecretPath = value
		}
	}

	if _, err := url.ParseRequestURI(config.JellyfinBaseURL); err != nil {
		return config, fmt.Errorf("invalid jellyfin_base_url: %w", err)
	}
	return config, nil
}

func parseList(value string) []string {
	value = strings.TrimSpace(value)
	value = strings.TrimPrefix(value, "[")
	value = strings.TrimSuffix(value, "]")
	if value == "" {
		return nil
	}
	items := strings.Split(value, ",")
	result := make([]string, 0, len(items))
	for _, item := range items {
		result = append(result, strings.Trim(strings.TrimSpace(item), `"`))
	}
	return result
}

func atoi(value string, fallback int) int {
	parsed, err := strconv.Atoi(value)
	if err != nil {
		return fallback
	}
	return parsed
}

func loadOrCreateSecret(path string) ([]byte, error) {
	if content, err := os.ReadFile(path); err == nil {
		return []byte(strings.TrimSpace(string(content))), nil
	}

	secret := make([]byte, 32)
	if _, err := rand.Read(secret); err != nil {
		return nil, err
	}
	encoded := make([]byte, hex.EncodedLen(len(secret)))
	hex.Encode(encoded, secret)

	if err := os.MkdirAll(filepath.Dir(path), 0750); err != nil {
		return nil, err
	}
	if err := os.WriteFile(path, encoded, 0600); err != nil {
		return nil, err
	}
	return encoded, nil
}

func (s *Server) health(w http.ResponseWriter, _ *http.Request) {
	w.WriteHeader(http.StatusOK)
	_, _ = w.Write([]byte("ok\n"))
}

func (s *Server) initUpload(w http.ResponseWriter, r *http.Request) {
	if r.Body == nil {
		http.Error(w, "missing body", http.StatusBadRequest)
		return
	}

	auth := r.Header.Get("Authorization")
	if auth == "" {
		http.Error(w, "missing authorization", http.StatusUnauthorized)
		return
	}

	user, err := s.validateJellyfinAuth(auth)
	if err != nil {
		http.Error(w, "invalid Jellyfin authorization", http.StatusUnauthorized)
		return
	}

	var request initRequest
	if err := json.NewDecoder(io.LimitReader(r.Body, 65536)).Decode(&request); err != nil {
		http.Error(w, "invalid JSON", http.StatusBadRequest)
		return
	}

	uploadID := randomID()
	token := randomID()
	expiresAt := time.Now().Add(time.Duration(s.config.TokenTTLSeconds) * time.Second)

	s.mu.Lock()
	s.tokens[uploadID] = uploadToken{
		ID:        uploadID,
		TokenHash: s.hash(token),
		ExpiresAt: expiresAt,
		Metadata:  request,
		UserID:    user.ID,
		Username:  user.Name,
	}
	s.mu.Unlock()

	writeJSON(w, initResponse{
		UploadID:  uploadID,
		Token:     token,
		UploadURL: "/v1/uploads/" + uploadID,
		ExpiresAt: expiresAt.UTC().Format(time.RFC3339),
	})
}

func (s *Server) receiveUpload(w http.ResponseWriter, r *http.Request) {
	uploadID := strings.TrimPrefix(r.URL.Path, "/v1/uploads/")
	if uploadID == "" || strings.Contains(uploadID, "/") {
		http.Error(w, "invalid upload id", http.StatusBadRequest)
		return
	}

	token := strings.TrimPrefix(r.Header.Get("Authorization"), "Bearer ")
	if token == "" {
		http.Error(w, "missing upload token", http.StatusUnauthorized)
		return
	}

	entry, err := s.consumeToken(uploadID, token)
	if err != nil {
		http.Error(w, err.Error(), http.StatusUnauthorized)
		return
	}

	limited := http.MaxBytesReader(w, r.Body, s.config.MaxCompressedUploadBytes)
	defer limited.Close()

	dir := filepath.Join(s.config.StorageDir, time.Now().UTC().Format("2006-01-02"), uploadID)
	if err := os.MkdirAll(dir, 0750); err != nil {
		http.Error(w, "storage error", http.StatusInternalServerError)
		return
	}

	payloadPath := filepath.Join(dir, "diagnostics.json.gz")
	reader := io.Reader(limited)
	if r.Header.Get("Content-Encoding") == "identity" {
		payloadPath = filepath.Join(dir, "diagnostics.json")
	} else if r.Header.Get("Content-Encoding") != "gzip" {
		http.Error(w, "unsupported content encoding", http.StatusUnsupportedMediaType)
		return
	}

	out, err := os.OpenFile(payloadPath, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0640)
	if err != nil {
		http.Error(w, "storage error", http.StatusInternalServerError)
		return
	}
	written, copyErr := io.Copy(out, reader)
	closeErr := out.Close()
	if copyErr != nil || closeErr != nil {
		http.Error(w, "write error", http.StatusInternalServerError)
		return
	}

	if r.Header.Get("Content-Encoding") == "gzip" {
		if err := validateGzip(payloadPath, maxGzipValidationBytes); err != nil {
			http.Error(w, "invalid gzip", http.StatusBadRequest)
			return
		}
	}

	metadata := map[string]any{
		"uploadId":        uploadID,
		"receivedAt":      time.Now().UTC().Format(time.RFC3339),
		"compressedBytes": written,
		"userId":          entry.UserID,
		"username":        entry.Username,
		"run":             entry.Metadata,
	}
	metadataBytes, _ := json.MarshalIndent(metadata, "", "  ")
	if err := os.WriteFile(filepath.Join(dir, "metadata.json"), metadataBytes, 0640); err != nil {
		http.Error(w, "metadata write error", http.StatusInternalServerError)
		return
	}

	writeJSON(w, map[string]any{"ok": true, "uploadId": uploadID})
}

func (s *Server) validateJellyfinAuth(auth string) (jellyfinUser, error) {
	req, err := http.NewRequest(http.MethodGet, s.config.JellyfinBaseURL+"/Users/Me", nil)
	if err != nil {
		return jellyfinUser{}, err
	}
	req.Header.Set("Authorization", auth)
	resp, err := s.client.Do(req)
	if err != nil {
		return jellyfinUser{}, err
	}
	defer resp.Body.Close()
	if resp.StatusCode >= 400 {
		return jellyfinUser{}, fmt.Errorf("jellyfin status %d", resp.StatusCode)
	}
	var user jellyfinUser
	if err := json.NewDecoder(io.LimitReader(resp.Body, 1<<20)).Decode(&user); err != nil {
		return jellyfinUser{}, err
	}
	if user.ID == "" {
		return jellyfinUser{}, errors.New("missing user id")
	}
	return user, nil
}

func (s *Server) consumeToken(uploadID, token string) (uploadToken, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	entry, ok := s.tokens[uploadID]
	if !ok {
		return uploadToken{}, errors.New("unknown upload token")
	}
	delete(s.tokens, uploadID)
	if entry.Used || time.Now().After(entry.ExpiresAt) {
		return uploadToken{}, errors.New("expired upload token")
	}
	if !hmac.Equal([]byte(entry.TokenHash), []byte(s.hash(token))) {
		return uploadToken{}, errors.New("invalid upload token")
	}
	return entry, nil
}

func (s *Server) hash(token string) string {
	mac := hmac.New(sha256.New, s.secret)
	_, _ = mac.Write([]byte(token))
	return hex.EncodeToString(mac.Sum(nil))
}

func (s *Server) withCORS(next http.Handler) http.Handler {
	allowed := map[string]bool{}
	for _, origin := range s.config.AllowedOrigins {
		allowed[origin] = true
	}

	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		origin := r.Header.Get("Origin")
		if allowed[origin] {
			w.Header().Set("Access-Control-Allow-Origin", origin)
			w.Header().Set("Vary", "Origin")
			w.Header().Set("Access-Control-Allow-Headers", "Authorization, Content-Type, Content-Encoding")
			w.Header().Set("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
		}
		if r.Method == http.MethodOptions {
			w.WriteHeader(http.StatusNoContent)
			return
		}
		next.ServeHTTP(w, r)
	})
}

func (s *Server) retentionLoop() {
	ticker := time.NewTicker(12 * time.Hour)
	defer ticker.Stop()
	for {
		s.cleanup()
		<-ticker.C
	}
}

func (s *Server) cleanup() {
	if s.config.RetentionDays <= 0 {
		return
	}
	cutoff := time.Now().AddDate(0, 0, -s.config.RetentionDays)
	entries, err := os.ReadDir(s.config.StorageDir)
	if err != nil {
		return
	}
	for _, entry := range entries {
		if !entry.IsDir() {
			continue
		}
		day, err := time.Parse("2006-01-02", entry.Name())
		if err == nil && day.Before(cutoff) {
			_ = os.RemoveAll(filepath.Join(s.config.StorageDir, entry.Name()))
		}
	}
}

func randomID() string {
	data := make([]byte, 24)
	_, _ = rand.Read(data)
	return base64.RawURLEncoding.EncodeToString(data)
}

func validateGzip(path string, maxDecompressedBytes int64) error {
	file, err := os.Open(path)
	if err != nil {
		return err
	}
	defer file.Close()
	reader, err := gzip.NewReader(file)
	if err != nil {
		return err
	}
	limited := &io.LimitedReader{R: reader, N: maxDecompressedBytes + 1}
	written, err := io.Copy(io.Discard, limited)
	closeErr := reader.Close()
	if err != nil {
		return err
	}
	if written > maxDecompressedBytes {
		return fmt.Errorf("gzip exceeds decompressed limit")
	}
	return closeErr
}

func writeJSON(w http.ResponseWriter, value any) {
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(value)
}
