import { mkdtemp,readFile,writeFile,rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { afterEach,describe,it,expect } from "vitest";
import { prepareFreshProject } from "../../src/harness/fresh-project.js";
import { FreshBoardPersistence,hasQualifiedNativeBoardReply,type FreshBoardPersistenceSession } from "../../src/harness/fresh-board-persistence.js";
const owned=new Set<string>();
afterEach(async()=>{for(const root of owned){await rm(root,{recursive:true,force:true});owned.delete(root);}});
async function fixture(){
  const root=await mkdtemp(path.join(os.tmpdir(),'evleda-guarded-plane-'));owned.add(root);
  const project=await prepareFreshProject({outputDir:path.join(root,'output'),name:'guarded',resume:false});
  const before=await readFile(project.pcbPath,'utf8');
  const withProperty=(name:string,value:string)=>before.slice(0,before.lastIndexOf(')'))+`(property "${name}" "${value}")\n`+before.slice(before.lastIndexOf(')'));
  const staged=withProperty('stage','accepted'),external=withProperty('external','preserve');
  expect(staged).not.toBe(before);expect(external).not.toBe(before);expect(external).not.toBe(staged);
  let live=staged;const calls:string[]=[];
  const session:FreshBoardPersistenceSession={assertActivePcb:async expected=>{expect(expected).toBe(project.pcbPath);},readActivePcbSource:async()=>live,
    callTool:async name=>{calls.push(name);if(name!=='pcb_revert')throw new Error('unexpected native write');live=await readFile(project.pcbPath,'utf8');return {content:[],structuredContent:{result:'Board reverted to last saved state. All unsaved changes have been discarded.'}};}};
  const persistence=new FreshBoardPersistence(project);await persistence.capturePreMutation(session);
  return {project,before,staged,external,session,persistence,calls,setLive:(value:string)=>{live=value;},live:()=>live};
}
describe('plane-only optional persistence recovery fences',()=>{
  it('accepts only the exact session projection or concordant raw positive acknowledgement',()=>{
    const placeholder='{"schemaVersion":"evleda.kicad-mcp-result.v1","category":"validated_structured_evidence"}';
    expect(hasQualifiedNativeBoardReply({content:[{type:'text',text:placeholder}],structuredContent:{result:'Board saved.'}},'Board saved.')).toBe(true);
    expect(hasQualifiedNativeBoardReply({content:[{type:'text',text:'Board not saved.'}],structuredContent:{result:'Board saved.'}},'Board saved.')).toBe(false);
    expect(hasQualifiedNativeBoardReply({content:[{type:'text',text:placeholder}],structuredContent:{result:'Save skipped.'}},'Board saved.')).toBe(false);
    expect(hasQualifiedNativeBoardReply({content:[{type:'text',text:placeholder}]},'Board saved.')).toBe(false);
  });
  it('restores only an exact admitted stage and verifies native revert',async()=>{
    const f=await fixture();await writeFile(f.project.pcbPath,f.staged,'utf8');
    await f.persistence.rollbackToPreMutation(f.session,{expectedDiskSource:f.staged,expectedLiveSource:f.staged});
    expect(await readFile(f.project.pcbPath,'utf8')).toBe(f.before);expect(f.live()).toBe(f.before);expect(f.calls).toEqual(['pcb_revert']);
  });
  it('preserves unknown disk bytes before attempting rollback',async()=>{
    const f=await fixture();await writeFile(f.project.pcbPath,f.external,'utf8');
    await expect(f.persistence.rollbackToPreMutation(f.session,{expectedDiskSource:f.staged,expectedLiveSource:f.staged})).rejects.toThrow(/preserved/);
    expect(await readFile(f.project.pcbPath,'utf8')).toBe(f.external);expect(f.calls).toEqual([]);
  });
  it('rechecks disk after rollback temp creation and before replacement',async()=>{
    const f=await fixture();await writeFile(f.project.pcbPath,f.staged,'utf8');let activeChecks=0;
    f.session.assertActivePcb=async()=>{if(++activeChecks===3)await writeFile(f.project.pcbPath,f.external,'utf8');};
    await expect(f.persistence.rollbackToPreMutation(f.session,{expectedDiskSource:f.staged,expectedLiveSource:f.staged})).rejects.toThrow(/drift/);
    expect(await readFile(f.project.pcbPath,'utf8')).toBe(f.external);expect(f.calls).toEqual([]);
  });
  it('preserves an external live change instead of invoking revert after known disk restoration',async()=>{
    const f=await fixture();await writeFile(f.project.pcbPath,f.staged,'utf8');
    f.session.readActivePcbSource=async()=>{if(await readFile(f.project.pcbPath,'utf8')===f.before)f.setLive(f.external);return f.live();};
    await expect(f.persistence.rollbackToPreMutation(f.session,{expectedDiskSource:f.staged,expectedLiveSource:f.staged})).rejects.toThrow(/drift/);
    expect(await readFile(f.project.pcbPath,'utf8')).toBe(f.before);expect(f.live()).toBe(f.external);expect(f.calls).toEqual([]);
  });
  it('rejects fallback when live differs from the independently accepted stage',async()=>{
    const f=await fixture();f.setLive(f.external);
    await expect(f.persistence.recoverFromLiveBoard(f.session,'Saved','guarded plane fallback',true,f.staged)).rejects.toThrow(/accepted staged/);
    expect(await readFile(f.project.pcbPath,'utf8')).toBe(f.before);
  });
  it('rechecks fallback live state immediately before replacement',async()=>{
    const f=await fixture();let reads=0;f.session.readActivePcbSource=async()=>++reads===1?f.staged:f.external;
    await expect(f.persistence.recoverFromLiveBoard(f.session,'Saved','guarded plane fallback',true,f.staged)).rejects.toThrow(/before atomic replacement/);
    expect(await readFile(f.project.pcbPath,'utf8')).toBe(f.before);
  });
  it('preserves a disk edit made during the final awaited native fallback read',async()=>{
    const f=await fixture();let reads=0;
    f.session.readActivePcbSource=async()=>{if(++reads===2)await writeFile(f.project.pcbPath,f.external,'utf8');return f.staged;};
    await expect(f.persistence.recoverFromLiveBoard(f.session,'Saved','guarded plane fallback',true,f.staged)).rejects.toThrow(/during final native read/);
    expect(await readFile(f.project.pcbPath,'utf8')).toBe(f.external);expect(f.calls).toEqual([]);
  });
  it('does not clear same-byte dirty recovery on the pinned unsupported-revert reply',async()=>{
    const f=await fixture();f.setLive(f.before);
    f.session.callTool=async name=>{f.calls.push(name);return {content:[],structuredContent:{result:'Revert is not supported by the current KiCad IPC version. Please save and reload the board manually.'}};};
    await expect(f.persistence.rollbackToPreMutation(f.session,{expectedDiskSource:f.before,expectedLiveSource:f.before})).rejects.toThrow(/qualified positive native revert/);
    expect(f.persistence.hasPendingBoardMutation()).toBe(true);expect(f.calls).toEqual(['pcb_revert']);expect(await readFile(f.project.pcbPath,'utf8')).toBe(f.before);
  });
});
