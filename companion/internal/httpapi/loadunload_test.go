package httpapi

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"testing"
)

type fakeController struct {
	ensureErr error
	running   bool
	modelID   string
	stopped   bool
	touched   int
}

func (f *fakeController) EnsureRunning(context.Context) error {
	if f.ensureErr == nil {
		f.running = true
	}
	return f.ensureErr
}
func (f *fakeController) Stop() error {
	f.stopped = true
	f.running = false
	return nil
}
func (f *fakeController) Touch() { f.touched++ }
func (f *fakeController) State() ModelState {
	return ModelState{Running: f.running, ModelID: f.modelID}
}

func handlerWith(ctrl ModelController) http.Handler {
	return New(Config{Addr: "127.0.0.1:0", Version: "test", Controller: ctrl}).Handler()
}

func TestLoadSuccess(t *testing.T) {
	ctrl := &fakeController{modelID: "bookrag-4b"}
	rec := httptest.NewRecorder()
	handlerWith(ctrl).ServeHTTP(rec, req(http.MethodPost, "/load", ""))

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200", rec.Code)
	}
	var body map[string]bool
	_ = json.Unmarshal(rec.Body.Bytes(), &body)
	if !body["loaded"] || !ctrl.running {
		t.Fatalf("unexpected: body=%v running=%v", body, ctrl.running)
	}
}

func TestLoadControllerError(t *testing.T) {
	ctrl := &fakeController{ensureErr: errors.New("boom")}
	rec := httptest.NewRecorder()
	handlerWith(ctrl).ServeHTTP(rec, req(http.MethodPost, "/load", ""))

	if rec.Code != http.StatusServiceUnavailable {
		t.Fatalf("status = %d, want 503", rec.Code)
	}
}

func TestLoadNilControllerIs503(t *testing.T) {
	rec := httptest.NewRecorder()
	handlerWith(nil).ServeHTTP(rec, req(http.MethodPost, "/load", ""))
	if rec.Code != http.StatusServiceUnavailable {
		t.Fatalf("status = %d, want 503", rec.Code)
	}
}

func TestUnloadStopsController(t *testing.T) {
	ctrl := &fakeController{running: true}
	rec := httptest.NewRecorder()
	handlerWith(ctrl).ServeHTTP(rec, req(http.MethodPost, "/unload", ""))

	if rec.Code != http.StatusOK || !ctrl.stopped {
		t.Fatalf("status=%d stopped=%v, want 200/true", rec.Code, ctrl.stopped)
	}
}

func TestHealthReflectsRunningModel(t *testing.T) {
	ctrl := &fakeController{running: true, modelID: "bookrag-4b"}
	rec := httptest.NewRecorder()
	handlerWith(ctrl).ServeHTTP(rec, req(http.MethodGet, "/health", ""))

	var body healthResponse
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
		t.Fatal(err)
	}
	if !body.ModelReady || body.ModelID == nil || *body.ModelID != "bookrag-4b" {
		t.Fatalf("unexpected health: %+v", body)
	}
}
