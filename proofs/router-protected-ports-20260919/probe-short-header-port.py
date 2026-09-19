import pathlib,json,subprocess,hashlib,importlib.util
import pcbnew as p
R=pathlib.Path(__file__).resolve().parent
spec=importlib.util.spec_from_file_location('dsn',R/'prepare-dsn-v8.py');dsn=importlib.util.module_from_spec(spec);spec.loader.exec_module(dsn)
args0=json.loads((R/'router-invocation.json').read_text())['args'];results=[]
for name,end in [('short-extended-port',3.71)]:
 root=R/name;assert not root.exists();root.mkdir();(root/'home').mkdir();(root/'temp').mkdir()
 b=p.BOARD();b.SetCopperLayerCount(2);c=b.GetDesignSettings().m_NetSettings.GetDefaultNetclass();c.SetClearance(p.FromMM(.15));c.SetTrackWidth(p.FromMM(.2));c.SetViaDiameter(p.FromMM(.55));c.SetViaDrill(p.FromMM(.2));net=p.NETINFO_ITEM(b,'N');b.Add(net);net.SetNetClass(c)
 for i,x in enumerate([2.11,11]):
  f=p.FootprintLoad(r'C:\Program Files\KiCad\10.0\share\kicad\footprints\Connector_PinHeader_2.54mm.pretty','PinHeader_1x01_P2.54mm_Vertical');assert f;f.SetReference('J'+str(i+1));f.SetPosition(p.VECTOR2I(p.FromMM(x),p.FromMM(10)));f.SetLocked(True)
  for pad in f.Pads():pad.SetNet(net)
  b.Add(f)
 for a,z in zip([[0,0],[22,0],[22,20],[0,20]],[[22,0],[22,20],[0,20],[0,0]]):
  s=p.PCB_SHAPE(b);s.SetShape(p.SHAPE_T_SEGMENT);s.SetStart(p.VECTOR2I(*[p.FromMM(v) for v in a]));s.SetEnd(p.VECTOR2I(*[p.FromMM(v) for v in z]));s.SetWidth(p.FromMM(.05));s.SetLayer(p.Edge_Cuts);b.Add(s)
 t=p.PCB_TRACK(b);t.SetStart(p.VECTOR2I(p.FromMM(2.11),p.FromMM(10)));t.SetEnd(p.VECTOR2I(p.FromMM(end),p.FromMM(10)));t.SetWidth(p.FromMM(.2));t.SetLayer(p.F_Cu);t.SetNet(net);t.SetLocked(True);b.Add(t)
 p.SaveBoard(str(root/'input.kicad_pcb'),b);assert p.ExportSpecctraDSN(b,str(root/'native.dsn'));doc=dsn.parse((root/'native.dsn').read_text());st=dsn.child(doc,'structure');st.append(['snap_angle','fortyfive_degree']);network=dsn.child(doc,'network');network[:]=[x for x in network if not isinstance(x,list) or x[0]!='class'];network.append(['class','N_class','"N"',['circuit',['use_via','"Via[0-1]_550:200_um"'],['use_layer','F.Cu']],['rule',['width','200'],['clearance','150']]])
 for l in ['F.Cu','B.Cu']:
  for side,x0,x1 in [('left',0,3310),('right',18690,22000)]:st.append(['keepout','header_'+side+'_'+l,['rect',l,str(x0),'-20000',str(x1),'0']])
 (root/'input.dsn').write_text(dsn.write(doc).replace('(string_quote "QUOTE")','(string_quote ")')+'\n')
 args=args0[:-5]+[str(root/'input.dsn'),str(root/'output.ses'),str(root/'adapter-audit.json'),'N','5'];args=[('-Duser.home='+str(root/'home')) if x.startswith('-Duser.home=') else ('-Djava.io.tmpdir='+str(root/'temp')) if x.startswith('-Djava.io.tmpdir=') else x for x in args];run=subprocess.run(args,cwd=root,capture_output=True,text=True,timeout=15);(root/'execution.json').write_text(json.dumps({'args':args,'code':run.returncode,'stdout':run.stdout,'stderr':run.stderr},indent=2));assert run.returncode==0,(run.stdout,run.stderr);audit=json.loads((root/'adapter-audit.json').read_text());result={'case':name,'fixedLeadEndXmm':end,'before':audit['before'][0]['incompletes'],'after':audit['after'][0]['incompletes'],'timedOut':audit['timedOut']};results.append(result);print(json.dumps(result),flush=True)
(R/'header-port-short-control.json').write_text(json.dumps({'scope':'Two isolated routing-adapter fixtures only. No managed source is loaded or changed; the copper/service-band geometry is identical except for a 0.30 mm inward fixed-lead extension.','results':results},indent=2))

