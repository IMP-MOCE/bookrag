package httpapi

import (
	"encoding/json"
	"testing"
)

func decodeBody(t *testing.T, req generateRequest) map[string]any {
	t.Helper()
	raw, err := buildUpstreamBody(req)
	if err != nil {
		t.Fatalf("buildUpstreamBody: %v", err)
	}
	var m map[string]any
	if err := json.Unmarshal(raw, &m); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	return m
}

func TestBuildUpstreamDefaults(t *testing.T) {
	m := decodeBody(t, generateRequest{
		Messages: []chatMessage{{Role: "user", Content: "hi"}},
	})
	if m["temperature"].(float64) != defTemperature {
		t.Fatalf("temperature = %v, want %v", m["temperature"], defTemperature)
	}
	if m["top_p"].(float64) != defTopP {
		t.Fatalf("top_p = %v", m["top_p"])
	}
	if m["max_tokens"].(float64) != float64(defMaxTokens) {
		t.Fatalf("max_tokens = %v", m["max_tokens"])
	}
	if m["stream"].(bool) {
		t.Fatal("stream должен быть false по умолчанию")
	}
	ctk := m["chat_template_kwargs"].(map[string]any)
	if ctk["enable_thinking"].(bool) {
		t.Fatal("enable_thinking должен быть false (паритет с WebLLM)")
	}
	if _, has := m["response_format"]; has {
		t.Fatal("без jsonSchema response_format быть не должно")
	}
}

func TestBuildUpstreamWithSchemaAndOverrides(t *testing.T) {
	temp := 0.7
	maxT := 256
	m := decodeBody(t, generateRequest{
		Messages:    []chatMessage{{Role: "user", Content: "hi"}},
		JSONSchema:  json.RawMessage(`{"type":"object"}`),
		Temperature: &temp,
		MaxTokens:   &maxT,
		Stream:      true,
	})
	if m["temperature"].(float64) != 0.7 || m["max_tokens"].(float64) != 256 {
		t.Fatalf("overrides не применились: %+v", m)
	}
	if !m["stream"].(bool) {
		t.Fatal("stream должен быть true")
	}
	rf := m["response_format"].(map[string]any)
	if rf["type"] != "json_schema" {
		t.Fatalf("response_format.type = %v", rf["type"])
	}
	js := rf["json_schema"].(map[string]any)
	if js["schema"] == nil || js["strict"] != true {
		t.Fatalf("json_schema некорректен: %+v", js)
	}
}

func TestBuildUpstreamEmptyMessages(t *testing.T) {
	if _, err := buildUpstreamBody(generateRequest{}); err == nil {
		t.Fatal("ожидалась ошибка на пустых messages")
	}
}
