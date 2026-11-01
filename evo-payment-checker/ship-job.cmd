@echo off
rem Duplo clique: build + publica o Cloud Run Job e executa em DRY-RUN (nao grava). Log em logs\
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0ship.ps1" -SkipMigrate -SkipBack -SkipFront -SkipLocal -JobDryRun
