package httpapi

import (
	"encoding/json"
	"net/http"
)

// healthResponse — дешёвый probe. modelReady/modelId появятся в M2 вместе с
// менеджером llama-server; в M1 модель не загружается, поэтому false/null.
type healthResponse struct {
	OK         bool    `json:"ok"`
	ModelReady bool    `json:"modelReady"`
	ModelID    *string `json:"modelId"`
	Version    string  `json:"version"`
}

func healthHandler(version string, ctrl ModelController) http.HandlerFunc {
	return func(w http.ResponseWriter, _ *http.Request) {
		resp := healthResponse{OK: true, Version: version}
		if ctrl != nil {
			st := ctrl.State()
			resp.ModelReady = st.Running
			if st.Running && st.ModelID != "" {
				id := st.ModelID
				resp.ModelID = &id
			}
		}
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(resp)
	}
}
