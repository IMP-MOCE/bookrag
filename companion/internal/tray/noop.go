package tray

import (
	"context"
	"sync"
)

// NoopController — реализация без UI. Используется в headless-режиме и в
// тестах. Run блокируется до Stop() или ctx.Done(); SetStatus сохраняет
// последнее значение под мьютексом и доступно для проверки в тестах.
type NoopController struct {
	mu     sync.Mutex
	last   Update
	done   chan struct{}
	closed bool
}

// NewNoop возвращает готовый к использованию NoopController.
func NewNoop() *NoopController {
	return &NoopController{done: make(chan struct{})}
}

// Run блокирует до Stop() или отмены ctx. Безопасно вызывать из любой
// горутины; для совместимости с реальной реализацией обычно вызывается из
// main.
func (n *NoopController) Run(ctx context.Context) {
	select {
	case <-ctx.Done():
	case <-n.done:
	}
}

// SetStatus сохраняет последнее обновление. Thread-safe.
func (n *NoopController) SetStatus(s Status, detail string) {
	n.mu.Lock()
	n.last = Update{Status: s, Detail: detail}
	n.mu.Unlock()
}

// Last возвращает последнее SetStatus (для тестов).
func (n *NoopController) Last() Update {
	n.mu.Lock()
	defer n.mu.Unlock()
	return n.last
}

// Stop разблокирует Run. Идемпотентен.
func (n *NoopController) Stop() {
	n.mu.Lock()
	defer n.mu.Unlock()
	if n.closed {
		return
	}
	n.closed = true
	close(n.done)
}
