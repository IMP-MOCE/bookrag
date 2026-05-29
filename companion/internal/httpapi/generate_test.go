package httpapi

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

type fakeUpstream struct {
	calls  int
	status int
	body   string
	header http.Header
	err    error
}

func (f *fakeUpstream) Post(_ context.Context, _ string, _ []byte) (*http.Response, error) {
	f.calls++
	if f.err != nil {
		return nil, f.err
	}
	h := f.header
	if h == nil {
		h = http.Header{}
	}
	return &http.Response{
		StatusCode: f.status,
		Status:     http.StatusText(f.status),
		Body:       io.NopCloser(strings.NewReader(f.body)),
		Header:     h,
	}, nil
}

func genHandler(ctrl ModelController, up Upstream) http.Handler {
	return New(Config{Addr: "127.0.0.1:0", Version: "t", Controller: ctrl, Upstream: up}).Handler()
}

func genReq(body string) *http.Request {
	r := httptest.NewRequest(http.MethodPost, "/generate", strings.NewReader(body))
	r.RemoteAddr = "127.0.0.1:5555"
	return r
}

const okReq = `{"messages":[{"role":"user","content":"hi"}]}`

func TestGenerateNilDepsIs503(t *testing.T) {
	rec := httptest.NewRecorder()
	genHandler(nil, nil).ServeHTTP(rec, genReq(okReq))
	if rec.Code != http.StatusServiceUnavailable {
		t.Fatalf("status = %d, want 503", rec.Code)
	}
}

func TestGenerateSuccessNonStream(t *testing.T) {
	ctrl := &fakeController{}
	up := &fakeUpstream{
		status: 200,
		body:   `{"choices":[{"message":{"content":"HELLO"}}]}`,
	}
	rec := httptest.NewRecorder()
	genHandler(ctrl, up).ServeHTTP(rec, genReq(okReq))

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200", rec.Code)
	}
	var body map[string]string
	_ = json.Unmarshal(rec.Body.Bytes(), &body)
	if body["content"] != "HELLO" {
		t.Fatalf("content = %q, want HELLO", body["content"])
	}
	if !ctrl.running || ctrl.touched != 1 || up.calls != 1 {
		t.Fatalf("ensure/touch/upstream: running=%v touched=%d calls=%d",
			ctrl.running, ctrl.touched, up.calls)
	}
}

func TestGenerateEnsureRunningErrorIs503(t *testing.T) {
	ctrl := &fakeController{ensureErr: errors.New("no gpu")}
	up := &fakeUpstream{status: 200, body: "{}"}
	rec := httptest.NewRecorder()
	genHandler(ctrl, up).ServeHTTP(rec, genReq(okReq))

	if rec.Code != http.StatusServiceUnavailable {
		t.Fatalf("status = %d, want 503", rec.Code)
	}
	if up.calls != 0 {
		t.Fatal("upstream не должен вызываться, если модель не поднялась")
	}
}

func TestGenerateUpstreamNon200Is502(t *testing.T) {
	rec := httptest.NewRecorder()
	genHandler(&fakeController{}, &fakeUpstream{status: 500, body: "boom"}).
		ServeHTTP(rec, genReq(okReq))
	if rec.Code != http.StatusBadGateway {
		t.Fatalf("status = %d, want 502", rec.Code)
	}
}

func TestGenerateInvalidJSONIs400(t *testing.T) {
	rec := httptest.NewRecorder()
	genHandler(&fakeController{}, &fakeUpstream{status: 200}).
		ServeHTTP(rec, genReq("{not json"))
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, want 400", rec.Code)
	}
}

func TestGenerateStreamPassthrough(t *testing.T) {
	sse := "data: {\"delta\":\"a\"}\n\ndata: [DONE]\n\n"
	up := &fakeUpstream{status: 200, body: sse}
	rec := httptest.NewRecorder()
	genHandler(&fakeController{}, up).
		ServeHTTP(rec, genReq(`{"messages":[{"role":"user","content":"hi"}],"stream":true}`))

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200", rec.Code)
	}
	if ct := rec.Header().Get("Content-Type"); ct != "text/event-stream" {
		t.Fatalf("content-type = %q", ct)
	}
	if rec.Body.String() != sse {
		t.Fatalf("SSE не проксирован дословно: %q", rec.Body.String())
	}
}
