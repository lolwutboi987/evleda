"""Read-only regional diagnosis of the published candidate, never a fill or save."""
import hashlib
import html
import json
import math
import pathlib
import sys
import pcbnew as p

root=pathlib.Path(__file__).resolve().parent
source=root.parent/'native-r1/native/rp2350-pico-4layer.kicad_pcb'
out=pathlib.Path(sys.argv[1]).resolve() if len(sys.argv)>1 else root/'replayed-plane-regions'
assert not out.exists()
out.mkdir()
before=source.read_bytes()
assert hashlib.sha256(before).hexdigest()=='7b374f36237dd914d89cc6d676965a3dafe3ec11b47fb35c0d9bf6052ff56f57'
_types=(p.FOOTPRINT,p.PAD,p.PCB_TRACK,p.PCB_VIA,p.ZONE,p.SHAPE_POLY_SET,p.SHAPE_LINE_CHAIN)
assert p.GetBuildVersion()=='10.0.3'
board=p.LoadBoard(str(source));board.BuildConnectivity();connection=board.GetConnectivity()
pads=[q for f in board.GetFootprints() for q in f.Pads() if q.GetNetname()=='GND']
vias=[v for v in board.GetTracks() if isinstance(v,p.PCB_VIA) and v.GetNetname()=='GND']
names={q.m_Uuid.AsString():q.GetParentFootprint().GetReference()+'.'+q.GetNumber() for q in pads}
mm=lambda pt:[pt.x/1e6,pt.y/1e6]
chain=lambda c:[mm(c.CPoint(i)) for i in range(c.PointCount())]
def reachable(item):
    return sorted({names[x.m_Uuid.AsString()] for x in connection.GetConnectedItems(item) if x.m_Uuid.AsString() in names})
def samples(item):
    at=item.GetPosition()
    if isinstance(item,p.PCB_VIA):
        r=(item.GetWidth(p.F_Cu)+item.GetDrillValue())//4
        return [p.VECTOR2I(at.x+dx,at.y+dy) for dx,dy in [(r,0),(-r,0),(0,r),(0,-r)]]
    if item.GetDrillSize().x==0 and item.GetDrillSize().y==0:return [at]
    # Plated pad annulus cardinal witnesses, kept separate from complete shape proof.
    sx=item.GetSize().x;sy=item.GetSize().y;dx=item.GetDrillSize().x;dy=item.GetDrillSize().y
    rx=(sx+dx)//4;ry=(sy+dy)//4
    angle=math.radians(item.GetOrientationDegrees());c=math.cos(angle);s=math.sin(angle)
    return [p.VECTOR2I(at.x+round(x*c+y*s),at.y+round(-x*s+y*c)) for x,y in [(rx,0),(-rx,0),(0,ry),(0,-ry)]]
anchors=[]
for item in pads+vias:
    anchors.append({'item':item,'id':item.m_Uuid.AsString(),'label':names.get(item.m_Uuid.AsString(),'GND via'),
                    'atMm':mm(item.GetPosition()),'points':samples(item),'nativeReachableGroundTerminals':reachable(item)})
zones=[];svg=['<svg xmlns="http://www.w3.org/2000/svg" viewBox="-2 -3 26 67" width="780" height="2010">','<rect x="-2" y="-3" width="26" height="67" fill="white"/>','<text x="0" y="-1.5" font-size=".7" font-family="sans-serif">In2 stored ground regions and signal tracks</text>','<rect x="0" y="0" width="22" height="60" fill="none" stroke="black" stroke-width=".06"/>']
colors=['#a6cee3','#b2df8a','#fb9a99','#fdbf6f','#cab2d6','#ffff99','#80cdc1','#dfc27d','#b3b3b3','#f1b6da']
for zone in board.Zones():
    polys=zone.GetFilledPolysList(zone.GetLayer());regions=[]
    for i in range(polys.OutlineCount()):
        outer=chain(polys.COutline(i));holes=[chain(polys.CHole(i,h)) for h in range(polys.HoleCount(i))]
        candidates=[]
        for a in anchors:
            if not a['item'].IsOnLayer(zone.GetLayer()):continue
            witnesses=[mm(pt) for pt in a['points'] if polys.Contains(pt,i)]
            if witnesses:candidates.append({k:v for k,v in a.items() if k not in ['item','points']}|{'filledCopperWitnessesMm':witnesses})
        box=polys.COutline(i).BBox();region={'index':i,'storedNativeIslandFlag':zone.IsIsland(zone.GetLayer(),i),'boundsMm':[box.GetX()/1e6,box.GetY()/1e6,(box.GetX()+box.GetWidth())/1e6,(box.GetY()+box.GetHeight())/1e6],
            'outer':outer,'holes':holes,'groundAnchorSamples':candidates};regions.append(region)
        if zone.GetLayer()==p.In2_Cu:
            d=' '.join('M '+' L '.join(f'{x:.6f},{y:.6f}' for x,y in c)+' Z' for c in [outer]+holes)
            svg.append(f'<path d="{d}" fill="{colors[i%len(colors)]}" fill-rule="evenodd" stroke="#777" stroke-width=".025"/>')
            x,y=outer[0];svg.append(f'<text x="{x}" y="{y-.15}" font-size=".6" font-family="sans-serif" fill="black">R{i}</text>')
    zones.append({'name':zone.GetZoneName(),'layer':board.GetLayerName(zone.GetLayer()),'regions':regions})
for track in board.GetTracks():
    if isinstance(track,p.PCB_VIA):
        if track.GetNetname()=='GND':
            x,y=mm(track.GetPosition());svg.append(f'<circle cx="{x}" cy="{y}" r="{track.GetWidth(p.F_Cu)/2e6}" fill="#be2020"/><circle cx="{x}" cy="{y}" r="{track.GetDrillValue()/2e6}" fill="white"/>')
    elif track.GetLayer()==p.In2_Cu:
        a=mm(track.GetStart());b=mm(track.GetEnd());net=html.escape(track.GetNetname());svg.append(f'<path d="M {a[0]},{a[1]} L {b[0]},{b[1]}" stroke="#183553" stroke-width="{track.GetWidth()/1e6}" fill="none"><title>{net}</title></path>')
svg.append('</svg>')
(out/'in2-regions.svg').write_text('\n'.join(svg),encoding='utf-8')
assert source.read_bytes()==before
report={'scope':'Read-only native stored-fill component map with centre/annulus point witnesses and native ground-pad reachability. Sampling is not a complete pad/track/barrel intersection proof, drill-clipped topology, live-fill authority or a waiver of the single-component contract.',
 'sourceSha256':hashlib.sha256(before).hexdigest(),'nativeVersion':p.GetBuildVersion(),'sourceUnchanged':True,'zones':zones}
(out/'regions.json').write_text(json.dumps(report,indent=2)+'\n',encoding='utf-8')
print(json.dumps([{'plane':z['name'],'layer':z['layer'],'regions':[{'index':r['index'],'bounds':r['boundsMm'],'nativeIsland':r['storedNativeIslandFlag'],'anchorCount':len(r['groundAnchorSamples']),'fullGroundReachabilityWitness':any(len(a['nativeReachableGroundTerminals'])>=len(set(names.values())) for a in r['groundAnchorSamples'])} for r in z['regions']]} for z in zones]))
