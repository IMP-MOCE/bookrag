package tray

import (
	"context"
	"sync"

	"fyne.io/systray"

	"github.com/bookrag/companion/assets"
)

// SystrayController — реализация Controller через fyne.io/systray.
//
// Контракт fyne.io/systray: Run() блокирует main goroutine и обязан
// вызываться из неё (особенно критично на macOS, где UI-цикл привязан к
// главному потоку); systray.Quit() из любой горутины разблокирует Run().
//
// SetStatus складывает обновление в небольшой буфер; UI-цикл подхватывает
// и обновляет SetTooltip. При переполнении канала актуальное значение
// сохраняется в поле last, и UI всё равно увидит свежий статус на
// следующей обработке (мы шлём last в onReady и при каждом тике).
type SystrayController struct {
	cfg Config

	statusCh chan Update
	quitCh   chan struct{}
	quitOnce sync.Once

	mu   sync.Mutex
	last Update
}

// NewSystray готовит SystrayController. Не запускает UI — это делает Run.
func NewSystray(cfg Config) *SystrayController {
	return &SystrayController{
		cfg:      cfg,
		statusCh: make(chan Update, 8),
		quitCh:   make(chan struct{}),
		last:     Update{Status: StatusIdle},
	}
}

// SetStatus безопасен из любой горутины. Non-blocking: если канал заполнен,
// падаем на last-snapshot — UI-цикл всё равно подхватит актуальное значение.
func (c *SystrayController) SetStatus(s Status, detail string) {
	upd := Update{Status: s, Detail: detail}
	c.mu.Lock()
	c.last = upd
	c.mu.Unlock()
	select {
	case c.statusCh <- upd:
	default:
	}
}

// snapshot — текущее состояние под мьютексом.
func (c *SystrayController) snapshot() Update {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.last
}

// Stop разблокирует Run. Идемпотентен.
func (c *SystrayController) Stop() {
	c.quitOnce.Do(func() {
		close(c.quitCh)
		systray.Quit()
	})
}

// Run запускает системный трей и блокирует до Stop()/ctx.Done()/пункта Quit
// в меню. ОБЯЗАН вызываться из main goroutine.
func (c *SystrayController) Run(ctx context.Context) {
	onReady := func() {
		systray.SetIcon(assets.IconPNG)
		systray.SetTitle("BookRAG")
		systray.SetTooltip(TooltipFor(c.cfg.Version, c.snapshot()))

		mQuit := systray.AddMenuItem("Quit BookRAG Companion",
			"Stop the local inference daemon")

		go c.eventLoop(ctx, mQuit.ClickedCh)
	}
	systray.Run(onReady, func() {})
}

func (c *SystrayController) eventLoop(ctx context.Context, quitClicked <-chan struct{}) {
	for {
		select {
		case upd := <-c.statusCh:
			systray.SetTooltip(TooltipFor(c.cfg.Version, upd))
		case <-quitClicked:
			if c.cfg.OnQuit != nil {
				c.cfg.OnQuit()
			}
			systray.Quit()
			return
		case <-ctx.Done():
			systray.Quit()
			return
		case <-c.quitCh:
			// Stop() уже вызвал systray.Quit() — просто выходим из цикла.
			return
		}
	}
}

