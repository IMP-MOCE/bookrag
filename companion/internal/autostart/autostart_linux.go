//go:build linux

package autostart

func defaultManager() Manager { return NewXDGAutostart("", "") }
