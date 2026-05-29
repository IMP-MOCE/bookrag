//go:build !windows

package tray

import "os"

// Available проверяет, можно ли запустить системный трей. На Unix трей
// требует наличия графической сессии — X11 ($DISPLAY) или Wayland
// ($WAYLAND_DISPLAY). На headless-сервере оба пусты → false.
func Available() bool {
	return os.Getenv("DISPLAY") != "" || os.Getenv("WAYLAND_DISPLAY") != ""
}
