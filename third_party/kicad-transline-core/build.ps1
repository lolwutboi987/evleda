param(
 [Parameter(Mandatory=$true)][string]$Compiler,
 [Parameter(Mandatory=$true)][ValidateSet('zig','gnu','msvc')][string]$Driver,
 [Parameter(Mandatory=$true)][string]$OutputDirectory
)
$ErrorActionPreference='Stop'
$compilerPath=(Resolve-Path -LiteralPath $Compiler).Path
$wrapper=Get-Content (Join-Path $PSScriptRoot 'wrapper-provenance.json') -Raw | ConvertFrom-Json
if((Get-FileHash (Join-Path $PSScriptRoot 'main.cpp') -Algorithm SHA256).Hash -ne $wrapper.wrapperSha256){throw 'Wrapper source hash mismatch'}
$manifest=Get-Content (Join-Path $PSScriptRoot 'source-hashes.json') -Raw | ConvertFrom-Json
foreach($entry in $manifest){
 $actual=(Get-FileHash (Join-Path $PSScriptRoot $entry.path) -Algorithm SHA256).Hash
 if($actual -ne $entry.sha256){throw "Upstream source hash mismatch: $($entry.path)"}
}
$out=[System.IO.Path]::GetFullPath($OutputDirectory)
New-Item -ItemType Directory -Force -Path $out | Out-Null
$sourceDirectory=Join-Path $PSScriptRoot 'upstream'
$patched=Join-Path $PSScriptRoot 'patched/coupled_stripline.cpp'
if((Get-FileHash $patched -Algorithm SHA256).Hash -ne '683FA25D85758C1335EABFCEB2B4F181A8E491E8BF04D26D8480C74F12F9DF9C'){throw 'Stripline corrections patch hash mismatch'}
$coupledMicrostrip=Join-Path $PSScriptRoot 'patched/coupled_microstrip.cpp'
if((Get-FileHash $coupledMicrostrip -Algorithm SHA256).Hash -ne 'D1B1A8C8ADDA90E37A1614EE2D88E834912B682A041608D2AC792146429C41CB'){throw 'Coupled microstrip uncovered patch hash mismatch'}
$sources=@((Join-Path $PSScriptRoot 'main.cpp'),$patched,$coupledMicrostrip) + @('microstrip','stripline','transline_calculation_base' | ForEach-Object {Join-Path $sourceDirectory "transline_calculations/$_.cpp"})
$exe=Join-Path $out 'transline-core.exe'
Push-Location $out
try {
 if($Driver -eq 'msvc'){
  # Caller supplies a compiler environment with headers/libraries already available.
  & $compilerPath /nologo /std:c++17 /EHsc /O2 /D_USE_MATH_DEFINES "/I$sourceDirectory" @sources "/Fe:$exe"
 }else{
  $arguments=@('-std=c++17','-O2','-D_USE_MATH_DEFINES',"-I$sourceDirectory") + $sources + @('-o',$exe)
  if($Driver -eq 'zig'){$arguments=@('c++')+$arguments}
  & $compilerPath @arguments
 }
 if($LASTEXITCODE -ne 0){throw "Compiler exited $LASTEXITCODE"}
 Get-FileHash -LiteralPath $exe -Algorithm SHA256
} finally {Pop-Location}
