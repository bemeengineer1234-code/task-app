# Configures git hooks so every commit auto-pushes to GitHub (Vercel deploys on push).
$ErrorActionPreference = "Stop"
$root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
Set-Location $root

git config core.hooksPath .githooks
Write-Host "Git hooks enabled: commits will auto-push to GitHub." -ForegroundColor Green
Write-Host ""
Write-Host "For Vercel deploy via GitHub Actions, add this repository secret:" -ForegroundColor Yellow
Write-Host "  VERCEL_TOKEN  ->  https://vercel.com/account/tokens"
Write-Host ""
Write-Host "Or connect the repo in Vercel Dashboard (Git) for deploy-on-push without Actions."
