package main

import (
	"bytes"
	"compress/gzip"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"
	"time"
)

func testServer(t *testing.T, jellyfin http.Handler) (*Server, *httptest.Server) {
	t.Helper()
	jellyfinServer := httptest.NewServer(jellyfin)
	t.Cleanup(jellyfinServer.Close)

	dir := t.TempDir()
	secret := []byte("test-secret")
	server := &Server{
		config: Config{
			JellyfinBaseURL:          jellyfinServer.URL,
			ListenAddr:               "127.0.0.1:0",
			StorageDir:               filepath.Join(dir, "uploads"),
			RetentionDays:            30,
			MaxCompressedUploadBytes: 1024 * 1024,
			AllowedOrigins:           []string{"https://jellyfin.example"},
			TokenTTLSeconds:          300,
		},
		client: jellyfinServer.Client(),
		secret: secret,
		tokens: map[string]uploadToken{},
	}
	mux := http.NewServeMux()
	mux.HandleFunc("POST /v1/uploads/init", server.initUpload)
	mux.HandleFunc("POST /v1/uploads/", server.receiveUpload)
	httpServer := httptest.NewServer(server.withCORS(mux))
	t.Cleanup(httpServer.Close)
	return server, httpServer
}

func TestInitRejectsInvalidJellyfinAuth(t *testing.T) {
	_, httpServer := testServer(t, http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		http.Error(w, "no", http.StatusUnauthorized)
	}))

	resp, err := http.Post(httpServer.URL+"/v1/uploads/init", "application/json", bytes.NewBufferString(`{}`))
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusUnauthorized {
		t.Fatalf("expected 401, got %d", resp.StatusCode)
	}
}

func TestUploadAcceptsOneUseToken(t *testing.T) {
	server, httpServer := testServer(t, http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		_ = json.NewEncoder(w).Encode(jellyfinUser{ID: "user-1", Name: "test"})
	}))

	initBody := bytes.NewBufferString(`{"runId":"run-1","itemId":"item-1"}`)
	req, err := http.NewRequest(http.MethodPost, httpServer.URL+"/v1/uploads/init", initBody)
	if err != nil {
		t.Fatal(err)
	}
	req.Header.Set("Authorization", "MediaBrowser Token=abc")
	req.Header.Set("Content-Type", "application/json")
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("expected init 200, got %d", resp.StatusCode)
	}

	var init initResponse
	if err := json.NewDecoder(resp.Body).Decode(&init); err != nil {
		t.Fatal(err)
	}

	var compressed bytes.Buffer
	writer := gzip.NewWriter(&compressed)
	_, _ = writer.Write([]byte(`{"ok":true}`))
	_ = writer.Close()

	uploadReq, err := http.NewRequest(http.MethodPost, httpServer.URL+"/v1/uploads/"+init.UploadID, &compressed)
	if err != nil {
		t.Fatal(err)
	}
	uploadReq.Header.Set("Authorization", "Bearer "+init.Token)
	uploadReq.Header.Set("Content-Encoding", "gzip")
	uploadResp, err := http.DefaultClient.Do(uploadReq)
	if err != nil {
		t.Fatal(err)
	}
	defer uploadResp.Body.Close()
	if uploadResp.StatusCode != http.StatusOK {
		t.Fatalf("expected upload 200, got %d", uploadResp.StatusCode)
	}

	reuseReq, _ := http.NewRequest(http.MethodPost, httpServer.URL+"/v1/uploads/"+init.UploadID, bytes.NewBufferString("{}"))
	reuseReq.Header.Set("Authorization", "Bearer "+init.Token)
	reuseReq.Header.Set("Content-Encoding", "identity")
	reuseResp, err := http.DefaultClient.Do(reuseReq)
	if err != nil {
		t.Fatal(err)
	}
	defer reuseResp.Body.Close()
	if reuseResp.StatusCode != http.StatusUnauthorized {
		t.Fatalf("expected token reuse 401, got %d", reuseResp.StatusCode)
	}

	metadataPath := filepath.Join(server.config.StorageDir, time.Now().UTC().Format("2006-01-02"), init.UploadID, "metadata.json")
	if _, err := os.Stat(metadataPath); err != nil {
		t.Fatalf("expected metadata file: %v", err)
	}
}

func TestUploadRejectsUnsupportedEncoding(t *testing.T) {
	_, httpServer := testServer(t, http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		_ = json.NewEncoder(w).Encode(jellyfinUser{ID: "user-1", Name: "test"})
	}))

	req, _ := http.NewRequest(http.MethodPost, httpServer.URL+"/v1/uploads/init", bytes.NewBufferString(`{}`))
	req.Header.Set("Authorization", "MediaBrowser Token=abc")
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	var init initResponse
	_ = json.NewDecoder(resp.Body).Decode(&init)

	uploadReq, _ := http.NewRequest(http.MethodPost, httpServer.URL+"/v1/uploads/"+init.UploadID, bytes.NewBufferString("{}"))
	uploadReq.Header.Set("Authorization", "Bearer "+init.Token)
	uploadReq.Header.Set("Content-Encoding", "br")
	uploadResp, err := http.DefaultClient.Do(uploadReq)
	if err != nil {
		t.Fatal(err)
	}
	defer uploadResp.Body.Close()
	if uploadResp.StatusCode != http.StatusUnsupportedMediaType {
		t.Fatalf("expected 415, got %d", uploadResp.StatusCode)
	}
}
