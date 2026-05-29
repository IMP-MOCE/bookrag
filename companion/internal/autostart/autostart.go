// Package autostart управляет регистрацией компаньона на запуск при логине.
//
// Windows: значение в HKCU\Software\Microsoft\Windows\CurrentVersion\Run
// (per-user, без прав администратора).
// Linux: XDG autostart `.desktop` файл в $XDG_CONFIG_HOME/autostart/ (или
// $HOME/.config/autostart/) — работает во всех современных DE (GNOME/KDE/
// XFCE/Cinnamon).
//
// macOS пока не поддерживается (v1 — Windows + Linux/NVIDIA): возвращается
// noop-менеджер, IsEnabled() = false.
package autostart

// AppName — стабильный идентификатор компаньона в реестре/файловой системе
// (имя ключа Windows Registry, basename .desktop-файла).
const AppName = "bookrag-companion"

// Manager регистрирует/снимает автозапуск компаньона.
//
// Enable идемпотентен: повторный вызов перезаписывает запись теми же args.
// Disable идемпотентен: отсутствие записи — успех.
type Manager interface {
	Enable(execPath string, args []string) error
	Disable() error
	IsEnabled() (bool, error)
}

// Default возвращает реализацию для текущей ОС. На Linux — XDG, на Windows —
// Registry, на остальных — noop (Enable/Disable: nil; IsEnabled: false).
func Default() Manager { return defaultManager() }

// noopManager — реализация-заглушка для неподдержанных ОС.
type noopManager struct{}

func (noopManager) Enable(string, []string) error { return nil }
func (noopManager) Disable() error                { return nil }
func (noopManager) IsEnabled() (bool, error)      { return false, nil }
