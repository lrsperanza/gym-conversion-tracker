@echo off
rem Duplo clique: cancela execucoes do Cloud Run Job em andamento e baixa os logs
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0job-logs.ps1" -CancelRunning
