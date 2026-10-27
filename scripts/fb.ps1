# SEU textbook mirror (filebrowser) - READ-ONLY client.
# Account JS1257 has download-only permission: cannot create/rename/modify/delete remotely.
#
# NOTE: this file is intentionally pure ASCII (no CJK literals).
# PowerShell 5.1 reads .ps1 as ANSI unless it has a BOM; CJK literals in comments
# or strings get mis-decoded and can break parsing. Chinese paths are passed in
# as command-line arguments instead, which the host handles as UTF-16.
#
# Usage:
#   .\scripts\fb.ps1 list "/<course>"
#   .\scripts\fb.ps1 tree "/<course>" -Depth 2
#   .\scripts\fb.ps1 get  "/<course>/<file>.pdf" [-Out <dir>]

param(
  [Parameter(Position = 0)][ValidateSet('list', 'tree', 'get', 'login', 'json')][string]$Cmd = 'list',
  [Parameter(Position = 1)][string]$Path = '/',
  [int]$Depth = 1,
  [string]$Out = '',
  [int]$MaxMB = 0
)

$ErrorActionPreference = 'Stop'
$Base = 'https://tommy.seu.edu.cn/filebrowser'
# Derive project root from the script location: never hardcode a CJK path here,
# because PS 5.1 would mis-decode the literal.
$Root = Split-Path $PSScriptRoot -Parent
$TokenFile = Join-Path $Root '.fb_token'

function New-Token {
  $body = '{"username":"JS1257","password":"JS1257dl"}'
  $tmp = Join-Path $env:TEMP "fb_login_$PID.json"
  [System.IO.File]::WriteAllText($tmp, $body, (New-Object System.Text.UTF8Encoding($false)))
  try {
    $t = (curl.exe -sS -k -X POST -H "Content-Type: application/json" `
        --data-binary "@$tmp" "$Base/api/login" 2>$null | Out-String).Trim()
  } finally { Remove-Item $tmp -ErrorAction SilentlyContinue }
  if (-not $t -or $t.Length -lt 100 -or $t -notmatch '^eyJ') {
    throw "login failed: $t"
  }
  Set-Content -Path $TokenFile -Value $t -NoNewline -Encoding ascii
  return $t
}

function Get-Token {
  if (Test-Path $TokenFile) {
    $t = (Get-Content $TokenFile -Raw).Trim()
    if ($t -match '^eyJ' -and $t.Length -gt 100) { return $t }
  }
  return New-Token
}

# Percent-encode each segment. Built explicitly with += to avoid
# PowerShell operator-precedence surprises between -join and string +.
function ConvertTo-FbPath([string]$p) {
  if ([string]::IsNullOrWhiteSpace($p)) { return '/' }
  if (-not $p.StartsWith('/')) { $p = '/' + $p }
  if ($p -eq '/') { return '/' }
  $segs = $p.Trim('/') -split '/'
  $encoded = @()
  foreach ($s in $segs) {
    if ($s.Length -eq 0) { continue }
    $encoded += [uri]::EscapeDataString($s)
  }
  return '/' + ($encoded -join '/')
}

# curl with retries for transient connection resets.
function Invoke-Curl {
  param([string[]]$CurlArgs, [int]$Tries = 3)
  for ($i = 1; $i -le $Tries; $i++) {
    $out = & curl.exe @CurlArgs 2>&1
    $code = $LASTEXITCODE
    if ($code -eq 0) { return $out }
    if ($i -eq $Tries) { throw "curl failed after $Tries tries (exit $code): $out" }
    Start-Sleep -Milliseconds (800 * $i)
  }
}

function Invoke-Api([string]$rel) {
  $t = Get-Token
  $tmp = Join-Path $env:TEMP "fb_$PID.json"
  $u = "$Base/api/resources$(ConvertTo-FbPath $rel)"
  try {
    Invoke-Curl -CurlArgs @('-sS', '-k', '-H', "X-Auth: $t", '-o', $tmp, '--max-time', '60', $u) | Out-Null
    if (-not (Test-Path $tmp)) { throw 'no response body' }
    $raw = [System.IO.File]::ReadAllText($tmp, [System.Text.Encoding]::UTF8)
  } finally { Remove-Item $tmp -ErrorAction SilentlyContinue }

  if ($raw -match '^\s*(401|403)') { New-Token | Out-Null; throw 'token expired, re-login and retry' }
  if ($raw -match '^\s*404') { throw "path not found: $rel" }
  if (-not $raw.TrimStart().StartsWith('{')) { throw "unexpected response: $($raw.Substring(0,[Math]::Min(200,$raw.Length)))" }
  return $raw | ConvertFrom-Json
}

function Show-Items($obj, [string]$indent = '') {
  $dirs = @($obj.items | Where-Object { $_.isDir } | Sort-Object name)
  $files = @($obj.items | Where-Object { -not $_.isDir } | Sort-Object name)
  foreach ($d in $dirs) { Write-Output "$indent[DIR]  $($d.name)" }
  foreach ($f in $files) {
    $mb = [math]::Round($f.size / 1MB, 2)
    Write-Output ("$indent{0,9} MB  {1}" -f $mb, $f.name)
  }
  Write-Output "$indent-- $($dirs.Count) dirs / $($files.Count) files"
}

function Walk([string]$rel, [int]$left, [string]$indent) {
  $o = Invoke-Api $rel
  Show-Items $o $indent
  if ($left -le 1) { return }
  foreach ($d in @($o.items | Where-Object { $_.isDir } | Sort-Object name)) {
    $child = $rel.TrimEnd('/') + '/' + $d.name
    Write-Output ''
    Write-Output "$indent>> $($d.name)"
    Walk $child ($left - 1) ($indent + '  ')
  }
}

switch ($Cmd) {
  'login' { New-Token | Out-Null; Write-Output 'token refreshed' }

  'list' { Show-Items (Invoke-Api $Path) }

  'tree' { Walk $Path $Depth '' }

  'json' { Invoke-Api $Path | ConvertTo-Json -Depth 6 -Compress }

  'get' {
    $o = Invoke-Api $Path
    if ($o.isDir) { throw "not a file: $Path" }
    if ($MaxMB -gt 0 -and ($o.size / 1MB) -gt $MaxMB) {
      throw ("skip: {0} MB exceeds limit {1} MB" -f [math]::Round($o.size / 1MB, 2), $MaxMB)
    }
    if (-not $Out) { $Out = Join-Path $Root 'data\uploads' }
    if (-not (Test-Path $Out)) { New-Item -ItemType Directory -Path $Out -Force | Out-Null }
    $name = Split-Path $Path -Leaf
    $dest = Join-Path $Out $name
    $t = Get-Token
    $u = "$Base/api/raw$(ConvertTo-FbPath $Path)"
    $tmp = "$dest.part"
    Invoke-Curl -CurlArgs @('-sS', '-k', '-H', "X-Auth: $t", '-o', $tmp, '--max-time', '3600', $u) | Out-Null
    if (-not (Test-Path $tmp)) { throw 'download produced no file' }
    $got = (Get-Item $tmp).Length
    $want = [long]$o.size
    if ($got -ne $want) {
      $head = [System.IO.File]::ReadAllText($tmp, [System.Text.Encoding]::UTF8)
      Remove-Item $tmp -Force -ErrorAction SilentlyContinue
      throw ("size mismatch: got $got want $want. body head: " + $head.Substring(0, [Math]::Min(160, $head.Length)))
    }
    if (Test-Path $dest) { Remove-Item $dest -Force }
    Move-Item $tmp $dest
    Write-Output ("OK  {0}  {1} MB" -f $dest, [math]::Round($got / 1MB, 2))
  }
}
