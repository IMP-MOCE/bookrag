package httpapi

import (
	"encoding/json"
	"log/slog"
	"net/http"
)

func writeJSON(w http.ResponseWriter, code int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(code)
	_ = json.NewEncoder(w).Encode(v)
}

// POST /load — идемпотентно поднять llama-server и дождаться готовности.
func loadHandler(ctrl ModelController, log *slog.Logger) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if ctrl == nil {
			writeJSON(w, http.StatusServiceUnavailable,
				map[string]string{"error": "model backend not configured"})
			return
		}
		if err := ctrl.EnsureRunning(r.Context()); err != nil {
			log.Error("load failed", "err", err)
			writeJSON(w, http.StatusServiceUnavailable,
				map[string]string{"error": err.Error()})
			return
		}
		writeJSON(w, http.StatusOK, map[string]bool{"loaded": true})
	}
}

// POST /unload — выгрузить модель из VRAM (best-effort, идемпотентно).
func unloadHandler(ctrl ModelController, log *slog.Logger) http.HandlerFunc {
	return func(w http.ResponseWriter, _ *http.Request) {
		if ctrl == nil {
			writeJSON(w, http.StatusServiceUnavailable,
				map[string]string{"error": "model backend not configured"})
			return
		}
		if err := ctrl.Stop(); err != nil {
			log.Warn("unload error", "err", err)
		}
		writeJSON(w, http.StatusOK, map[string]bool{"unloaded": true})
	}
}
