param([Parameter(Mandatory=$true)][string]$Helper,[Parameter(Mandatory=$true)][string]$OutputDirectory)
$ErrorActionPreference='Stop'
$out=[IO.Path]::GetFullPath($OutputDirectory);New-Item -ItemType Directory -Force $out|Out-Null
$fixture=Get-Content (Join-Path $PSScriptRoot 'fixtures/native-fill.json') -Raw|ConvertFrom-Json
$records=[Collections.Generic.List[object]]::new()
function RequestText($polygons,$routes){
 $s=[Text.StringBuilder]::new();[void]$s.AppendLine('EVLEDA_REFERENCE_COVERAGE 1');[void]$s.AppendLine("GROUPS $($polygons.Count)")
 foreach($p in $polygons){[void]$s.AppendLine("GROUP $(1+$p.holes.Count)");$rings=[Collections.Generic.List[object]]::new();$rings.Add($p.outline);foreach($h in $p.holes){$rings.Add($h)};foreach($ring in $rings){[void]$s.AppendLine("RING $($ring.Count)");foreach($xy in $ring){[void]$s.AppendLine("$($xy[0]) $($xy[1])")}}}
 [void]$s.AppendLine("ROUTES $($routes.Count)");foreach($route in $routes){[void]$s.AppendLine('ROUTE '+($route -join ' '))};[void]$s.AppendLine('END');return $s.ToString()
}
function Run($name,$request,$expectedStatus='',$expectedError=''){
 $path=Join-Path $out ($name+'.txt');$bytes=[Text.Encoding]::ASCII.GetBytes($request);[IO.File]::WriteAllBytes($path,$bytes)
 $raw=& $Helper --input $path;$code=$LASTEXITCODE;$r=$raw|ConvertFrom-Json
 if($r.schemaVersion -ne 1 -or $r.implementationRevision -ne 'evleda-reference-coverage-v1'){throw 'Identity mismatch'}
 if($expectedError){if($code -ne 1 -or $r.error -ne $expectedError){throw "Unexpected error for $name : $raw"}}else{if($code -ne 0 -or $r.routes[0].status -ne $expectedStatus){throw "Unexpected status for $name : $raw"}}
 if($r.inputBase64 -ne [Convert]::ToBase64String($bytes)){throw 'Exact input echo mismatch'}
 $records.Add([pscustomobject]@{name=$name;exitCode=$code;result=$r});return $r
}
function Canonical($paths){
 $list=[Collections.Generic.List[string]]::new()
 foreach($path in $paths){$pts=[Collections.Generic.List[object]]::new();foreach($pt in $path){$pts.Add($pt)};$changed=$true;while($changed -and $pts.Count -ge 3){$changed=$false;for($i=0;$i -lt $pts.Count;$i++){$a=$pts[($i+$pts.Count-1)%$pts.Count];$b=$pts[$i];$c=$pts[($i+1)%$pts.Count];$cross=([decimal]$b[0]-$a[0])*([decimal]$c[1]-$a[1])-([decimal]$b[1]-$a[1])*([decimal]$c[0]-$a[0]);if($cross -eq 0){$pts.RemoveAt($i);$changed=$true;break}}};$start=0;for($i=1;$i -lt $pts.Count;$i++){if($pts[$i][0] -lt $pts[$start][0] -or ($pts[$i][0] -eq $pts[$start][0] -and $pts[$i][1] -lt $pts[$start][1])){$start=$i}};$s='';for($i=0;$i -lt $pts.Count;$i++){$pt=$pts[($start+$i)%$pts.Count];$s+="$($pt[0]),$($pt[1]);"};$list.Add($s)}
 return ($list|Sort-Object)-join '|'
}
$positive=@($fixture.cases[0].encodedPolygons);$negative=@($fixture.cases[1].encodedPolygons)
$safe=@(4000000,6000000,26000000,6000000,200000,100000)
$a=Run 'positive_raw' (RequestText $positive @(,$safe)) 'covered'
$b=Run 'positive_native_oracle' (RequestText @($fixture.cases[0].nativeUnfracturedPolygons) @(,$safe)) 'covered'
if((Canonical $a.normalizedCopper) -cne (Canonical $b.normalizedCopper)){throw 'Positive oracle mismatch'}
$local=@(4000000,6000000,12000000,6000000,200000,100000)
$a=Run 'negative_raw_local' (RequestText $negative @(,$local)) 'covered'
$b=Run 'negative_native_oracle' (RequestText @($fixture.cases[1].nativeUnfracturedPolygons) @(,$local)) 'covered'
if((Canonical $a.normalizedCopper) -cne (Canonical $b.normalizedCopper)){throw 'Negative oracle mismatch'}
$cases=@(
 @('hole_cross',@(4000000,10000000,26000000,10000000,200000,100000),'uncovered'),
 @('fracture_bridge',@(4000000,10000000,4000000,14000000,200000,100000),'covered'),
 @('margin_over_hole',@(13000000,9000000,13000000,11000000,200000,1000000),'uncovered'),
 @('margin_inside',@(13000000,9000000,13000000,11000000,200000,800000),'covered'),
 @('edge_cross',@(2050000,5000000,2050000,7000000,200000,0),'uncovered'),
 @('diagonal_inside',@(4000000,4000000,6000000,6000000,200000,100000),'covered'),
 @('exact_edge_contact',@(2200000,5000000,2200000,7000000,200000,100000),'boundary_uncertain'))
foreach($c in $cases){$null=Run $c[0] (RequestText $positive @(,$c[1])) $c[2]}
$null=Run 'island_gap' (RequestText $negative @(,$safe)) 'uncovered'
$null=Run 'empty_copper' (RequestText @() @(,$safe)) 'uncovered'
$null=Run 'duplicate_groups' (RequestText @($positive[0],$positive[0]) @(,$safe)) 'covered'
$reverse=$positive|ConvertTo-Json -Depth 20|ConvertFrom-Json;[Array]::Reverse($reverse.outline)
$null=Run 'reverse_winding' (RequestText @($reverse) @(,$safe)) 'covered'
$valid=RequestText $positive @(,$safe)
$null=Run 'bad_keyword' ($valid.Replace('GROUPS','GROUPZ')) '' 'invalid_keyword'
$null=Run 'bad_range' ($valid.Replace('4000000 6000000 26000000','2000000001 6000000 26000000')) '' 'coordinate_limit'
$null=Run 'zero_length' (RequestText $positive @(,@(4000000,6000000,4000000,6000000,200000,0))) '' 'zero_length_route'
$null=Run 'zero_width' (RequestText $positive @(,@(4000000,6000000,8000000,6000000,0,0))) '' 'invalid_width_margin'
$null=Run 'trailing' ($valid+'EXTRA') '' 'trailing_input'
$null=Run 'route_limit' ($valid.Replace('ROUTES 1','ROUTES 65')) '' 'count_limit'
$null=Run 'group_limit' ($valid.Replace('GROUPS 1','GROUPS 129')) '' 'count_limit'
$null=Run 'ring_vertex_limit' ($valid.Replace('RING 23','RING 8193')) '' 'count_limit'
function Box($x1,$y1,$x2,$y2){return [pscustomobject]@{outline=@(@($x1,$y1),@($x2,$y1),@($x2,$y2),@($x1,$y2));holes=@()}}
$box=Box 0 0 10000 10000
$null=Run 'tangent_box' (RequestText @($box) @(,@(2000,1000,8000,1000,2000,0))) 'boundary_uncertain'
$null=Run 'one_nm_inside' (RequestText @($box) @(,@(2000,1001,8000,1001,2000,0))) 'covered'
$null=Run 'one_nm_outside' (RequestText @($box) @(,@(2000,999,8000,999,2000,0))) 'uncovered'
$null=Run 'one_nm_width_empty' (RequestText @() @(,@(2000,1000,8000,1000,1,0))) 'boundary_uncertain'
$reversedBox=Box 0 0 10000 10000;[Array]::Reverse($reversedBox.outline)
$null=Run 'independent_reversed_duplicate' (RequestText @($box,$reversedBox) @(,@(2000,5000,8000,5000,2000,0))) 'covered'
$overlap=Box 5000 0 15000 10000
$overlapResult=Run 'overlapping_group_internal_boundary' (RequestText @($box,$overlap) @(,@(2000,5000,13000,5000,2000,0))) 'boundary_uncertain'
$hole1=(Box 4000 4000 6000 6000).outline;$hole2=(Box 5000 4000 7000 6000).outline
$withHoles=Box 0 0 10000 10000;$withHoles.holes=@($hole1,$hole2)
$null=Run 'overlapping_explicit_holes' (RequestText @($withHoles) @(,@(4500,4500,6500,4500,1000,0))) 'uncovered'
$null=Run 'tiny_hole_inside_envelope' (RequestText @([pscustomobject]@{outline=$box.outline;holes=@(,(Box 4999 4999 5001 5001).outline)}) @(,@(2000,5000,8000,5000,2000,0))) 'uncovered'
$null=Run 'ascii_padding_exact_echo' ($valid+(' ' * 10000)) 'covered'
$limit=Box 0 0 2000000 2000000;$holes=[Collections.Generic.List[object]]::new();$holes.Add((Box 999000 999000 1001000 1001000).outline)
for($i=0;$i -lt 499;$i++){$x=200000+($i%25)*50000;$y=300000+[Math]::Floor($i/25)*50000;$holes.Add((Box $x $y ($x+1000) ($y+1000)).outline)}
$limit.holes=$holes.ToArray();$manyRoutes=[Collections.Generic.List[object]]::new();for($i=0;$i -lt 64;$i++){$manyRoutes.Add(@(100000,1000000,1900000,1000000,1800000,0))}
$null=Run 'output_vertex_limit' (RequestText @($limit) $manyRoutes.ToArray()) '' 'geometry_output_limit'
$tooBig=Join-Path $out 'too-big.txt';[IO.File]::WriteAllBytes($tooBig,([Text.Encoding]::ASCII.GetBytes(' '*(8*1024*1024+1))))
$big=(& $Helper --input $tooBig)|ConvertFrom-Json;if($LASTEXITCODE -ne 1 -or $big.error -ne 'input_byte_limit' -or $big.inputBase64 -ne ''){throw 'Input byte limit failed'};$records.Add([pscustomobject]@{name='input_byte_limit';exitCode=1;result=$big})
$records|ConvertTo-Json -Depth 50|Out-File (Join-Path $out 'results.json') -Encoding utf8
"PASS $($records.Count) arbitrary-input helper cases plus two native oracle comparisons"
