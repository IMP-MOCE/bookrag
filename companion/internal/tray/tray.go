// Package tray — иконка статуса в системном трее.
//
// Реальная реализация (systray.go) опирается на fyne.io/systray и должна
// запускаться из main goroutine. NoopController используется в headless-
// режиме (нет дисплея / явный --no-tray) и в тестах.
//
// Контракт: Run() блокируется до Stop() или отмены ctx и обязан выполняться
// из main goroutine; SetStatus безопасен из любой горутины (non-blocking,
// последняя запись побеждает); OnQuit вызывается, когда пользователь
// выбирает "Quit" в меню трея.
package tray

import (
	"context"
	"fmt"
)

// Status — высокоуровневое состояние компаньона для индикатора трея.
type Status int

const (
	StatusUnknown     Status = iota
	StatusIdle               // демон жив, модель не в VRAM
	StatusDownloading        // загрузка GGUF в процессе
	StatusLoading            // спавн llama-server / загрузка в VRAM
	StatusReady              // модель в VRAM, готова к запросам
	StatusError              // последняя операция упала
)

// String отдаёт человекочитаемое имя статуса (используется в подсказке трея
// и логах). Стабильно для тестов и снэпшотов.
func (s Status) String() string {
	switch s {
	case StatusIdle:
		return "idle"
	case StatusDownloading:
		return "downloading"
	case StatusLoading:
		return "loading"
	case StatusReady:
		return "ready"
	case StatusError:
		return "error"
	default:
		return "unknown"
	}
}

// Update — пара (status, detail) для отображения в подсказке трея.
type Update struct {
	Status Status
	Detail string
}

// TooltipFor собирает строку подсказки трея из версии и текущего обновления.
// Чистая функция, тестируется без GUI.
func TooltipFor(version string, u Update) string {
	base := "BookRAG Companion"
	if version != "" {
		base = fmt.Sprintf("%s %s", base, version)
	}
	if u.Detail != "" {
		return fmt.Sprintf("%s — %s: %s", base, u.Status, u.Detail)
	}
	return fmt.Sprintf("%s — %s", base, u.Status)
}

// Controller — поведение, которое использует main.go. Любая реализация
// должна блокировать Run до Stop / ctx.Done и быть thread-safe для SetStatus.
type Controller interface {
	Run(ctx context.Context)
	SetStatus(s Status, detail string)
	Stop()
}

// Config — параметры реальной реализации (systray.go).
type Config struct {
	// Version отображается в подсказке трея.
	Version string
	// OnQuit вызывается, когда пользователь выбрал пункт "Quit". Обычно
	// триггерит cancel ctx процесса.
	OnQuit func()
}
