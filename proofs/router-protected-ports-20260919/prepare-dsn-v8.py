import json,pathlib,re,math,hashlib,collections,shutil
ROOT=pathlib.Path(__file__).resolve().parent
def parse(s):
    s=s.replace('(string_quote ")','(string_quote "QUOTE")')
    tok=re.findall(r'"[^"]*"|\(|\)|[^\s()]+',s);stack=[];out=[]
    for t in tok:
        if t=='(':
            row=[]
            (stack[-1] if stack else out).append(row);stack.append(row)
        elif t==')':stack.pop()
        else:stack[-1].append(t)
    assert not stack and len(out)==1
    return out[0]
def write(n,depth=0):
    if not isinstance(n,list):return str(n)
    if all(not isinstance(x,list) for x in n):return '('+' '.join(map(str,n))+')'
    return '('+' '.join(str(x) for x in n if not isinstance(x,list))+''.join('\n'+'  '*(depth+1)+write(x,depth+1) for x in n if isinstance(x,list))+'\n'+'  '*depth+')'
def child(n,k):return next(x for x in n if isinstance(x,list) and x[0]==k)
def val(x):return x.strip('"')

def main():
    assert shutil.disk_usage(ROOT).free>180*1024*1024
    assert not (ROOT/'input-v8.dsn').exists()
    model=json.loads((ROOT/'composed-input-model-v8.json').read_text());sel=json.loads((ROOT/'routing-selection-v8.json').read_text());contract=json.loads((ROOT/'closed-contract.json').read_text())
    assert hashlib.sha256((ROOT/'composed-input-model-v8.json').read_bytes()).hexdigest()==sel['composedModelSha256']
    raw=(ROOT/'native-v8.dsn').read_text();doc=parse(raw);structure=child(doc,'structure')
    layers=[x[1] for x in structure if isinstance(x,list) and x[0]=='layer'];assert layers==['F.Cu','B.Cu']
    tracks=[];vias=[]
    for item in child(doc,'wiring')[1:]:
        assert child(item,'type')[1]=='fix'
        net=val(child(item,'net')[1])
        if item[0]=='wire':
            pa=child(item,'path');assert pa[1] in layers and len(pa)>=7 and len(pa)%2==1
            pts=[(round(float(pa[j])*1000),-round(float(pa[j+1])*1000)) for j in range(3,len(pa),2)]
            for a,b in zip(pts,pts[1:]):tracks.append((net,pa[1],round(float(pa[2])*1000),*sorted([a,b])))
        elif item[0]=='via':
            assert val(item[1])=='Via[0-1]_550:200_um';vias.append((net,round(float(item[2])*1000),-round(float(item[3])*1000)))
        else:raise ValueError('Unsupported native wire')
    expected=[(t['net'],t['layer'],round(t['width']*1e6),*sorted([tuple(round(v*1e6) for v in t['a']),tuple(round(v*1e6) for v in t['b'])])) for t in model['tracks']]
    ev=[(v['net'],round(v['atMm'][0]*1e6),round(v['atMm'][1]*1e6)) for v in model['combined']['vias']]
    assert collections.Counter(tracks)==collections.Counter(expected) and collections.Counter(vias)==collections.Counter(ev)
    for r in child(structure,'rule')[1:]:
        if r[0]=='clearance':r[1]='150'
    structure.append(['snap_angle','fortyfive_degree'])
    network=child(doc,'network');network[:]=[x for x in network if not isinstance(x,list) or x[0]!='class']
    names=[val(n[1]) for n in network[1:] if n[0]=='net'];assert set(names)=={n['name'] for n in contract['nets']}|{'__NC:J1:A8','__NC:J1:B8'}
    policy={r['net']:r for r in contract['routingConstraints']['nets']};classes={r['id']:r for r in contract['netClasses']};netclasses={r['name']:classes[r['netClassId']] for r in contract['nets']}
    assert set(sel['selectedNets']).issubset(names)
    for index,name in enumerate(names):
        r=policy.get(name);c=netclasses.get(name,{'traceWidthMm':.2,'clearanceMm':.2,'allowedLayers':layers})
        rr=r.get('accessRouting',r) if r else None
        allowed=[rr['preferredLayer']] if rr and rr['preferredLayer']!='either' else c['allowedLayers']
        assert set(allowed).issubset(c['allowedLayers'])
        circuit=['circuit',['use_via','"Via[0-1]_550:200_um"'],['use_layer',*allowed]]
        if rr:circuit.append(['length',str(rr['routeLength']['maximumMm']*1000),'0'])
        network.append(['class','net_'+str(index),'"'+name+'"',circuit,['rule',['width',str(max(c['traceWidthMm'],sel.get('newBodyMinimumWidthsMm',{}).get(name,0))*1000)],['clearance',str(c['clearanceMm']*1000)]]])
    # Existing entry copper is fixed. Band obstacles forbid all NEW copper, including own net.
    # The .15mm default obstacle clearance expands 3.31/18.69 exactly to the3.46/18.54 band edges.
    bands=[]
    for layer in layers:
        for side,x0,x1 in [('left',0,3310),('right',18690,22000)]:
            row=['keepout','header_'+side+'_'+layer,['rect',layer,str(x0),'-60000',str(x1),'0']];structure.append(row);bands.append(row)
    refs=[]
    for i,t in enumerate(model['protectedTracks']):
        assert t['layer']=='F.Cu' and math.isfinite(t['referenceMarginMm']) and t['zoneIsolationMm']==.15
        a=t['a'];b=t['b'];r=t['width']/2+t['referenceMarginMm'];angle=math.atan2(b[1]-a[1],b[0]-a[0]);pts=[]
        for center,start in [(b,angle-math.pi/2),(a,angle+math.pi/2)]:
            for j in range(9):
                theta=start+j*math.pi/8;rr=r/math.cos(math.pi/16);pts.extend([f'{(center[0]+rr*math.cos(theta))*1000:.3f}',f'{-(center[1]+rr*math.sin(theta))*1000:.3f}'])
        row=['keepout','reference_'+str(i),['polygon','B.Cu','0',*pts]];structure.append(row);refs.append(row)
    out=write(doc).replace('(string_quote "QUOTE")','(string_quote ")')+'\n';(ROOT/'input-v8.dsn').write_text(out)
    receipt={'sourceModelSha256':sel['composedModelSha256'],'nativeDsnSha256':hashlib.sha256(raw.encode()).hexdigest(),'inputDsnSha256':hashlib.sha256(out.encode()).hexdigest(),'layers':layers,'fixedTracks':len(tracks),'fixedVias':len(vias),'headerBandKeepouts':bands,'referenceKeepoutBoundsUm':[[min(map(float,r[2][3::2])),min(map(float,r[2][4::2])),max(map(float,r[2][3::2])),max(map(float,r[2][4::2]))] for r in refs],'referenceKeepouts':len(refs),'selectedNets':sel['selectedNets'],'classCount':len(names),'limitations':['Via counts and aggregate length, joined turns, minimumlegs, holes/paste and whole reference checks require output rejection gates.','No net-specific header exemption. Existing40own entries are immutable fixed copper; new copper cannot enter either band.']}
    (ROOT/'dsn-preflight-v8.json').write_text(json.dumps(receipt,indent=2));print(json.dumps(receipt))
if __name__=='__main__':main()
