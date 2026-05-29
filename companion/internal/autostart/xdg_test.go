package autostart

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestBuildDesktopEntryNoSpaces(t *testing.T) {
	got := BuildDesktopEntry(AppName, "/usr/local/bin/bookrag-companion", nil)
	for _, line := range []string{
		"[Desktop Entry]",
		"Type=Application",
		"Name=BookRAG Companion",
		"Exec=/usr/local/bin/bookrag-companion",
		"X-GNOME-Autostart-enabled=true",
		"X-AppName=" + AppName,
	} {
		if !strings.Contains(got, line+"\n") {
			t.Errorf("desktop entry должен содержать %q. Полное:\n%s", line, got)
		}
	}
}

func TestBuildDesktopEntryQuotesPathsWithSpaces(t *testing.T) {
	got := BuildDesktopEntry(AppName, "/opt/My Apps/bookrag-companion",
		[]string{"--no-tray", "--addr=127.0.0.1:8731"})
	wantExec := `Exec="/opt/My Apps/bookrag-companion" --no-tray --addr=127.0.0.1:8731`
	if !strings.Contains(got, wantExec) {
		t.Errorf("Exec не квотирован/без аргументов. got:\n%s\nwant строка с:\n%s",
			got, wantExec)
	}
}

func TestBuildDesktopEntryEscapesSpecialChars(t *testing.T) {
	got := BuildDesktopEntry(AppName, `/opt/$weird`,
		[]string{`a"b`})
	if !strings.Contains(got, `"/opt/\$weird"`) {
		t.Errorf("$ должен быть экранирован. got:\n%s", got)
	}
	if !strings.Contains(got, `"a\"b"`) {
		t.Errorf("\" должен быть экранирован. got:\n%s", got)
	}
}

func TestXDGEnableWritesFile(t *testing.T) {
	dir := t.TempDir()
	x := NewXDGAutostart(dir, "bookrag-companion-test")

	if err := x.Enable("/usr/local/bin/bookrag-companion",
		[]string{"--no-tray"}); err != nil {
		t.Fatal(err)
	}

	path := filepath.Join(dir, "autostart", "bookrag-companion-test.desktop")
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("файл не создан: %v", err)
	}
	if !strings.Contains(string(data),
		"Exec=/usr/local/bin/bookrag-companion --no-tray\n") {
		t.Errorf("Exec не содержит ожидаемой команды:\n%s", data)
	}

	ok, err := x.IsEnabled()
	if err != nil || !ok {
		t.Errorf("IsEnabled = %v,%v; ждали true,nil", ok, err)
	}
}

func TestXDGDisableIsIdempotent(t *testing.T) {
	dir := t.TempDir()
	x := NewXDGAutostart(dir, "bookrag-companion-test")

	if err := x.Disable(); err != nil {
		t.Errorf("Disable без файла не должен падать: %v", err)
	}

	if err := x.Enable("/usr/local/bin/bookrag-companion", nil); err != nil {
		t.Fatal(err)
	}
	if err := x.Disable(); err != nil {
		t.Fatal(err)
	}
	ok, err := x.IsEnabled()
	if err != nil || ok {
		t.Errorf("IsEnabled после Disable = %v,%v; ждали false,nil", ok, err)
	}

	// Повторный Disable также успешен.
	if err := x.Disable(); err != nil {
		t.Errorf("повторный Disable: %v", err)
	}
}

func TestXDGEnableEmptyPathErrors(t *testing.T) {
	dir := t.TempDir()
	x := NewXDGAutostart(dir, "bookrag-companion-test")
	if err := x.Enable("", nil); err == nil {
		t.Fatal("ожидали ошибку для пустого execPath")
	}
}

func TestXDGResolveConfigHomeUsesEnv(t *testing.T) {
	custom := t.TempDir()
	t.Setenv("XDG_CONFIG_HOME", custom)
	x := NewXDGAutostart("", "bookrag-companion-test")
	if err := x.Enable("/usr/local/bin/bookrag-companion", nil); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(filepath.Join(custom, "autostart",
		"bookrag-companion-test.desktop")); err != nil {
		t.Errorf("XDG_CONFIG_HOME проигнорирован: %v", err)
	}
}
