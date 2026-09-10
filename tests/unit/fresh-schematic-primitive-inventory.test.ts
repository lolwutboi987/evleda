import {describe,expect,it} from "vitest";
import {parseFreshSchematicConnectivityPrimitiveInventory} from "../../src/harness/fresh-kicad-parser.js";
const id=(n:number)=>`aaaaaaaa-aaaa-4aaa-8aaa-${String(n).padStart(12,"0")}`;
const wire=`(wire (pts (xy 1 2) (xy 3 4)) (stroke (width 0) (type default)) (uuid "${id(1)}"))`;
const label=`(global_label "TEST" (shape passive) (at 3 4 90) (effects (font (size 1.27 1.27)) (justify left)) (uuid "${id(2)}"))`;
const nc=`(no_connect (at 7 8) (uuid "${id(3)}"))`;
const junction=`(junction (at 3 4) (diameter 0) (color 0 0 0 0) (uuid "${id(4)}"))`;
const retained='(version 20250114) (generator "test") (lib_symbols)';
const source=`(kicad_sch ${retained} ${wire} ${label} ${nc} ${junction})`;
describe("exact schematic primitive UUID-kind-geometry association",()=>{
  it("preserves every unnormalized source tuple",()=>{
    const value=parseFreshSchematicConnectivityPrimitiveInventory(source);
    expect(value.wires).toEqual([{uuid:id(1),start:{x:1,y:2},end:{x:3,y:4}}]);
    expect(value.globalLabels).toEqual([{uuid:id(2),name:"TEST",at:{x:3,y:4},rotationDeg:90,shape:"passive",justify:["left"]}]);
    expect(value.noConnects).toEqual([{uuid:id(3),at:{x:7,y:8}}]);
    expect(value.junctions).toEqual([{uuid:id(4),at:{x:3,y:4}}]);
    expect(Object.isFrozen(value.wires)).toBe(true);
  });
  it("retains wire direction and duplicate geometry instead of deduplicating",()=>{
    const second=wire.replace(id(1),id(5)).replace('(xy 1 2) (xy 3 4)','(xy 3 4) (xy 1 2)');
    const value=parseFreshSchematicConnectivityPrimitiveInventory(source.replace(wire,wire+second));
    expect(value.wires).toHaveLength(2);expect(value.wires[1]!.start).toEqual({x:3,y:4});
  });
  it.each([
    source.replace(`(uuid "${id(1)}")`,''),
    source.replace(id(3),id(1)),
    source.replace('(xy 1 2)','(xy 1 2 3)'),
    source.replace('(at 7 8)','(at 7 8 90)'),
    source.replace('(kicad_sch','(kicad_sch rogue'),
    source.replace('(shape passive)','(shape passive) (shape input)'),
  ])("rejects missing/duplicate IDs or malformed tuple fields",value=>{expect(()=>parseFreshSchematicConnectivityPrimitiveInventory(value)).toThrow();});
  it("omits only primitive forms/separator whitespace from the retained-child identity",()=>{
    const original=parseFreshSchematicConnectivityPrimitiveInventory(source).unrelatedChildrenIdentity;
    expect(parseFreshSchematicConnectivityPrimitiveInventory(`(kicad_sch\n${retained}\n)`).unrelatedChildrenIdentity).toEqual(original);
    expect(parseFreshSchematicConnectivityPrimitiveInventory(source.replace('(generator "test")','(generator "changed")')).unrelatedChildrenIdentity).not.toEqual(original);
    expect(parseFreshSchematicConnectivityPrimitiveInventory(source.replace('(version 20250114) (generator "test")','(generator "test") (version 20250114)')).unrelatedChildrenIdentity).not.toEqual(original);
    expect(parseFreshSchematicConnectivityPrimitiveInventory(source.replace('(lib_symbols)','(lib_symbols )')).unrelatedChildrenIdentity).not.toEqual(original);
  });
});
