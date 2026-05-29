//go:build !linux && !windows

package autostart

// На неподдержанных ОС (macOS и т.п.) — noop. Пользователь должен
// зарегистрировать автозапуск средствами ОС вручную; флаги
// --autostart-enable/disable отрапортуют ok без эффекта.
func defaultManager() Manager { return noopManager{} }
