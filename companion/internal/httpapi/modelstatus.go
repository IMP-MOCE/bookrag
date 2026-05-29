package httpapi

import "net/http"

// DownloadState — снимок прогресса скачивания GGUF для /model/status.
type DownloadState struct {
	Phase string `json:"phase"`
	Done  int64  `json:"done"`
	Total int64  `json:"total"`
}

// DownloadReporter поставляет прогресс загрузки модели. Опционален (nil →
// блок download в ответе опускается). Реализация — в main (поверх
// internal/model), чтобы httpapi не зависел от пакета model.
type DownloadReporter interface {
	DownloadProgress() DownloadState
}

// GET /model/status — состояние модели для UI расширения: запущен ли
// llama-бэкенд + прогресс скачивания GGUF.
type modelStatusResponse struct {
	Running    bool           `json:"running"`
	ModelReady bool           `json:"modelReady"`
	ModelID    *string        `json:"modelId"`
	Download   *DownloadState `json:"download,omitempty"`
}

func modelStatusHandler(ctrl ModelController, dl DownloadReporter) http.HandlerFunc {
	return func(w http.ResponseWriter, _ *http.Request) {
		resp := modelStatusResponse{}
		if ctrl != nil {
			st := ctrl.State()
			resp.Running = st.Running
			resp.ModelReady = st.Running
			if st.Running && st.ModelID != "" {
				id := st.ModelID
				resp.ModelID = &id
			}
		}
		if dl != nil {
			ds := dl.DownloadProgress()
			resp.Download = &ds
		}
		writeJSON(w, http.StatusOK, resp)
	}
}
