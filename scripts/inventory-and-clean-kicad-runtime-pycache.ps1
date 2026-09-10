param(
  [Parameter(Mandatory = $true)][string]$RuntimeRoot,
  [Parameter(Mandatory = $true)][string]$ManifestPath,
  [Parameter(Mandatory = $true)][string]$InventoryPath
)

$ErrorActionPreference = 'Stop'
$maximumEntries = 5000
$maximumBytes = 64MB

function Resolve-ExactPath([string]$Value, [string]$Label) {
  if (-not [IO.Path]::IsPathFullyQualified($Value)) { throw "$Label must be absolute." }
  $resolved = (Resolve-Path -LiteralPath $Value).Path
  if ([IO.Path]::GetFullPath($Value).TrimEnd('\') -ine [IO.Path]::GetFullPath($resolved).TrimEnd('\')) {
    throw "$Label is not its canonical path."
  }
  return $resolved
}

function Relative-Path([string]$Root, [string]$Candidate) {
  $relative = [IO.Path]::GetRelativePath($Root, $Candidate).Replace('\', '/')
  if ($relative.Length -eq 0 -or $relative -eq '.' -or $relative.StartsWith('../') -or [IO.Path]::IsPathFullyQualified($relative)) {
    throw 'Cleanup target escaped the runtime root.'
  }
  return $relative
}

function Assert-Confined([string]$Root, [string]$Candidate) {
  $rootPrefix = [IO.Path]::GetFullPath($Root).TrimEnd('\') + '\'
  $full = [IO.Path]::GetFullPath($Candidate)
  if (-not $full.StartsWith($rootPrefix, [StringComparison]::OrdinalIgnoreCase)) {
    throw 'Cleanup target is not confined to the exact runtime root.'
  }
}

$root = Resolve-ExactPath $RuntimeRoot 'Runtime root'
$manifestFile = Resolve-ExactPath $ManifestPath 'Runtime manifest'
$inventoryFull = [IO.Path]::GetFullPath($InventoryPath)
Assert-Confined ([IO.Path]::GetPathRoot($inventoryFull)) $inventoryFull
if ($inventoryFull.StartsWith(($root.TrimEnd('\') + '\'), [StringComparison]::OrdinalIgnoreCase)) {
  throw 'Inventory must be outside the runtime bundle.'
}
if (Test-Path -LiteralPath $inventoryFull) { throw 'Inventory output already exists.' }
$receiptFull = "$inventoryFull.receipt.json"
if (Test-Path -LiteralPath $receiptFull) { throw 'Cleanup receipt output already exists.' }

$rootInfo = Get-Item -LiteralPath $root -Force
if (-not $rootInfo.PSIsContainer -or ($rootInfo.Attributes -band [IO.FileAttributes]::ReparsePoint)) {
  throw 'Runtime root is not an ordinary directory.'
}
$manifest = Get-Content -LiteralPath $manifestFile -Raw | ConvertFrom-Json
$manifestFiles = [Collections.Generic.HashSet[string]]::new([StringComparer]::Ordinal)
$manifestDirectories = [Collections.Generic.HashSet[string]]::new([StringComparer]::Ordinal)
foreach ($record in $manifest.files) { if (-not $manifestFiles.Add([string]$record.path)) { throw 'Manifest has duplicate files.' } }
foreach ($record in $manifest.directories) { if (-not $manifestDirectories.Add([string]$record.path)) { throw 'Manifest has duplicate directories.' } }

$extraFiles = [Collections.Generic.List[object]]::new()
$extraDirectories = [Collections.Generic.List[object]]::new()
foreach ($item in Get-ChildItem -LiteralPath $root -Force -Recurse) {
  Assert-Confined $root $item.FullName
  if ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'Runtime contains a reparse-point cleanup candidate.' }
  $relative = Relative-Path $root $item.FullName
  if ($item.PSIsContainer) {
    if (-not $manifestDirectories.Contains($relative)) { $extraDirectories.Add($item) }
  } elseif (-not $manifestFiles.Contains($relative)) {
    $extraFiles.Add($item)
  }
}

$entryCount = $extraFiles.Count + $extraDirectories.Count
$totalBytes = [int64](($extraFiles | Measure-Object -Property Length -Sum).Sum)
if ($entryCount -lt 1 -or $entryCount -gt $maximumEntries -or $totalBytes -gt $maximumBytes) {
  throw 'Extra runtime cache inventory is outside its cleanup bounds.'
}
foreach ($file in $extraFiles) {
  $relative = Relative-Path $root $file.FullName
  if ($manifestFiles.Contains($relative) -or $file.Extension -ine '.pyc') {
    throw 'An extra runtime file is not an unmanifested .pyc file.'
  }
  $parentNames = $file.DirectoryName.Substring($root.Length).Split('\', [StringSplitOptions]::RemoveEmptyEntries)
  if (-not ($parentNames -contains '__pycache__')) { throw 'An extra .pyc file is outside __pycache__.' }
}
foreach ($directory in $extraDirectories) {
  $relative = Relative-Path $root $directory.FullName
  if ($manifestDirectories.Contains($relative) -or $directory.Name -cne '__pycache__') {
    throw 'An extra runtime directory is not an unmanifested __pycache__ directory.'
  }
}

$entries = @(
  $extraDirectories | ForEach-Object {
    [ordered]@{ kind = 'directory'; path = (Relative-Path $root $_.FullName); sizeBytes = 0; modifiedAtUtc = $_.LastWriteTimeUtc.ToString('o'); sha256 = $null }
  }
  $extraFiles | ForEach-Object {
    [ordered]@{ kind = 'file'; path = (Relative-Path $root $_.FullName); sizeBytes = [int64]$_.Length; modifiedAtUtc = $_.LastWriteTimeUtc.ToString('o'); sha256 = (Get-FileHash -LiteralPath $_.FullName -Algorithm SHA256).Hash.ToLowerInvariant() }
  }
) | Sort-Object kind,path
$inventory = [ordered]@{
  schemaVersion = 'evleda.kicad-runtime-pycache-inventory.v1'
  capturedAtUtc = [DateTime]::UtcNow.ToString('o')
  runtimeRoot = $root
  manifestPath = $manifestFile
  manifestSha256 = (Get-FileHash -LiteralPath $manifestFile -Algorithm SHA256).Hash.ToLowerInvariant()
  entryCount = $entryCount
  directoryCount = $extraDirectories.Count
  fileCount = $extraFiles.Count
  totalBytes = $totalBytes
  entries = $entries
}
$inventoryParent = [IO.Path]::GetDirectoryName($inventoryFull)
[IO.Directory]::CreateDirectory($inventoryParent) | Out-Null
[IO.File]::WriteAllText($inventoryFull, (($inventory | ConvertTo-Json -Depth 8) + "`n"), [Text.UTF8Encoding]::new($false))

# Revalidate every file's captured witness immediately before any deletion.
foreach ($entry in $entries | Where-Object kind -eq 'file') {
  $target = [IO.Path]::GetFullPath((Join-Path $root $entry.path.Replace('/', '\')))
  Assert-Confined $root $target
  $current = Get-Item -LiteralPath $target -Force
  if ($current.PSIsContainer `
      -or ($current.Attributes -band [IO.FileAttributes]::ReparsePoint) `
      -or ([int64]$current.Length) -ne ([int64]$entry.sizeBytes) `
      -or ($current.LastWriteTimeUtc.ToString('o')) -ne $entry.modifiedAtUtc `
      -or ((Get-FileHash -LiteralPath $target -Algorithm SHA256).Hash.ToLowerInvariant()) -ne $entry.sha256) {
    throw 'A cleanup target changed after inventory capture.'
  }
}

foreach ($entry in $entries | Where-Object kind -eq 'file') {
  $target = [IO.Path]::GetFullPath((Join-Path $root $entry.path.Replace('/', '\')))
  Remove-Item -LiteralPath $target
}
foreach ($entry in $entries | Where-Object kind -eq 'directory' | Sort-Object { $_.path.Length } -Descending) {
  $target = [IO.Path]::GetFullPath((Join-Path $root $entry.path.Replace('/', '\')))
  if ((Get-ChildItem -LiteralPath $target -Force | Measure-Object).Count -ne 0) { throw 'Cache directory is not empty after exact file cleanup.' }
  Remove-Item -LiteralPath $target
}
foreach ($entry in $entries) {
  $target = [IO.Path]::GetFullPath((Join-Path $root $entry.path.Replace('/', '\')))
  if (Test-Path -LiteralPath $target) { throw 'A cleanup target still exists.' }
}

$receipt = [ordered]@{
  schemaVersion = 'evleda.kicad-runtime-pycache-cleanup-receipt.v1'
  completedAtUtc = [DateTime]::UtcNow.ToString('o')
  inventoryPath = $inventoryFull
  inventorySha256 = (Get-FileHash -LiteralPath $inventoryFull -Algorithm SHA256).Hash.ToLowerInvariant()
  removedDirectoryCount = $extraDirectories.Count
  removedFileCount = $extraFiles.Count
  removedBytes = $totalBytes
}
[IO.File]::WriteAllText($receiptFull, (($receipt | ConvertTo-Json -Depth 4) + "`n"), [Text.UTF8Encoding]::new($false))
$receipt | ConvertTo-Json -Compress
