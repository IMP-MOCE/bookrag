// Command gen-icon генерирует иконку компаньона в двух форматах:
//
//   - assets/icon.png  — 256×256 PNG для трея (fyne.io/systray), AppImage,
//     desktop-файла Linux.
//   - assets/icon.ico  — multi-resolution Windows ICO с PNG-вкладышами
//     для Inno Setup и Add/Remove Programs (16/32/48/256).
//
// Запуск из каталога companion/:
//
//	go run ./cmd/gen-icon
//
// Инструмент детерминирован: повторный запуск даёт байт-в-байт ту же
// иконку (одинаковая палитра, фиксированная сетка буквы "B").
package main

import (
	"bytes"
	"encoding/binary"
	"fmt"
	"image"
	"image/color"
	"image/draw"
	"image/png"
	"os"
	"path/filepath"
)

// Дизайн: сплошной BookRAG-blue фон, белая стилизованная буква "B"
// из 5×7 пиксель-сетки, центрированная.
var (
	colorBG    = color.RGBA{R: 0x4F, G: 0x8C, B: 0xFF, A: 0xFF} // BookRAG blue
	colorGlyph = color.RGBA{R: 0xFF, G: 0xFF, B: 0xFF, A: 0xFF} // white "B"
)

// Шаблон буквы "B" в сетке 5 столбцов × 7 строк (1 = пиксель глифа).
var letterB = [7][5]int{
	{1, 1, 1, 1, 0},
	{1, 0, 0, 0, 1},
	{1, 0, 0, 0, 1},
	{1, 1, 1, 1, 0},
	{1, 0, 0, 0, 1},
	{1, 0, 0, 0, 1},
	{1, 1, 1, 1, 0},
}

func renderIcon(size int) *image.RGBA {
	img := image.NewRGBA(image.Rect(0, 0, size, size))
	draw.Draw(img, img.Bounds(), &image.Uniform{C: colorBG}, image.Point{}, draw.Src)

	// Буква занимает ~62.5% размера: для 256 → 160×224, с padding по 48 сверху/снизу.
	cols, rows := 5, 7
	glyphW := size * 10 / 16 // 62.5% — целочисленно
	cell := glyphW / cols
	if cell < 1 {
		cell = 1
	}
	totalW := cell * cols
	totalH := cell * rows
	offsetX := (size - totalW) / 2
	offsetY := (size - totalH) / 2

	for y := 0; y < rows; y++ {
		for x := 0; x < cols; x++ {
			if letterB[y][x] == 0 {
				continue
			}
			rect := image.Rect(
				offsetX+x*cell,
				offsetY+y*cell,
				offsetX+(x+1)*cell,
				offsetY+(y+1)*cell,
			)
			draw.Draw(img, rect, &image.Uniform{C: colorGlyph}, image.Point{}, draw.Src)
		}
	}
	return img
}

func encodePNG(img image.Image) ([]byte, error) {
	var buf bytes.Buffer
	if err := png.Encode(&buf, img); err != nil {
		return nil, err
	}
	return buf.Bytes(), nil
}

// writeICO собирает Windows ICO (тип=1) с N PNG-вкладышами. Каждый
// PNG — отдельный размер. Спецификация: ICONDIR (6 байт) + N ×
// ICONDIRENTRY (16 байт) + данные. width/height в DIRENTRY = 0 для
// размеров ≥256.
func writeICO(path string, sizes []int) error {
	type entry struct {
		size int
		png  []byte
	}
	entries := make([]entry, 0, len(sizes))
	for _, s := range sizes {
		data, err := encodePNG(renderIcon(s))
		if err != nil {
			return fmt.Errorf("png size %d: %w", s, err)
		}
		entries = append(entries, entry{size: s, png: data})
	}

	var buf bytes.Buffer
	// ICONDIR
	if err := binary.Write(&buf, binary.LittleEndian, uint16(0)); err != nil {
		return err
	}
	if err := binary.Write(&buf, binary.LittleEndian, uint16(1)); err != nil {
		return err
	}
	if err := binary.Write(&buf, binary.LittleEndian, uint16(len(entries))); err != nil {
		return err
	}

	// Каждая DIRENTRY 16 байт; данные идут после dir.
	dataOffset := uint32(6 + 16*len(entries))
	for _, e := range entries {
		w := byte(e.size)
		h := byte(e.size)
		if e.size >= 256 {
			w, h = 0, 0
		}
		if err := buf.WriteByte(w); err != nil {
			return err
		}
		if err := buf.WriteByte(h); err != nil {
			return err
		}
		if err := buf.WriteByte(0); err != nil { // colorCount (0 для 32-bit)
			return err
		}
		if err := buf.WriteByte(0); err != nil { // reserved
			return err
		}
		if err := binary.Write(&buf, binary.LittleEndian, uint16(1)); err != nil { // planes
			return err
		}
		if err := binary.Write(&buf, binary.LittleEndian, uint16(32)); err != nil { // bitCount
			return err
		}
		if err := binary.Write(&buf, binary.LittleEndian, uint32(len(e.png))); err != nil {
			return err
		}
		if err := binary.Write(&buf, binary.LittleEndian, dataOffset); err != nil {
			return err
		}
		dataOffset += uint32(len(e.png))
	}

	for _, e := range entries {
		buf.Write(e.png)
	}

	return os.WriteFile(path, buf.Bytes(), 0o644)
}

func writePNG(path string, size int) error {
	data, err := encodePNG(renderIcon(size))
	if err != nil {
		return err
	}
	return os.WriteFile(path, data, 0o644)
}

func main() {
	dir := filepath.Join("assets")
	if err := os.MkdirAll(dir, 0o755); err != nil {
		fmt.Fprintln(os.Stderr, "mkdir:", err)
		os.Exit(1)
	}

	pngPath := filepath.Join(dir, "icon.png")
	if err := writePNG(pngPath, 256); err != nil {
		fmt.Fprintln(os.Stderr, "icon.png:", err)
		os.Exit(1)
	}
	fmt.Println("wrote", pngPath)

	icoPath := filepath.Join(dir, "icon.ico")
	if err := writeICO(icoPath, []int{16, 32, 48, 256}); err != nil {
		fmt.Fprintln(os.Stderr, "icon.ico:", err)
		os.Exit(1)
	}
	fmt.Println("wrote", icoPath)
}
