# Starts the CUTTAlogue backend (which also serves the frontend).
# Usage: .\start.ps1
# Development with automatic Python reloads: .\start.ps1 -Reload

param(
    [switch]$Reload
)

$ErrorActionPreference = "Stop"

$repoRoot = $PSScriptRoot
$backendDir = Join-Path $repoRoot "backend"
$venvDir = Join-Path $backendDir ".venv"
$venvPython = Join-Path $venvDir "Scripts\python.exe"
$appUrl = "http://127.0.0.1:8000/"
$browserWatcher = Join-Path $repoRoot "scripts\open_browser_when_ready.py"

if (-not (Test-Path $venvPython)) {
    Write-Host "No venv found at $venvDir - creating one..."
    python -m venv $venvDir
}

# A cancelled venv creation can leave python.exe behind before pip or the
# application dependencies have been installed. Treat that state like a fresh
# environment instead of failing later with "No module named uvicorn".
& $venvPython -c "import uvicorn" 2>$null
if ($LASTEXITCODE -ne 0) {
    Write-Host "Backend dependencies are missing - installing them..."
    & $venvPython -m ensurepip --upgrade
    & $venvPython -m pip install -r (Join-Path $backendDir "requirements.txt")
}

# The watcher is detached from the server's console so it cannot interfere
# with Uvicorn's Windows reload worker or Ctrl+C handling.
Start-Process `
    -FilePath $venvPython `
    -ArgumentList @("`"$browserWatcher`"", "`"$appUrl`"") `
    -WindowStyle Hidden

$uvicornArgs = @("-m", "uvicorn", "app.main:app", "--app-dir", $backendDir)
if ($Reload) {
    $uvicornArgs += @("--reload", "--reload-dir", $backendDir)
}

& $venvPython @uvicornArgs
