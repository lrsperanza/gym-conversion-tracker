@echo off
rem Duplo clique: baixa os logs recentes do Cloud Run Job para logs\job-*.log
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0job-logs.ps1"
