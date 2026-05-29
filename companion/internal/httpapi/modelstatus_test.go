package httpapi

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
)

type fakeReporter struct{ st DownloadState }

func (f fakeReporter) DownloadProgress() DownloadState { return f.st }

func statusHandler(ctrl ModelController, dl DownloadReporter) http.Handler {
	return New(Config{Addr: "127.0.0.1:0", Version: "t", Controller: ctrl, Download: dl}).Handler()
}

func TestModelStatusNoReporterOmitsDownload(t *testing.T) {
	rec := httptest.NewRecorder()
	statusHandler(&fakeController{running: true, modelID: "m"}, nil).
		ServeHTTP(rec, req(http.MethodGet, "/model/status", ""))

	var m map[string]any
	_ = json.Unmarshal(rec.Body.Bytes(), &m)
	if _, has := m["download"]; has {
		t.Fatal("без reporter блок download должен опускаться")
	}
	if m["running"] != true || m["modelReady"] != true {
		t.Fatalf("state не отражён: %+v", m)
	}
}

func TestModelStatusWithDownloadProgress(t *testing.T) {
	rep := fakeReporter{st: DownloadState{Phase: "downloading", Done: 50, Total: 200}}
	rec := httptest.NewRecorder()
	statusHandler(&fakeController{}, rep).
		ServeHTTP(rec, req(http.MethodGet, "/model/status", ""))

	var resp modelStatusResponse
	if err := json.Unmarshal(rec.Body.Bytes(), &resp); err != nil {
		t.Fatal(err)
	}
	if resp.Download == nil || resp.Download.Phase != "downloading" ||
		resp.Download.Done != 50 || resp.Download.Total != 200 {
		t.Fatalf("download не проброшен: %+v", resp.Download)
	}
}
