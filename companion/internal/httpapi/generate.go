package httpapi

import (
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
)

const upstreamChatPath = "/v1/chat/completions"

// POST /generate — прокси к дочернему llama-server. Перед запросом гарантирует
// поднятый процесс (идемпотентно) и сбрасывает idle-таймер. stream=false →
// {"content": "..."}; stream=true → сквозной SSE дочернего сервера.
func generateHandler(ctrl ModelController, up Upstream, log *slog.Logger) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if ctrl == nil || up == nil {
			writeJSON(w, http.StatusServiceUnavailable,
				map[string]string{"error": "model backend not configured"})
			return
		}

		var req generateRequest
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			writeJSON(w, http.StatusBadRequest,
				map[string]string{"error": "invalid JSON: " + err.Error()})
			return
		}
		body, err := buildUpstreamBody(req)
		if err != nil {
			writeJSON(w, http.StatusBadRequest, map[string]string{"error": err.Error()})
			return
		}

		if err := ctrl.EnsureRunning(r.Context()); err != nil {
			log.Error("generate: ensure running failed", "err", err)
			writeJSON(w, http.StatusServiceUnavailable,
				map[string]string{"error": err.Error()})
			return
		}
		ctrl.Touch()

		resp, err := up.Post(r.Context(), upstreamChatPath, body)
		if err != nil {
			log.Error("generate: upstream post failed", "err", err)
			writeJSON(w, http.StatusBadGateway,
				map[string]string{"error": "upstream: " + err.Error()})
			return
		}
		defer resp.Body.Close()

		if resp.StatusCode != http.StatusOK {
			msg, _ := io.ReadAll(io.LimitReader(resp.Body, 2048))
			log.Error("generate: upstream non-200", "status", resp.StatusCode)
			writeJSON(w, http.StatusBadGateway, map[string]string{
				"error":  "upstream status " + resp.Status,
				"detail": string(msg),
			})
			return
		}

		if req.Stream {
			relaySSE(w, resp.Body, log)
			return
		}

		var oa openAIChatResponse
		if err := json.NewDecoder(resp.Body).Decode(&oa); err != nil {
			writeJSON(w, http.StatusBadGateway,
				map[string]string{"error": "bad upstream JSON: " + err.Error()})
			return
		}
		content := ""
		if len(oa.Choices) > 0 {
			content = oa.Choices[0].Message.Content
		}
		writeJSON(w, http.StatusOK, map[string]string{"content": content})
	}
}

// relaySSE сквозно проксирует event-stream дочернего сервера с флашем после
// каждого чанка, чтобы расширение получало токены инкрементально.
func relaySSE(w http.ResponseWriter, src io.Reader, log *slog.Logger) {
	w.Header().Set("Content-Type", "text/event-stream")
	w.Header().Set("Cache-Control", "no-cache")
	w.Header().Set("X-Accel-Buffering", "no")
	w.WriteHeader(http.StatusOK)

	flusher, _ := w.(http.Flusher)
	buf := make([]byte, 4096)
	for {
		n, err := src.Read(buf)
		if n > 0 {
			if _, werr := w.Write(buf[:n]); werr != nil {
				return
			}
			if flusher != nil {
				flusher.Flush()
			}
		}
		if err == io.EOF {
			return
		}
		if err != nil {
			log.Warn("generate: sse relay read error", "err", err)
			return
		}
	}
}
