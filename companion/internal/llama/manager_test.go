package llama

import (
	"context"
	"errors"
	"sync"
	"testing"
	"time"

	"github.com/bookrag/companion/internal/process"
)

type fakeHandle struct {
	killed   chan struct{}
	killOnce sync.Once
}

func newFakeHandle() *fakeHandle { return &fakeHandle{killed: make(chan struct{})} }
func (h *fakeHandle) Wait() error {
	<-h.killed
	return nil
}
func (h *fakeHandle) Kill() error {
	h.killOnce.Do(func() { close(h.killed) })
	return nil
}
func (h *fakeHandle) Pid() int { return 4242 }

type fakeRunner struct {
	mu     sync.Mutex
	starts int
}

func (r *fakeRunner) Start(_ context.Context, _ string, _ []string) (process.Handle, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.starts++
	return newFakeHandle(), nil
}
func (r *fakeRunner) count() int {
	r.mu.Lock()
	defer r.mu.Unlock()
	return r.starts
}

type fakeClock struct {
	mu sync.Mutex
	t  time.Time
}

func (c *fakeClock) now() time.Time {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.t
}
func (c *fakeClock) add(d time.Duration) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.t = c.t.Add(d)
}

func baseCfg(r process.Runner) Config {
	return Config{
		BinaryPath: "/fake/llama-server",
		ModelPath:  "/fake/model.gguf",
		ModelID:    "bookrag-4b",
		Host:       "127.0.0.1",
		Port:       8780,
		Runner:     r,
		Ready:      func(context.Context) error { return nil },
	}
}

func TestEnsureRunningStartsAndReportsState(t *testing.T) {
	r := &fakeRunner{}
	m := New(baseCfg(r))

	if err := m.EnsureRunning(context.Background()); err != nil {
		t.Fatalf("EnsureRunning: %v", err)
	}
	st := m.State()
	if !st.Running || st.ModelID != "bookrag-4b" {
		t.Fatalf("state = %+v, want running bookrag-4b", st)
	}
	if r.count() != 1 {
		t.Fatalf("starts = %d, want 1", r.count())
	}
}

func TestEnsureRunningIsIdempotent(t *testing.T) {
	r := &fakeRunner{}
	m := New(baseCfg(r))
	ctx := context.Background()

	if err := m.EnsureRunning(ctx); err != nil {
		t.Fatal(err)
	}
	if err := m.EnsureRunning(ctx); err != nil {
		t.Fatal(err)
	}
	if r.count() != 1 {
		t.Fatalf("starts = %d, want 1 (idempotent)", r.count())
	}
	m.Touch() // не должно паниковать на running
}

func TestEnsureRunningReadyTimeout(t *testing.T) {
	r := &fakeRunner{}
	clk := &fakeClock{t: time.Unix(1_700_000_000, 0)}
	cfg := baseCfg(r)
	cfg.now = clk.now
	cfg.ReadyWait = 5 * time.Millisecond
	// Каждая проверка готовности проваливается и сдвигает часы за дедлайн —
	// waitReady выходит с ошибкой без реальных пауз.
	cfg.Ready = func(context.Context) error {
		clk.add(10 * time.Millisecond)
		return errors.New("not ready")
	}
	m := New(cfg)

	if err := m.EnsureRunning(context.Background()); err == nil {
		t.Fatal("ожидалась ошибка таймаута готовности")
	}
	if m.State().Running {
		t.Fatal("после провала готовности менеджер не должен быть running")
	}
}

func TestStopIsIdempotent(t *testing.T) {
	m := New(baseCfg(&fakeRunner{}))
	if err := m.Stop(); err != nil { // ещё не запущен
		t.Fatalf("Stop on not-running: %v", err)
	}
	if err := m.EnsureRunning(context.Background()); err != nil {
		t.Fatal(err)
	}
	if err := m.Stop(); err != nil {
		t.Fatalf("Stop: %v", err)
	}
	if err := m.Stop(); err != nil {
		t.Fatalf("Stop again: %v", err)
	}
	if m.State().Running {
		t.Fatal("после Stop не должно быть running")
	}
}

func TestWarmupInvokedAfterReady(t *testing.T) {
	cfg := baseCfg(&fakeRunner{})
	called := make(chan struct{}, 1)
	cfg.Warmup = func(context.Context) error {
		called <- struct{}{}
		return nil
	}
	m := New(cfg)
	if err := m.EnsureRunning(context.Background()); err != nil {
		t.Fatal(err)
	}
	select {
	case <-called:
	default:
		t.Fatal("Warmup не вызван после готовности")
	}
}

func TestWarmupErrorIsNonFatal(t *testing.T) {
	cfg := baseCfg(&fakeRunner{})
	cfg.Warmup = func(context.Context) error { return errors.New("warmup boom") }
	m := New(cfg)
	if err := m.EnsureRunning(context.Background()); err != nil {
		t.Fatalf("ошибка warmup не должна валить запуск: %v", err)
	}
	if !m.State().Running {
		t.Fatal("после неуспешного warmup менеджер всё равно running")
	}
}

func TestIdleTimeoutAutoStops(t *testing.T) {
	cfg := baseCfg(&fakeRunner{})
	cfg.IdleTimeout = 60 * time.Millisecond // real clock, ticker = 30ms
	m := New(cfg)

	if err := m.EnsureRunning(context.Background()); err != nil {
		t.Fatal(err)
	}
	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		if !m.State().Running {
			return // авто-выгрузка по простою сработала
		}
		time.Sleep(20 * time.Millisecond)
	}
	t.Fatal("idle-таймаут не выгрузил модель")
}
