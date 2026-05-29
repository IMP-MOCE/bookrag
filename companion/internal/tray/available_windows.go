//go:build windows

package tray

// Available — на Windows trey доступен в интерактивной user-сессии (запуск
// из autostart Run-ключа всегда даёт такую сессию). Session-0 / service-режим
// сюда не попадает: в нём демон должен запускаться с --no-tray.
func Available() bool { return true }
