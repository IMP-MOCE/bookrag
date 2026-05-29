// Package buildinfo хранит версию бинаря. Значение подставляется при сборке
// через -ldflags "-X .../buildinfo.Version=vX.Y.Z"; по умолчанию "dev".
package buildinfo

// Version — версия компаньона. Перезаписывается линкером в релизных сборках.
var Version = "dev"
