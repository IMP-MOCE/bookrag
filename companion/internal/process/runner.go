// Package process — тонкая абстракция запуска внешнего процесса. Менеджер
// llama зависит от интерфейсов отсюда, а не от os/exec напрямую, чтобы тесты
// подставляли фейковый runner (без реального бинаря и GPU).
package process

import (
	"context"
	"os/exec"
)

// Handle — запущенный процесс.
type Handle interface {
	// Wait блокируется до завершения процесса и возвращает ошибку выхода.
	Wait() error
	// Kill принудительно завершает процесс.
	Kill() error
	// Pid — идентификатор процесса (0, если неизвестен).
	Pid() int
}

// Runner запускает процесс по имени и аргументам.
type Runner interface {
	Start(ctx context.Context, name string, args []string) (Handle, error)
}

// OSRunner — боевая реализация поверх os/exec.
type OSRunner struct{}

func (OSRunner) Start(ctx context.Context, name string, args []string) (Handle, error) {
	cmd := exec.CommandContext(ctx, name, args...)
	if err := cmd.Start(); err != nil {
		return nil, err
	}
	return &osHandle{cmd: cmd}, nil
}

type osHandle struct {
	cmd *exec.Cmd
}

func (h *osHandle) Wait() error { return h.cmd.Wait() }

func (h *osHandle) Kill() error {
	if h.cmd.Process == nil {
		return nil
	}
	return h.cmd.Process.Kill()
}

func (h *osHandle) Pid() int {
	if h.cmd.Process == nil {
		return 0
	}
	return h.cmd.Process.Pid
}
