package httpapi

import (
	"encoding/json"
	"errors"
)

// generateRequest — контракт /generate. Зеркалит то, что extension-сторона
// (AnalysisLLMClient/CompanionBackend) шлёт: messages + опциональные
// jsonSchema/temperature/maxTokens + stream.
type generateRequest struct {
	Messages []chatMessage `json:"messages"`
	// jsonSchema — произвольный JSON Schema; уходит в response_format,
	// llama.cpp сам строит GBNF.
	JSONSchema  json.RawMessage `json:"jsonSchema,omitempty"`
	Temperature *float64        `json:"temperature,omitempty"`
	MaxTokens   *int            `json:"maxTokens,omitempty"`
	Stream      bool            `json:"stream,omitempty"`
}

type chatMessage struct {
	Role    string `json:"role"`
	Content string `json:"content"`
}

// Дефолты — паритет с WebLLM-путём (LocalLLMService): без них поведение
// компаньона разойдётся с in-browser. enable_thinking=false мы передаём
// через chat_template_kwargs (Qwen3 шаблон).
const (
	defTemperature      = 0.1
	defTopP             = 0.9
	defFrequencyPenalty = 0.4
	defPresencePenalty  = 0.3
	defMaxTokens        = 2048
)

// buildUpstreamBody маппит контракт /generate в тело OpenAI-совместимого
// /v1/chat/completions дочернего llama-server. Чистая функция — тестируема.
func buildUpstreamBody(req generateRequest) ([]byte, error) {
	if len(req.Messages) == 0 {
		return nil, errors.New("generate: messages пуст")
	}
	temp := defTemperature
	if req.Temperature != nil {
		temp = *req.Temperature
	}
	maxTok := defMaxTokens
	if req.MaxTokens != nil {
		maxTok = *req.MaxTokens
	}

	body := map[string]any{
		"messages":          req.Messages,
		"temperature":       temp,
		"top_p":             defTopP,
		"frequency_penalty": defFrequencyPenalty,
		"presence_penalty":  defPresencePenalty,
		"max_tokens":        maxTok,
		"stream":            req.Stream,
		// Паритет с extension: отключаем <think> у Qwen3 через kwargs шаблона.
		"chat_template_kwargs": map[string]any{"enable_thinking": false},
	}
	if len(req.JSONSchema) > 0 {
		body["response_format"] = map[string]any{
			"type": "json_schema",
			"json_schema": map[string]any{
				"name":   "analysis",
				"schema": req.JSONSchema,
				"strict": true,
			},
		}
	}
	return json.Marshal(body)
}

// openAIChatResponse — минимум для извлечения контента из non-stream ответа.
type openAIChatResponse struct {
	Choices []struct {
		Message struct {
			Content string `json:"content"`
		} `json:"message"`
	} `json:"choices"`
}
