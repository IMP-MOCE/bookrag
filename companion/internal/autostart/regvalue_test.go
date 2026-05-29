package autostart

import "testing"

func TestFormatRegistryCommandNoSpaces(t *testing.T) {
	got := FormatRegistryCommand(`C:\App\bookrag.exe`, []string{"--no-tray"})
	want := `C:\App\bookrag.exe --no-tray`
	if got != want {
		t.Errorf("got %q, want %q", got, want)
	}
}

func TestFormatRegistryCommandQuotesPathsWithSpaces(t *testing.T) {
	got := FormatRegistryCommand(`C:\Program Files\BookRAG\bookrag.exe`,
		[]string{"--no-tray", `--addr=127.0.0.1:8731`})
	want := `"C:\Program Files\BookRAG\bookrag.exe" --no-tray --addr=127.0.0.1:8731`
	if got != want {
		t.Errorf("got %q, want %q", got, want)
	}
}

func TestFormatRegistryCommandQuotesArgsWithSpaces(t *testing.T) {
	got := FormatRegistryCommand(`C:\App\bookrag.exe`,
		[]string{`--data-dir=C:\Users\me\bookrag data`})
	want := `C:\App\bookrag.exe "--data-dir=C:\Users\me\bookrag data"`
	if got != want {
		t.Errorf("got %q, want %q", got, want)
	}
}

func TestFormatRegistryCommandDoublesInternalQuotes(t *testing.T) {
	got := FormatRegistryCommand(`C:\App\bookrag.exe`,
		[]string{`he said "hi"`})
	want := `C:\App\bookrag.exe "he said ""hi"""`
	if got != want {
		t.Errorf("got %q, want %q", got, want)
	}
}

func TestFormatRegistryCommandEmptyArgPreserved(t *testing.T) {
	got := FormatRegistryCommand(`C:\App\bookrag.exe`, []string{""})
	want := `C:\App\bookrag.exe ""`
	if got != want {
		t.Errorf("got %q, want %q", got, want)
	}
}
