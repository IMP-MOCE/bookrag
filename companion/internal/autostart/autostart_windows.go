//go:build windows

package autostart

import (
	"errors"
	"fmt"

	"golang.org/x/sys/windows/registry"
)

// runKeyPath — per-user ключ автозапуска Windows. Запись сюда не требует
// прав администратора.
const runKeyPath = `Software\Microsoft\Windows\CurrentVersion\Run`

// WindowsAutostart — реализация Manager через Windows Registry Run-ключ.
type WindowsAutostart struct {
	// ValueName — имя значения под ключом Run. По умолчанию — AppName.
	ValueName string
}

// NewWindowsAutostart строит WindowsAutostart с дефолтным именем значения.
func NewWindowsAutostart() *WindowsAutostart {
	return &WindowsAutostart{ValueName: AppName}
}

func defaultManager() Manager { return NewWindowsAutostart() }

func (w *WindowsAutostart) Enable(execPath string, args []string) error {
	if execPath == "" {
		return errors.New("autostart: execPath пуст")
	}
	k, _, err := registry.CreateKey(registry.CURRENT_USER, runKeyPath,
		registry.SET_VALUE)
	if err != nil {
		return fmt.Errorf("autostart: открыть Run-ключ: %w", err)
	}
	defer k.Close()
	cmd := FormatRegistryCommand(execPath, args)
	if err := k.SetStringValue(w.ValueName, cmd); err != nil {
		return fmt.Errorf("autostart: SetStringValue: %w", err)
	}
	return nil
}

func (w *WindowsAutostart) Disable() error {
	k, err := registry.OpenKey(registry.CURRENT_USER, runKeyPath,
		registry.SET_VALUE)
	if err != nil {
		if errors.Is(err, registry.ErrNotExist) {
			return nil
		}
		return fmt.Errorf("autostart: открыть Run-ключ: %w", err)
	}
	defer k.Close()
	if err := k.DeleteValue(w.ValueName); err != nil &&
		!errors.Is(err, registry.ErrNotExist) {
		return fmt.Errorf("autostart: DeleteValue: %w", err)
	}
	return nil
}

func (w *WindowsAutostart) IsEnabled() (bool, error) {
	k, err := registry.OpenKey(registry.CURRENT_USER, runKeyPath,
		registry.QUERY_VALUE)
	if err != nil {
		if errors.Is(err, registry.ErrNotExist) {
			return false, nil
		}
		return false, fmt.Errorf("autostart: открыть Run-ключ: %w", err)
	}
	defer k.Close()
	_, _, err = k.GetStringValue(w.ValueName)
	if err != nil {
		if errors.Is(err, registry.ErrNotExist) {
			return false, nil
		}
		return false, fmt.Errorf("autostart: GetStringValue: %w", err)
	}
	return true, nil
}
