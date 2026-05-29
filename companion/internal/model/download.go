// Package model — загрузчик дообученного GGUF при первом запуске. Источник —
// Hugging Face (resolve-URL). Скачивание возобновляемое (HTTP Range),
// с проверкой sha256 и колбэком прогресса (его читает GET /model/status).
// HTTP-клиент инъектируется → тесты идут через httptest, без сети.
package model

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
)

// Phase — стадия для /model/status.
type Phase string

const (
	PhaseIdle        Phase = "idle"
	PhaseDownloading Phase = "downloading"
	PhaseVerifying   Phase = "verifying"
	PhaseReady       Phase = "ready"
	PhaseError       Phase = "error"
)

// Progress — снимок состояния загрузки.
type Progress struct {
	Phase Phase
	Done  int64
	Total int64
}

// Source описывает файл модели на Hugging Face.
type Source struct {
	Repo     string // напр. "org/bookrag-4b-gguf"
	File     string // напр. "bookrag-4b-q4_k_m.gguf"
	Revision string // ветка/тег/коммит; пусто → "main"
	SHA256   string // ожидаемый хэш (hex); пусто → проверка пропускается
}

// URL строит HF resolve-ссылку на файл.
func (s Source) URL() string {
	rev := s.Revision
	if rev == "" {
		rev = "main"
	}
	return fmt.Sprintf("https://huggingface.co/%s/resolve/%s/%s", s.Repo, rev, s.File)
}

// HTTPDoer — то, что нужно загрузчику от http.Client (для инъекции в тестах).
type HTTPDoer interface {
	Do(*http.Request) (*http.Response, error)
}

// Downloader скачивает Source в Dir.
type Downloader struct {
	Dir        string
	Client     HTTPDoer
	OnProgress func(Progress) // может быть nil
}

func (d *Downloader) emit(p Progress) {
	if d.OnProgress != nil {
		d.OnProgress(p)
	}
}

// EnsureLocal возвращает путь к локальному файлу модели, при необходимости
// скачивая его. Идемпотентно: готовый валидный файл не перекачивается,
// частичный (.part) — докачивается.
func (d *Downloader) EnsureLocal(ctx context.Context, s Source) (string, error) {
	if s.Repo == "" || s.File == "" {
		return "", errors.New("model: Source.Repo/File не заданы")
	}
	final := filepath.Join(d.Dir, s.File)
	part := final + ".part"

	if fi, err := os.Stat(final); err == nil && !fi.IsDir() {
		if s.SHA256 == "" {
			d.emit(Progress{Phase: PhaseReady, Done: fi.Size(), Total: fi.Size()})
			return final, nil
		}
		ok, herr := checkSHA256(final, s.SHA256)
		if herr != nil {
			return "", herr
		}
		if ok {
			d.emit(Progress{Phase: PhaseReady, Done: fi.Size(), Total: fi.Size()})
			return final, nil
		}
		// Хэш не сошёлся — файл битый, перекачиваем с нуля.
		_ = os.Remove(final)
	}

	if err := os.MkdirAll(d.Dir, 0o755); err != nil {
		return "", err
	}
	if err := d.download(ctx, s, part); err != nil {
		d.emit(Progress{Phase: PhaseError})
		return "", err
	}

	if s.SHA256 != "" {
		d.emit(Progress{Phase: PhaseVerifying})
		ok, herr := checkSHA256(part, s.SHA256)
		if herr != nil {
			return "", herr
		}
		if !ok {
			_ = os.Remove(part)
			return "", errors.New("model: sha256 скачанного файла не совпал")
		}
	}
	if err := os.Rename(part, final); err != nil {
		return "", err
	}
	fi, _ := os.Stat(final)
	var size int64
	if fi != nil {
		size = fi.Size()
	}
	d.emit(Progress{Phase: PhaseReady, Done: size, Total: size})
	return final, nil
}

func (d *Downloader) download(ctx context.Context, s Source, part string) error {
	var start int64
	if fi, err := os.Stat(part); err == nil {
		start = fi.Size()
	}

	req, err := http.NewRequestWithContext(ctx, http.MethodGet, s.URL(), nil)
	if err != nil {
		return err
	}
	if start > 0 {
		req.Header.Set("Range", fmt.Sprintf("bytes=%d-", start))
	}
	resp, err := d.Client.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()

	switch resp.StatusCode {
	case http.StatusOK:
		// Сервер не поддержал Range — качаем с нуля.
		start = 0
		_ = os.Remove(part)
	case http.StatusPartialContent:
		// Докачка с offset.
	default:
		return fmt.Errorf("model: статус загрузки %s", resp.Status)
	}

	flag := os.O_CREATE | os.O_WRONLY
	if start > 0 {
		flag |= os.O_APPEND
	} else {
		flag |= os.O_TRUNC
	}
	f, err := os.OpenFile(part, flag, 0o644)
	if err != nil {
		return err
	}
	defer f.Close()

	total := start + resp.ContentLength // ContentLength = остаток при 206
	done := start
	buf := make([]byte, 256*1024)
	for {
		n, rerr := resp.Body.Read(buf)
		if n > 0 {
			if _, werr := f.Write(buf[:n]); werr != nil {
				return werr
			}
			done += int64(n)
			d.emit(Progress{Phase: PhaseDownloading, Done: done, Total: total})
		}
		if rerr == io.EOF {
			return nil
		}
		if rerr != nil {
			return rerr
		}
	}
}

func checkSHA256(path, want string) (bool, error) {
	f, err := os.Open(path)
	if err != nil {
		return false, err
	}
	defer f.Close()
	h := sha256.New()
	if _, err := io.Copy(h, f); err != nil {
		return false, err
	}
	return hex.EncodeToString(h.Sum(nil)) == want, nil
}
