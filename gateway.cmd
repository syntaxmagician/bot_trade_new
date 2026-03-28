@echo off
rem OpenClaw Gateway (v2026.3.23-2)
set "HOME=C:\Users\vicor"
set "TMPDIR=C:\Users\vicor\AppData\Local\Temp"
set "OPENCLAW_GATEWAY_PORT=18789"
set "OPENCLAW_SYSTEMD_UNIT=openclaw-gateway.service"
set "OPENCLAW_WINDOWS_TASK_NAME=OpenClaw Gateway"
set "OPENCLAW_SERVICE_MARKER=openclaw"
set "OPENCLAW_SERVICE_KIND=gateway"
set "OPENCLAW_SERVICE_VERSION=2026.3.23-2"
"C:\Program Files\nodejs\node.exe" C:\Users\vicor\AppData\Roaming\nvm\v22.22.0\node_modules\openclaw\dist\index.js gateway --port 18789
