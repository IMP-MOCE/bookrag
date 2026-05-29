// Command bookrag-companion — локальный демон-ускоритель для расширения
// BookRAG. M5: добавлены трей (fyne.io/systray) и регистрация автозапуска
// (Windows Registry Run / Linux XDG autostart).
package main

import (
	"bytes"
	"context"
	"flag"
	"fmt"
	"io"
	"log/slog"
	"net"
	"net/http"
	"os"
	"os/signal"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"time"

	"github.com/bookrag/companion/internal/autostart"
	"github.com/bookrag/companion/internal/buildinfo"
	"github.com/bookrag/companion/internal/httpapi"
	"github.com/bookrag/companion/internal/llama"
	"github.com/bookrag/companion/internal/model"
	"github.com/bookrag/companion/internal/tray"
)

// llamaController адаптирует *llama.Manager к httpapi.ModelController
// (httpapi не зависит от пакета llama).
type llamaController struct{ m *llama.Manager }

func (c llamaController) EnsureRunning(ctx context.Context) error {
	return c.m.EnsureRunning(ctx)
}
func (c llamaController) Stop() error { return c.m.Stop() }
func (c llamaController) Touch()      { c.m.Touch() }
func (c llamaController) State() httpapi.ModelState {
	s := c.m.State()
	return httpapi.ModelState{Running: s.Running, ModelID: s.ModelID}
}

// childUpstream — httpapi.Upstream поверх HTTP к дочернему llama-server.
type childUpstream struct {
	base   string
	client *http.Client
}

// progressHolder — потокобезопасный снимок прогресса скачивания; реализует
// httpapi.DownloadReporter и принимает колбэки model.Downloader.
type progressHolder struct {
	mu sync.Mutex
	st httpapi.DownloadState
}

func (h *progressHolder) set(p model.Progress) {
	h.mu.Lock()
	h.st = httpapi.DownloadState{Phase: string(p.Phase), Done: p.Done, Total: p.Total}
	h.mu.Unlock()
}

func (h *progressHolder) DownloadProgress() httpapi.DownloadState {
	h.mu.Lock()
	defer h.mu.Unlock()
	return h.st
}

// ensuringController перед стартом llama гарантирует, что GGUF скачан.
type ensuringController struct {
	inner httpapi.ModelController
	dl    *model.Downloader
	src   model.Source
}

func (c ensuringController) EnsureRunning(ctx context.Context) error {
	if _, err := c.dl.EnsureLocal(ctx, c.src); err != nil {
		return err
	}
	return c.inner.EnsureRunning(ctx)
}
func (c ensuringController) Stop() error               { return c.inner.Stop() }
func (c ensuringController) Touch()                    { c.inner.Touch() }
func (c ensuringController) State() httpapi.ModelState { return c.inner.State() }

func (u childUpstream) Post(ctx context.Context, path string, body []byte) (*http.Response, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, u.base+path,
		bytes.NewReader(body))
	if err != nil {
		return nil, err
	}
	req.Header.Set("Content-Type", "application/json")
	return u.client.Do(req)
}

func main() {
	addr := flag.String("addr", "127.0.0.1:8731",
		"loopback-адрес прослушивания (host:port)")
	origins := flag.String("allowed-origins", "",
		"список разрешённых Origin через запятую (chrome-extension://<id>). "+
			"Пусто = dev-режим без проверки Origin")
	showVersion := flag.Bool("version", false, "напечатать версию и выйти")
	llamaBin := flag.String("llama-bin", "", "путь к бинарю llama-server (пусто = режим M1 без модели)")
	modelPath := flag.String("model", "", "путь к GGUF-модели")
	modelID := flag.String("model-id", "bookrag-4b", "идентификатор модели для /health")
	llamaHost := flag.String("llama-host", "127.0.0.1", "loopback-хост дочернего llama-server")
	llamaPort := flag.Int("llama-port", 8780, "порт дочернего llama-server")
	ngl := flag.Int("ngl", 999, "llama -ngl: слоёв на GPU (999 = всё)")
	ctxSize := flag.Int("ctx-size", 0, "llama --ctx-size (0 = дефолт llama)")
	idle := flag.Duration("idle", 5*time.Minute, "простой до авто-выгрузки из VRAM (0 = не выгружать)")
	hfRepo := flag.String("hf-repo", "", "Hugging Face repo с GGUF (напр. org/bookrag-4b-gguf)")
	hfFile := flag.String("hf-file", "", "имя GGUF-файла в repo")
	hfRev := flag.String("hf-revision", "main", "ревизия HF (ветка/тег/коммит)")
	modelSHA := flag.String("model-sha256", "", "ожидаемый sha256 GGUF (hex; пусто = без проверки)")
	dataDir := flag.String("data-dir", "data", "каталог для скачанной модели")
	noTray := flag.Bool("no-tray", false, "не запускать трей (headless). "+
		"По умолчанию трей включается, если есть графическая сессия")
	autostartEnable := flag.Bool("autostart-enable", false,
		"зарегистрировать автозапуск компаньона при логине и выйти")
	autostartDisable := flag.Bool("autostart-disable", false,
		"снять автозапуск компаньона и выйти")
	autostartStatus := flag.Bool("autostart-status", false,
		"напечатать состояние автозапуска (enabled/disabled) и выйти")
	flag.Parse()

	if *showVersion {
		os.Stdout.WriteString(buildinfo.Version + "\n")
		return
	}

	if *autostartEnable || *autostartDisable || *autostartStatus {
		if err := handleAutostart(*autostartEnable, *autostartDisable,
			*autostartStatus); err != nil {
			fmt.Fprintln(os.Stderr, "autostart:", err)
			os.Exit(1)
		}
		return
	}

	log := slog.New(slog.NewTextHandler(os.Stderr, nil))

	// Резолвим путь к модели: явный --model имеет приоритет; иначе, если задан
	// HF repo+file — качаем в data-dir при первом EnsureRunning.
	resolvedModel := *modelPath
	var downloader *model.Downloader
	var modelSrc model.Source
	var dlReporter httpapi.DownloadReporter
	var holder *progressHolder
	if resolvedModel == "" && *hfRepo != "" && *hfFile != "" {
		holder = &progressHolder{}
		dlReporter = holder
		downloader = &model.Downloader{
			Dir:        *dataDir,
			Client:     &http.Client{},
			OnProgress: holder.set,
		}
		modelSrc = model.Source{
			Repo: *hfRepo, File: *hfFile, Revision: *hfRev, SHA256: *modelSHA,
		}
		resolvedModel = filepath.Join(*dataDir, *hfFile)
	}

	var controller httpapi.ModelController
	var upstream httpapi.Upstream
	if *llamaBin != "" && resolvedModel != "" {
		childAddr := net.JoinHostPort(*llamaHost, strconv.Itoa(*llamaPort))
		childBase := "http://" + childAddr
		up := childUpstream{base: childBase, client: &http.Client{}}
		upstream = up
		mgr := llama.New(llama.Config{
			BinaryPath:  *llamaBin,
			ModelPath:   resolvedModel,
			ModelID:     *modelID,
			Host:        *llamaHost,
			Port:        *llamaPort,
			NGL:         *ngl,
			CtxSize:     *ctxSize,
			IdleTimeout: *idle,
			Logger:      log,
			Ready:       childHealthCheck(childBase + "/health"),
			Warmup:      warmupChat(up),
		})
		controller = llamaController{m: mgr}
		if downloader != nil {
			controller = ensuringController{inner: controller, dl: downloader, src: modelSrc}
		}
	} else {
		log.Warn("llama-bin/model(или hf-repo+hf-file) не заданы — режим M1 без модели (/load,/unload → 503)")
	}

	srv := httpapi.New(httpapi.Config{
		Addr:           *addr,
		AllowedOrigins: parseOrigins(*origins),
		Version:        buildinfo.Version,
		Logger:         log,
		Controller:     controller,
		Upstream:       upstream,
		Download:       dlReporter,
	})

	ctx, stop := signal.NotifyContext(context.Background(),
		os.Interrupt, syscall.SIGTERM)
	defer stop()

	useTray := !*noTray && tray.Available()
	if useTray {
		runWithTray(ctx, stop, srv, controller, dlReporter, log)
		return
	}

	if !*noTray {
		log.Info("трей выключен: нет графической сессии (запускаем headless)")
	}
	if err := srv.Run(ctx); err != nil {
		log.Error("server stopped with error", "err", err)
		os.Exit(1)
	}
}

// runWithTray поднимает HTTP-сервер в goroutine и блокирует main на трее
// (fyne.io/systray требует main goroutine). Quit-пункт меню вызывает stop()
// → cancel главного ctx → srv.Run завершается → defer t.Stop() разблокирует
// трей.
func runWithTray(
	ctx context.Context,
	stop context.CancelFunc,
	srv *httpapi.Server,
	ctrl httpapi.ModelController,
	dl httpapi.DownloadReporter,
	log *slog.Logger,
) {
	t := tray.NewSystray(tray.Config{
		Version: buildinfo.Version,
		OnQuit:  stop,
	})

	srvErr := make(chan error, 1)
	go func() {
		defer t.Stop()
		srvErr <- srv.Run(ctx)
	}()

	statusDone := make(chan struct{})
	if ctrl != nil || dl != nil {
		go func() {
			defer close(statusDone)
			monitorTrayStatus(ctx, ctrl, dl, t)
		}()
	} else {
		t.SetStatus(tray.StatusIdle, "")
		close(statusDone)
	}

	t.Run(ctx)
	stop()
	<-statusDone
	err := <-srvErr
	if err != nil && err != http.ErrServerClosed {
		log.Error("server stopped with error", "err", err)
		os.Exit(1)
	}
}

// monitorTrayStatus раз в две секунды собирает состояние контроллера и
// скачивания, переводя его в Update для трея. Завершается по ctx.
func monitorTrayStatus(
	ctx context.Context,
	ctrl httpapi.ModelController,
	dl httpapi.DownloadReporter,
	t tray.Controller,
) {
	const period = 2 * time.Second
	t.SetStatus(deriveTrayStatus(ctrl, dl))
	ticker := time.NewTicker(period)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			t.SetStatus(deriveTrayStatus(ctrl, dl))
		}
	}
}

// deriveTrayStatus — pure-маппинг состояния компаньона в (Status, detail)
// для трея. Приоритет: активная загрузка > запущенная модель > idle.
func deriveTrayStatus(ctrl httpapi.ModelController, dl httpapi.DownloadReporter) (tray.Status, string) {
	if dl != nil {
		ds := dl.DownloadProgress()
		switch ds.Phase {
		case "downloading":
			detail := ""
			if ds.Total > 0 {
				pct := int(float64(ds.Done) / float64(ds.Total) * 100)
				detail = strconv.Itoa(pct) + "%"
			}
			return tray.StatusDownloading, detail
		case "verifying":
			return tray.StatusLoading, "verifying checksum"
		case "error":
			return tray.StatusError, "download failed"
		}
	}
	if ctrl != nil {
		st := ctrl.State()
		if st.Running {
			return tray.StatusReady, st.ModelID
		}
	}
	return tray.StatusIdle, ""
}

// handleAutostart обрабатывает флаги --autostart-enable/disable/status и
// печатает результат. Возвращает ошибку для os.Exit(1).
func handleAutostart(enable, disable, status bool) error {
	if boolCount(enable, disable, status) > 1 {
		return fmt.Errorf("выберите ровно один из --autostart-enable/--autostart-disable/--autostart-status")
	}
	m := autostart.Default()

	if status {
		ok, err := m.IsEnabled()
		if err != nil {
			return err
		}
		if ok {
			fmt.Println("enabled")
		} else {
			fmt.Println("disabled")
		}
		return nil
	}

	if disable {
		if err := m.Disable(); err != nil {
			return err
		}
		fmt.Println("autostart disabled")
		return nil
	}

	exe, err := os.Executable()
	if err != nil {
		return fmt.Errorf("os.Executable: %w", err)
	}
	args := autostartArgs()
	if err := m.Enable(exe, args); err != nil {
		return err
	}
	fmt.Println("autostart enabled →", exe, strings.Join(args, " "))
	return nil
}

// autostartArgs — аргументы, с которыми компаньон должен стартовать из
// автозапуска. По умолчанию: фоновый headless-ускоритель не нужен (трей
// сам автодетектится), но мы не передаём --no-tray, чтобы на десктопе
// иконка появлялась автоматически.
func autostartArgs() []string {
	return nil
}

func boolCount(bs ...bool) int {
	n := 0
	for _, b := range bs {
		if b {
			n++
		}
	}
	return n
}

// childHealthCheck — ReadyFunc: GET по health-URL дочернего llama-server,
// nil при 200. Используется менеджером для ожидания готовности после спавна.
func childHealthCheck(url string) llama.ReadyFunc {
	client := &http.Client{Timeout: 2 * time.Second}
	return func(ctx context.Context) error {
		req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
		if err != nil {
			return err
		}
		resp, err := client.Do(req)
		if err != nil {
			return err
		}
		defer resp.Body.Close()
		if resp.StatusCode != http.StatusOK {
			return &httpStatusError{code: resp.StatusCode}
		}
		return nil
	}
}

// warmupChat — ReadyFunc для llama.Manager: 1-токенная генерация после
// готовности, чтобы прогрев ушёл с критического пути первого запроса.
func warmupChat(up childUpstream) llama.ReadyFunc {
	const body = `{"messages":[{"role":"user","content":"ok"}],"max_tokens":1,"stream":false}`
	return func(ctx context.Context) error {
		resp, err := up.Post(ctx, "/v1/chat/completions", []byte(body))
		if err != nil {
			return err
		}
		defer resp.Body.Close()
		_, _ = io.Copy(io.Discard, resp.Body)
		if resp.StatusCode != http.StatusOK {
			return &httpStatusError{code: resp.StatusCode}
		}
		return nil
	}
}

type httpStatusError struct{ code int }

func (e *httpStatusError) Error() string {
	return "llama child not ready: status " + strconv.Itoa(e.code)
}

func parseOrigins(csv string) []string {
	if strings.TrimSpace(csv) == "" {
		return nil
	}
	parts := strings.Split(csv, ",")
	out := make([]string, 0, len(parts))
	for _, p := range parts {
		if t := strings.TrimSpace(p); t != "" {
			out = append(out, t)
		}
	}
	return out
}
