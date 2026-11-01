@echo off
rem Duplo clique: executa o Cloud Run Job de verdade (grava os status no banco), reaproveitando a imagem. Log em logs\
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0ship.ps1" -SkipMigrate -SkipBack -SkipFront -SkipLocal -SkipBuild
