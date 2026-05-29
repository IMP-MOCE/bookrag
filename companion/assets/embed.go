// Package assets отдаёт встроенные бинарные ассеты компаньона.
//
// icon.png генерируется детерминированно через cmd/gen-icon (см. main.go
// там же); тот же файл затем используется Inno Setup'ом (рядом лежит
// icon.ico — multi-resolution Windows-обёртка над тем же дизайном) и
// AppImage-сборкой. Тут он эмбедится в бинарь для трея.
package assets

import _ "embed"

// IconPNG — 256×256 PNG-байты иконки. fyne.io/systray принимает PNG
// напрямую и на Linux/macOS (нативно), и на Windows v1.12+ (конвертация
// в HICON через GDI+).
//
//go:embed icon.png
var IconPNG []byte
