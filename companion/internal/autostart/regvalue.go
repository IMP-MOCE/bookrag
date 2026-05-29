package autostart

import "strings"

// FormatRegistryCommand собирает строку для записи в значение Windows
// Registry Run (REG_SZ): путь к исполняемому файлу + аргументы. Пробелы и
// двойные кавычки в каждом поле обрабатываются по правилам командной
// строки Windows (см. CommandLineToArgvW): если в поле есть пробел или
// табуляция — оборачивается в `"..."`; внутренние кавычки удваиваются.
//
// Чистая функция: тестируется без registry/файловой системы. На Windows
// реализация Enable() записывает результат как значение под ключом Run.
func FormatRegistryCommand(execPath string, args []string) string {
	var b strings.Builder
	b.WriteString(quoteWindowsArg(execPath))
	for _, a := range args {
		b.WriteByte(' ')
		b.WriteString(quoteWindowsArg(a))
	}
	return b.String()
}

func quoteWindowsArg(s string) string {
	if s == "" {
		return `""`
	}
	needsQuote := false
	for _, r := range s {
		if r == ' ' || r == '\t' || r == '"' {
			needsQuote = true
			break
		}
	}
	if !needsQuote {
		return s
	}
	// Простое и достаточное правило: обернуть в "..." и удвоить внутренние ".
	// Алгоритм CommandLineToArgvW также требует учёт обратных слэшей перед
	// кавычками, но мы не помещаем туда трейлинг-слэши (пути берутся из
	// os.Executable, без хвостового \).
	return `"` + strings.ReplaceAll(s, `"`, `""`) + `"`
}
