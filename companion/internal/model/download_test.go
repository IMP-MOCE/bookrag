package model

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func sum(b []byte) string {
	h := sha256.Sum256(b)
	return hex.EncodeToString(h[:])
}

type fakeDoer struct {
	full        []byte
	calls       int
	ignoreRange bool
	failIfNoUse bool
}

func mkResp(code int, b []byte) *http.Response {
	return &http.Response{
		StatusCode:    code,
		Status:        http.StatusText(code),
		Body:          io.NopCloser(bytes.NewReader(b)),
		ContentLength: int64(len(b)),
		Header:        http.Header{},
	}
}

func (f *fakeDoer) Do(req *http.Request) (*http.Response, error) {
	f.calls++
	if f.failIfNoUse {
		return nil, errors.New("doer не должен вызываться")
	}
	rng := req.Header.Get("Range")
	if rng == "" || f.ignoreRange {
		return mkResp(http.StatusOK, f.full), nil
	}
	var n int64
	_, _ = fmt.Sscanf(rng, "bytes=%d-", &n)
	return mkResp(http.StatusPartialContent, f.full[n:]), nil
}

const src = "org/bookrag-4b"

func TestSourceURL(t *testing.T) {
	if got := (Source{Repo: src, File: "m.gguf"}).URL(); got !=
		"https://huggingface.co/org/bookrag-4b/resolve/main/m.gguf" {
		t.Fatalf("url = %q", got)
	}
	if got := (Source{Repo: src, File: "m.gguf", Revision: "v2"}).URL(); !strings.Contains(got, "/resolve/v2/") {
		t.Fatalf("revision не учтена: %q", got)
	}
}

func TestFreshDownload(t *testing.T) {
	data := []byte("MODELWEIGHTS-1234567890")
	d := &Downloader{Dir: t.TempDir(), Client: &fakeDoer{full: data}}
	path, err := d.EnsureLocal(context.Background(),
		Source{Repo: src, File: "m.gguf", SHA256: sum(data)})
	if err != nil {
		t.Fatal(err)
	}
	got, _ := os.ReadFile(path)
	if !bytes.Equal(got, data) {
		t.Fatalf("содержимое не совпало: %q", got)
	}
}

func TestResumeFromPartial(t *testing.T) {
	data := []byte("AAAABBBBCCCCDDDDEEEE")
	dir := t.TempDir()
	// Уже скачана половина.
	if err := os.WriteFile(filepath.Join(dir, "m.gguf.part"), data[:8], 0o644); err != nil {
		t.Fatal(err)
	}
	doer := &fakeDoer{full: data}
	d := &Downloader{Dir: dir, Client: doer}
	path, err := d.EnsureLocal(context.Background(),
		Source{Repo: src, File: "m.gguf", SHA256: sum(data)})
	if err != nil {
		t.Fatal(err)
	}
	got, _ := os.ReadFile(path)
	if !bytes.Equal(got, data) {
		t.Fatalf("докачка дала %q", got)
	}
}

func TestServerIgnoresRange(t *testing.T) {
	data := []byte("FULLCONTENTHERE")
	dir := t.TempDir()
	_ = os.WriteFile(filepath.Join(dir, "m.gguf.part"), []byte("STALE"), 0o644)
	d := &Downloader{Dir: dir, Client: &fakeDoer{full: data, ignoreRange: true}}
	path, err := d.EnsureLocal(context.Background(), Source{Repo: src, File: "m.gguf"})
	if err != nil {
		t.Fatal(err)
	}
	got, _ := os.ReadFile(path)
	if !bytes.Equal(got, data) {
		t.Fatalf("при 200 (no range) ожидалась полная перезапись, got %q", got)
	}
}

func TestChecksumMismatch(t *testing.T) {
	dir := t.TempDir()
	d := &Downloader{Dir: dir, Client: &fakeDoer{full: []byte("xxx")}}
	_, err := d.EnsureLocal(context.Background(),
		Source{Repo: src, File: "m.gguf", SHA256: sum([]byte("different"))})
	if err == nil {
		t.Fatal("ожидалась ошибка sha256")
	}
	if _, statErr := os.Stat(filepath.Join(dir, "m.gguf.part")); !os.IsNotExist(statErr) {
		t.Fatal(".part должен быть удалён при несовпадении хэша")
	}
}

func TestExistingValidFileSkipsDownload(t *testing.T) {
	data := []byte("ALREADYHERE")
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, "m.gguf"), data, 0o644); err != nil {
		t.Fatal(err)
	}
	doer := &fakeDoer{failIfNoUse: true}
	d := &Downloader{Dir: dir, Client: doer}
	path, err := d.EnsureLocal(context.Background(),
		Source{Repo: src, File: "m.gguf", SHA256: sum(data)})
	if err != nil {
		t.Fatal(err)
	}
	if doer.calls != 0 {
		t.Fatalf("валидный файл не должен качаться, calls=%d", doer.calls)
	}
	if filepath.Base(path) != "m.gguf" {
		t.Fatalf("path = %q", path)
	}
}

func TestProgressReachesReady(t *testing.T) {
	data := []byte("PROGRESSCHECK")
	var last Progress
	d := &Downloader{
		Dir:        t.TempDir(),
		Client:     &fakeDoer{full: data},
		OnProgress: func(p Progress) { last = p },
	}
	if _, err := d.EnsureLocal(context.Background(),
		Source{Repo: src, File: "m.gguf"}); err != nil {
		t.Fatal(err)
	}
	if last.Phase != PhaseReady {
		t.Fatalf("последняя фаза = %q, want ready", last.Phase)
	}
}
