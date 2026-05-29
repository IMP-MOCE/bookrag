package httpapi

import (
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"testing"
)

const testOrigin = "chrome-extension://abcdefghabcdefghabcdefghabcdefgh"

func newTestHandler(allowed []string) http.Handler {
	return New(Config{
		Addr:           "127.0.0.1:0",
		AllowedOrigins: allowed,
		Version:        "test",
	}).Handler()
}

// req строит запрос с loopback RemoteAddr (иначе withLoopbackOnly отклонит).
func req(method, path, origin string) *http.Request {
	r := httptest.NewRequest(method, path, nil)
	r.RemoteAddr = "127.0.0.1:54321"
	if origin != "" {
		r.Header.Set("Origin", origin)
	}
	return r
}

func TestHealthOKWithAllowedOrigin(t *testing.T) {
	h := newTestHandler([]string{testOrigin})
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req(http.MethodGet, "/health", testOrigin))

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200", rec.Code)
	}
	if ct := rec.Header().Get("Content-Type"); ct != "application/json" {
		t.Fatalf("content-type = %q, want application/json", ct)
	}
	var body healthResponse
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
		t.Fatalf("invalid JSON: %v", err)
	}
	if !body.OK || body.ModelReady || body.ModelID != nil || body.Version != "test" {
		t.Fatalf("unexpected body: %+v", body)
	}
}

func TestHealthRejectsDisallowedOrigin(t *testing.T) {
	h := newTestHandler([]string{testOrigin})
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req(http.MethodGet, "/health", "https://evil.example"))

	if rec.Code != http.StatusForbidden {
		t.Fatalf("status = %d, want 403", rec.Code)
	}
}

func TestHealthRejectsMissingOriginWhenAllowlistSet(t *testing.T) {
	h := newTestHandler([]string{testOrigin})
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req(http.MethodGet, "/health", ""))

	if rec.Code != http.StatusForbidden {
		t.Fatalf("status = %d, want 403", rec.Code)
	}
}

func TestDevModeEmptyAllowlistSkipsOriginCheck(t *testing.T) {
	h := newTestHandler(nil)
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req(http.MethodGet, "/health", "https://anything.example"))

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200 (dev mode)", rec.Code)
	}
}

func TestNonLoopbackRejected(t *testing.T) {
	h := newTestHandler(nil)
	r := httptest.NewRequest(http.MethodGet, "/health", nil)
	r.RemoteAddr = "8.8.8.8:443"
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, r)

	if rec.Code != http.StatusForbidden {
		t.Fatalf("status = %d, want 403", rec.Code)
	}
}

func TestWrongMethodIs405(t *testing.T) {
	h := newTestHandler(nil)
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req(http.MethodPost, "/health", ""))

	if rec.Code != http.StatusMethodNotAllowed {
		t.Fatalf("status = %d, want 405", rec.Code)
	}
}

func TestUnknownPathIs404(t *testing.T) {
	h := newTestHandler(nil)
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req(http.MethodGet, "/nope", ""))

	if rec.Code != http.StatusNotFound {
		t.Fatalf("status = %d, want 404", rec.Code)
	}
	_, _ = io.ReadAll(rec.Body)
}
