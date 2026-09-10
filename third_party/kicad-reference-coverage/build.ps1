param([Parameter(Mandatory=$true)][string]$Compiler,[Parameter(Mandatory=$true)][ValidateSet('zig','gnu')][string]$Driver,[Parameter(Mandatory=$true)][string]$OutputDirectory)
$ErrorActionPreference='Stop'
$compilerPath=(Resolve-Path -LiteralPath $Compiler).Path
$manifest=Get-Content (Join-Path $PSScriptRoot 'source-hashes.json') -Raw|ConvertFrom-Json
foreach($entry in $manifest){if((Get-FileHash (Join-Path $PSScriptRoot $entry.path) -Algorithm SHA256).Hash -ne $entry.sha256){throw 'Pinned Clipper source hash mismatch'}}
$out=[System.IO.Path]::GetFullPath($OutputDirectory)
New-Item -ItemType Directory -Force -Path $out|Out-Null
$arguments=@('-std=c++17','-O2',('-I'+(Join-Path $PSScriptRoot 'upstream/include')),(Join-Path $PSScriptRoot 'main.cpp'),(Join-Path $PSScriptRoot 'upstream/src/clipper.engine.cpp'),'-o',(Join-Path $out 'reference-coverage.exe'))
if($Driver -eq 'zig'){$arguments=@('c++')+$arguments}
Push-Location $out
try{& $compilerPath @arguments;if($LASTEXITCODE -ne 0){throw 'Compile failed'};Get-FileHash (Join-Path $out 'reference-coverage.exe') -Algorithm SHA256}finally{Pop-Location}
