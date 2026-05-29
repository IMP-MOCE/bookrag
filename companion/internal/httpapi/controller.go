package httpapi

import (
	"context"
	"net/http"
)

// ModelState — снимок состояния llama-бэкенда для /health и /model/status.
type ModelState struct {
	Running bool
	ModelID string
}

// ModelController — то, что httpapi ждёт от менеджера llama. Интерфейс держим
// здесь, чтобы httpapi не зависел от пакета llama (адаптер — в main).
// Может быть nil в M1/тестах: тогда /load|/unload отвечают 503, а /health
// показывает modelReady=false.
type ModelController interface {
	EnsureRunning(ctx context.Context) error
	Stop() error
	State() ModelState
	// Touch сбрасывает idle-таймер (вызывается на каждый /generate).
	Touch()
}

// Upstream — транспорт к дочернему llama-server. Инъектируется, чтобы
// /generate тестировался без реального процесса (fake возвращает каннед
// http.Response).
type Upstream interface {
	Post(ctx context.Context, path string, body []byte) (*http.Response, error)
}
