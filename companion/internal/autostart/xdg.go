package autostart

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
)

// XDGAutostart — реализация Manager поверх XDG autostart spec:
// $XDG_CONFIG_HOME/autostart/<name>.desktop (или $HOME/.config/autostart/).
//
// Файл может читаться и тестироваться без graphical session. ConfigHome
// инжектируем для тестов; пустое значение → resolveConfigHome().
type XDGAutostart struct {
	ConfigHome string // если пусто — $XDG_CONFIG_HOME или $HOME/.config
	AppName    string // если пусто — AppName
}

// NewXDGAutostart строит XDGAutostart, заполняя пустые поля дефолтами.
func NewXDGAutostart(configHome, appName string) *XDGAutostart {
	if appName == "" {
		appName = AppName
	}
	return &XDGAutostart{ConfigHome: configHome, AppName: appName}
}

func (x *XDGAutostart) Enable(execPath string, args []string) error {
	if strings.TrimSpace(execPath) == "" {
		return errors.New("autostart: execPath пуст")
	}
	dir, err := x.dir()
	if err != nil {
		return err
	}
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return fmt.Errorf("autostart: создать каталог %s: %w", dir, err)
	}
	content := BuildDesktopEntry(x.AppName, execPath, args)
	path := filepath.Join(dir, x.AppName+".desktop")
	if err := os.WriteFile(path, []byte(content), 0o644); err != nil {
		return fmt.Errorf("autostart: запись %s: %w", path, err)
	}
	return nil
}

func (x *XDGAutostart) Disable() error {
	dir, err := x.dir()
	if err != nil {
		return err
	}
	path := filepath.Join(dir, x.AppName+".desktop")
	if err := os.Remove(path); err != nil && !errors.Is(err, os.ErrNotExist) {
		return fmt.Errorf("autostart: удаление %s: %w", path, err)
	}
	return nil
}

func (x *XDGAutostart) IsEnabled() (bool, error) {
	dir, err := x.dir()
	if err != nil {
		return false, err
	}
	path := filepath.Join(dir, x.AppName+".desktop")
	_, statErr := os.Stat(path)
	if statErr == nil {
		return true, nil
	}
	if errors.Is(statErr, os.ErrNotExist) {
		return false, nil
	}
	return false, statErr
}

func (x *XDGAutostart) dir() (string, error) {
	root := x.ConfigHome
	if root == "" {
		var err error
		root, err = resolveConfigHome()
		if err != nil {
			return "", err
		}
	}
	return filepath.Join(root, "autostart"), nil
}

func resolveConfigHome() (string, error) {
	if v := os.Getenv("XDG_CONFIG_HOME"); v != "" {
		return v, nil
	}
	home, err := os.UserHomeDir()
	if err != nil {
		return "", fmt.Errorf("autostart: home: %w", err)
	}
	return filepath.Join(home, ".config"), nil
}

// BuildDesktopEntry — pure-функция: собирает содержимое XDG autostart
// `.desktop`-файла. Сохраняет аргументы как Exec="path" arg1 arg2 (без
// shell-метасимволов), что соответствует spec (https://specifications.
// freedesktop.org/desktop-entry-spec/). Тестируется без файловой системы.
func BuildDesktopEntry(appName, execPath string, args []string) string {
	exec := quoteExecField(execPath)
	for _, a := range args {
		exec += " " + quoteExecField(a)
	}
	var b strings.Builder
	b.WriteString("[Desktop Entry]\n")
	b.WriteString("Type=Application\n")
	b.WriteString("Name=BookRAG Companion\n")
	b.WriteString("Comment=Local inference accelerator for BookRAG extension\n")
	b.WriteString("Exec=")
	b.WriteString(exec)
	b.WriteByte('\n')
	b.WriteString("X-GNOME-Autostart-enabled=true\n")
	b.WriteString("Terminal=false\n")
	b.WriteString("Categories=Utility;\n")
	if appName != "" {
		b.WriteString("X-AppName=")
		b.WriteString(appName)
		b.WriteByte('\n')
	}
	return b.String()
}

// quoteExecField экранирует одно поле для Desktop Entry Exec= согласно
// spec: символы, требующие кавычек — пробел, табы, кавычки, обратный слэш,
// доллар, бэктик. Безопасный путь — всегда оборачивать в двойные кавычки и
// экранировать ", \, $, ` обратным слэшем.
func quoteExecField(s string) string {
	needsQuote := false
	for _, r := range s {
		switch r {
		case ' ', '\t', '\n', '"', '\'', '\\', '$', '`':
			needsQuote = true
		}
		if needsQuote {
			break
		}
	}
	if !needsQuote {
		return s
	}
	var b strings.Builder
	b.Grow(len(s) + 4)
	b.WriteByte('"')
	for _, r := range s {
		switch r {
		case '"', '\\', '$', '`':
			b.WriteByte('\\')
		}
		b.WriteRune(r)
	}
	b.WriteByte('"')
	return b.String()
}
