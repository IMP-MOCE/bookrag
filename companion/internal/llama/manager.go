// Package llama управляет дочерним процессом llama-server: ленивый спавн по
// запросу, проверка готовности, idle-таймер (выгрузка из VRAM по простою),
// принудительный stop. Сетевой/процессный ввод-вывод инъектируется, поэтому
// логику можно полностью протестировать без реального бинаря и GPU.
package llama

import (
	"context"
	"errors"
	"log/slog"
	"strconv"
	"sync"
	"time"

	"github.com/bookrag/companion/internal/process"
)

// ReadyFunc проверяет, что дочерний llama-server отвечает (его /health).
// Возвращает nil, когда готов. В тестах подменяется.
type ReadyFunc func(ctx context.Context) error

// Config — параметры менеджера.
type Config struct {
	BinaryPath  string
	ModelPath   string
	ModelID     string
	Host        string // адрес дочернего llama-server (loopback)
	Port        int
	NGL         int           // -ngl: слоёв на GPU (999 = всё на GPU)
	CtxSize     int           // --ctx-size
	ExtraArgs   []string      // дополнительные флаги llama-server
	IdleTimeout time.Duration // простой до авто-выгрузки (0 = не выгружать)
	ReadyWait   time.Duration // максимум ждать готовности после старта

	Runner process.Runner
	Ready  ReadyFunc
	// Warmup — необязательный прогон после готовности (напр. 1-токенная
	// генерация), чтобы компиляция/прогрев ушли с критического пути первого
	// реального запроса. Ошибка warmup не фатальна. Инъектируем для тестов.
	Warmup ReadyFunc
	Logger *slog.Logger
	// Clock для тестируемого idle-таймера; nil → real time.
	now func() time.Time
}

// State — снимок состояния для /health и /model/status.
type State struct {
	Running bool
	ModelID string
}

// Manager потокобезопасен.
type Manager struct {
	cfg Config
	log *slog.Logger

	mu       sync.Mutex
	handle   process.Handle
	running  bool
	idleStop chan struct{} // закрывается, чтобы погасить idle-горутину
	lastUse  time.Time
}

var ErrNotConfigured = errors.New("llama: BinaryPath/ModelPath не заданы")

func New(cfg Config) *Manager {
	if cfg.Logger == nil {
		cfg.Logger = slog.Default()
	}
	if cfg.Runner == nil {
		cfg.Runner = process.OSRunner{}
	}
	if cfg.now == nil {
		cfg.now = time.Now
	}
	if cfg.ReadyWait == 0 {
		cfg.ReadyWait = 90 * time.Second
	}
	return &Manager{cfg: cfg, log: cfg.Logger}
}

func (m *Manager) buildArgs() []string {
	args := []string{
		"--host", m.cfg.Host,
		"--port", strconv.Itoa(m.cfg.Port),
		"-m", m.cfg.ModelPath,
		"-ngl", strconv.Itoa(m.cfg.NGL),
	}
	if m.cfg.CtxSize > 0 {
		args = append(args, "--ctx-size", strconv.Itoa(m.cfg.CtxSize))
	}
	return append(args, m.cfg.ExtraArgs...)
}

// EnsureRunning идемпотентно: если процесс уже жив — только сбрасывает
// idle-таймер; иначе спавнит llama-server и ждёт готовности до ReadyWait.
func (m *Manager) EnsureRunning(ctx context.Context) error {
	m.mu.Lock()
	if m.running {
		m.lastUse = m.cfg.now()
		m.mu.Unlock()
		return nil
	}
	if m.cfg.BinaryPath == "" || m.cfg.ModelPath == "" {
		m.mu.Unlock()
		return ErrNotConfigured
	}
	m.mu.Unlock()

	m.log.Info("llama: запуск", "bin", m.cfg.BinaryPath, "model", m.cfg.ModelID)
	h, err := m.cfg.Runner.Start(ctx, m.cfg.BinaryPath, m.buildArgs())
	if err != nil {
		return err
	}

	if err := m.waitReady(ctx); err != nil {
		_ = h.Kill()
		return err
	}

	m.mu.Lock()
	m.handle = h
	m.running = true
	m.lastUse = m.cfg.now()
	m.idleStop = make(chan struct{})
	stopCh := m.idleStop
	m.mu.Unlock()

	if m.cfg.IdleTimeout > 0 {
		go m.idleLoop(stopCh)
	}
	m.log.Info("llama: готов", "pid", h.Pid())

	if m.cfg.Warmup != nil {
		if err := m.cfg.Warmup(ctx); err != nil {
			m.log.Warn("llama: warmup не удался (не критично)", "err", err)
		} else {
			m.log.Info("llama: warmup выполнен")
		}
	}
	return nil
}

func (m *Manager) waitReady(ctx context.Context) error {
	if m.cfg.Ready == nil {
		return nil
	}
	deadline := m.cfg.now().Add(m.cfg.ReadyWait)
	for {
		if err := m.cfg.Ready(ctx); err == nil {
			return nil
		}
		if !m.cfg.now().Before(deadline) {
			return errors.New("llama: дочерний сервер не стал готов за ReadyWait")
		}
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-time.After(250 * time.Millisecond):
		}
	}
}

// Touch сбрасывает idle-таймер. Вызывается на каждый /generate.
func (m *Manager) Touch() {
	m.mu.Lock()
	if m.running {
		m.lastUse = m.cfg.now()
	}
	m.mu.Unlock()
}

func (m *Manager) idleLoop(stop <-chan struct{}) {
	ticker := time.NewTicker(m.cfg.IdleTimeout / 2)
	defer ticker.Stop()
	for {
		select {
		case <-stop:
			return
		case <-ticker.C:
			m.mu.Lock()
			idle := m.cfg.now().Sub(m.lastUse)
			m.mu.Unlock()
			if idle >= m.cfg.IdleTimeout {
				m.log.Info("llama: idle-таймаут, выгрузка из VRAM", "idle", idle)
				_ = m.Stop()
				return
			}
		}
	}
}

// Stop принудительно завершает процесс. Идемпотентно.
func (m *Manager) Stop() error {
	m.mu.Lock()
	if !m.running {
		m.mu.Unlock()
		return nil
	}
	h := m.handle
	if m.idleStop != nil {
		close(m.idleStop)
		m.idleStop = nil
	}
	m.running = false
	m.handle = nil
	m.mu.Unlock()

	if h == nil {
		return nil
	}
	err := h.Kill()
	m.log.Info("llama: остановлен")
	return err
}

func (m *Manager) State() State {
	m.mu.Lock()
	defer m.mu.Unlock()
	st := State{Running: m.running}
	if m.running {
		st.ModelID = m.cfg.ModelID
	}
	return st
}

