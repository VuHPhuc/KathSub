<#
.SYNOPSIS
    Script xuất bản GitHub Release v1.4.1 cho KathSub (Windows PowerShell).
.DESCRIPTION
    Khởi chạy Node.js runner để xuất bản an toàn, xử lý stream upload file lớn ~190 MB
    và ngăn chặn lỗi font UTF-8 mojibake (L-019).
#>
param(
    [string]$Token = $env:GITHUB_TOKEN
)

$ErrorActionPreference = "Stop"
$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$ProjectRoot = Split-Path -Parent $ScriptDir
Set-Location $ProjectRoot

if ($Token) {
    $env:GITHUB_TOKEN = $Token
}

Write-Host "=== Khởi chạy xuất bản GitHub Release KathSub v1.4.1 ===" -ForegroundColor Cyan
node (Join-Path $ScriptDir "publish-release.js")

