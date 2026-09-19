import pathlib,json,importlib.util,hashlib
import pcbnew as p
R=pathlib.Path(__file__).resolve().parent;s=importlib.util.spec_from_file_location('dsn',R/'prepare-dsn-v8.py');dsn=importlib.util.module_from_spec(s);s.loader.exec_module(dsn);rows=[]
for name,expected in [('boundary-port',2),('extended-port',1),('short-extended-port',1)]:
 r=R/name;b=p.LoadBoard(str(r/'input.kicad_pcb'));net=b.FindNet('N');assert net;doc=dsn.parse((r/'output.ses').read_text());routes=dsn.child(doc,'routes');assert dsn.child(routes,'resolution')[1:]==['um','10'];added=0
 for n in dsn.child(routes,'network_out')[1:]:
  assert dsn.val(n[1])=='N'
  for wire in n[2:]:
   assert wire[0]=='wire';q=dsn.child(wire,'path');assert q[1]=='F.Cu';points=[(round(float(q[i])*100),-round(float(q[i+1])*100)) for i in range(3,len(q),2)]
   for a,z in zip(points,points[1:]):
    t=p.PCB_TRACK(b);t.SetStart(p.VECTOR2I(*a));t.SetEnd(p.VECTOR2I(*z));t.SetWidth(round(float(q[2])*100));t.SetLayer(p.F_Cu);t.SetNet(net);b.Add(t);added+=1
 out=r/'native-result.kicad_pcb';assert not out.exists();p.SaveBoard(str(out),b);b=p.LoadBoard(str(out));b.BuildConnectivity();con=b.GetConnectivity();items=list(b.GetTracks())+[pad for f in b.GetFootprints() for pad in f.Pads()];uid=lambda t:t.m_Uuid.AsString();inv={uid(t):t for t in items};adj={uid(t):[uid(q) for q in con.GetConnectedItems(t) if uid(q) in inv] for t in items};left=set(inv);groups=[]
 while left:
  seen=set();todo=[next(iter(left))]
  while todo:
   u=todo.pop()
   if u in seen:continue
   seen.add(u);todo.extend(q for q in adj[u] if q not in seen)
  left-=seen;groups.append([inv[u].GetParentFootprint().GetReference()+'.'+inv[u].GetNumber() for u in seen if isinstance(inv[u],p.PAD)])
 count=sum(bool(g) for g in groups);assert count==expected;(r/'native-connectivity.json').write_text(json.dumps({'padGroups':groups,'connected':count==1,'addedTracks':added,'savedPcbSha256':hashlib.sha256(out.read_bytes()).hexdigest()},indent=2));rows.append({'case':name,'physicalPadGroups':count,'addedTracks':added,'nativeConnected':count==1})
(R/'header-port-native-control.json').write_text(json.dumps({'scope':'Saved and reloaded disposable KiCad connectivity only; no managed project, plane qualification or manufacturing claim.','results':rows},indent=2));print(json.dumps(rows))
