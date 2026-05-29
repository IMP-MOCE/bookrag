// Package httpapi — loopback HTTP-сервер компаньона. M1: только /health,
// middleware (loopback + Origin allowlist) и graceful shutdown. Слои llama
// и модели подключатся в M2/M3 поверх этого роутера.
package httpapi

import (
	"context"
	"errors"
	"log/slog"
	"net"
	"net/http"
	"time"
)

// Config — параметры сервера.
type Config struct {
	// Addr — адрес прослушивания. Должен быть loopback (127.0.0.1:<port>).
	Addr string
	// AllowedOrigins — список разрешённых Origin (chrome-extension://<id>).
	// Пустой список = dev-режим: Origin не проверяется (логируется предупреждение).
	AllowedOrigins []string
	// Version — версия для /health.
	Version string
	// Logger — структурный логгер. Если nil, используется slog.Default().
	Logger *slog.Logger
	// Controller — менеджер llama-бэкенда. nil = M1/тест-режим: /load и
	// /unload отвечают 503, /health показывает modelReady=false.
	Controller ModelController
	// Upstream — транспорт к дочернему llama-server для /generate. nil →
	// /generate отвечает 503.
	Upstream Upstream
	// Download — поставщик прогресса скачивания GGUF для /model/status.
	// nil → блок download в ответе опускается.
	Download DownloadReporter
}

// Server оборачивает http.Server с роутером и middleware компаньона.
type Server struct {
	httpServer *http.Server
	log        *slog.Logger
}

// New собирает Server из Config. Не слушает порт — это делает Run.
func New(cfg Config) *Server {
	log := cfg.Logger
	if log == nil {
		log = slog.Default()
	}

	mux := http.NewServeMux()
	mux.HandleFunc("GET /health", healthHandler(cfg.Version, cfg.Controller))
	mux.HandleFunc("POST /load", loadHandler(cfg.Controller, log))
	mux.HandleFunc("POST /unload", unloadHandler(cfg.Controller, log))
	mux.HandleFunc("GET /model/status", modelStatusHandler(cfg.Controller, cfg.Download))
	mux.HandleFunc("POST /generate", generateHandler(cfg.Controller, cfg.Upstream, log))

	handler := withLoopbackOnly(withOriginAllowlist(cfg.AllowedOrigins, log, mux), log)

	return &Server{
		httpServer: &http.Server{
			Addr:              cfg.Addr,
			Handler:           handler,
			ReadHeaderTimeout: 5 * time.Second,
		},
		log: log,
	}
}

// Handler возвращает собранную цепочку middleware+роутер. Полезно для тестов
// и для встраивания в другой сервер.
func (s *Server) Handler() http.Handler {
	return s.httpServer.Handler
}

// Run слушает порт и блокируется до отмены ctx, затем выполняет graceful
// shutdown. Возвращает nil при штатной остановке по ctx.
func (s *Server) Run(ctx context.Context) error {
	ln, err := net.Listen("tcp", s.httpServer.Addr)
	if err != nil {
		return err
	}
	s.log.Info("companion listening", "addr", ln.Addr().String())

	errCh := make(chan error, 1)
	go func() {
		if serveErr := s.httpServer.Serve(ln); serveErr != nil &&
			!errors.Is(serveErr, http.ErrServerClosed) {
			errCh <- serveErr
			return
		}
		errCh <- nil
	}()

	select {
	case <-ctx.Done():
		shutdownCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		s.log.Info("companion shutting down")
		return s.httpServer.Shutdown(shutdownCtx)
	case err := <-errCh:
		return err
	}
}
