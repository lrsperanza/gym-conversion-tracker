@echo off
rem Duplo clique: so o teste local (dry-run, nao grava nada). Log em logs\
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0ship.ps1" -OnlyLocal
