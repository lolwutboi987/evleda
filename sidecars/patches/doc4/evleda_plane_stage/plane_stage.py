"""Host-private unsaved plane stage. No process launch, save, token or model API.

The host must establish saved/live equivalence before passing their independent
exact identities, keep its operation queue locked, validate this full receipt,
then use its EXISTING persistence/save/readback guard. A receipt is not acceptance.
"""
import copy
import json
import os
import threading
import time
from .native_ports import (PlaneCaptureError, identity, read_source, canonical_directory,
                          UUID, MAX_ZONES, MAX_REFERENCES, MAX_PAYLOAD, TOTAL_SECONDS)


def _identity(value):
    if not isinstance(value, dict) or set(value) != {'algorithm', 'digest', 'size'}:
        raise ValueError('Expected exact content identity')
    if value['algorithm'] != 'sha256' or not isinstance(value['digest'], str) or len(value['digest']) != 64 or any(c not in '0123456789abcdef' for c in value['digest']):
        raise ValueError('Invalid SHA256 identity')
    if type(value['size']) is not int or not 0 < value['size'] <= 1024*1024:
        raise ValueError('Invalid source byte count')


def _settings(zones):
    result = {}
    for zone in zones:
        raw = copy.deepcopy(zone['raw'])
        # Exactly the two pinned Zone descriptor cache fields; not recursive.
        raw.pop('filled', None)
        raw.pop('filled_polygons', None)
        result[zone['uuid']] = raw
    return result


def bind_plane_stage(binding, ports, *, monotonic=time.monotonic, sleep=time.sleep):
    binding = json.loads(json.dumps(binding, allow_nan=False))
    if set(binding) != {'outputRoot','projectRoot','boardPath','zoneIds','referencePads'}:
        raise ValueError('Unexpected host binding fields')
    output, project, board = (binding[k] for k in ('outputRoot','projectRoot','boardPath'))
    if not all(isinstance(p,str) and os.path.isabs(p) for p in (output,project,board)):
        raise ValueError('Absolute host paths required')
    if os.path.commonpath([output,project]) != output or output == project or os.path.dirname(board) != project or not board.endswith('.kicad_pcb'):
        raise ValueError('Board must be inside exact owned project under output')
    roots = (canonical_directory(output),canonical_directory(project))
    ids = binding['zoneIds']
    if not isinstance(ids,list) or not 0 <= len(ids) <= MAX_ZONES or any(not isinstance(i,str) or not UUID.fullmatch(i) for i in ids) or len(set(ids)) != len(ids):
        raise ValueError('Invalid complete initial zone inventory')
    refs=binding['referencePads']
    if not isinstance(refs,list) or not 1 <= len(refs) <= MAX_REFERENCES:
        raise ValueError('Physical reference pads required')
    for p in refs:
        if not isinstance(p,dict) or set(p) != {'reference','pad','primitiveId'} or not isinstance(p['primitiveId'],str) or not UUID.fullmatch(p['primitiveId']) or any(not isinstance(p[k],str) or not 1 <= len(p[k]) <= 64 for k in ('reference','pad')):
            raise ValueError('Invalid physical pad binding')
    pad_ids=[p['primitiveId'] for p in refs]
    if len(set(pad_ids)) != len(pad_ids): raise ValueError('Duplicate physical pad')
    lock=threading.Lock()

    def stage(request):
        request=json.loads(json.dumps(request,allow_nan=False))
        if set(request) not in ({'expectedSavedIdentity','expectedLiveIdentity'}, {'expectedSavedIdentity','expectedLiveIdentity','mutation'}):
            raise ValueError('Unexpected stage request fields')
        for key in ('expectedSavedIdentity','expectedLiveIdentity'): _identity(request[key])
        if not lock.acquire(blocking=False): raise ValueError('Concurrent stage forbidden')
        deadline=monotonic()+TOTAL_SECONDS
        receipt={'schemaVersion':'evleda.native-plane-stage.v1','complete':False,'nativeSaveCalled':False,
                 'mutationDispatched':False,'recoveryRequired':False,'request':request,
                 'assurance':{'accepted':False,'minimumSpokes':'not_configured_by_zone_api','highFrequencyValidity':'not_established'}}
        def fence():
            if monotonic() >= deadline: raise PlaneCaptureError('Aggregate stage deadline exceeded')
            if (canonical_directory(output),canonical_directory(project)) != roots: raise PlaneCaptureError('Owned roots changed')
        def document():
            fence(); doc=ports.document()
            actual=os.path.join(doc['project']['path'],doc['board_filename'])
            if os.path.normcase(actual) != os.path.normcase(board): raise PlaneCaptureError('Wrong exact native document')
            return doc
        def zones(expected):
            fence(); zs=ports.zones()
            if len(zs)!=len(expected) or len(zs)>MAX_ZONES or {z['uuid'] for z in zs} != set(expected): raise PlaneCaptureError('Changed complete zone inventory')
            return zs
        def unchanged_disk():
            if read_source(board)!=receipt['savedSourceBefore']: raise PlaneCaptureError('Saved preimage changed during unsaved stage')
        try:
            ports.begin(deadline)
            receipt['document']=document()
            saved=read_source(board); live=ports.source()
            receipt.update(savedSourceBefore=saved,nativeSourceBefore=live)
            if identity(saved)!=request['expectedSavedIdentity'] or identity(live)!=request['expectedLiveIdentity']:
                raise PlaneCaptureError('Host-observed saved/live preimage identity changed')
            before=zones(ids); receipt['zonesBefore']=before
            # Validate mutation completely without dispatch, including native net/layer.
            candidate=ports.prepare_mutation(request['mutation'],before) if 'mutation' in request else None
            fence()
            if document()!=receipt['document'] or read_source(board)!=saved or ports.source()!=live:
                raise PlaneCaptureError('Preimage changed immediately before dispatch')
            target_ids=list(ids)
            expected_baseline={z['uuid']:copy.deepcopy(z['raw']) for z in before}
            if candidate is not None:
                receipt['mutationDispatched']=True
                changed=ports.apply_mutation(candidate)
                receipt['zoneMutation']=changed
                new_id=changed['zoneId']
                if not isinstance(new_id,str) or not UUID.fullmatch(new_id): raise PlaneCaptureError('Mutation returned noncanonical zone UUID')
                if changed['operation']=='create':
                    if new_id in target_ids: raise PlaneCaptureError('Creation returned preexisting zone UUID')
                    target_ids.append(new_id)
                elif changed['operation']!='update' or new_id!=request['mutation']['zoneId']:
                    raise PlaneCaptureError('Update returned another zone UUID')
                expected_baseline[changed['zoneId']]=copy.deepcopy(changed['returnedProto'])
            baseline=zones(target_ids)
            if not baseline: raise PlaneCaptureError('No copper zones to refill')
            receipt['zonesBeforeUnfill']=baseline
            if {z['uuid']:z['raw'] for z in baseline} != expected_baseline:
                raise PlaneCaptureError('Postmutation inventory differs from exact returned target and untouched prior zones')
            # The preceding inventory RPC is read-only; fence sources again for
            # refill-only stages immediately before their first real mutation.
            if candidate is None and (document()!=receipt['document'] or read_source(board)!=saved or ports.source()!=live):
                raise PlaneCaptureError('Preimage changed immediately before unfill dispatch')
            receipt['mutationDispatched']=True
            ports.unfill_immediate()
            unfilled=zones(target_ids); receipt['zonesUnfilled']=unfilled
            receipt['nativeSourceUnfilled']=ports.source()
            if any(z['filled'] or any(z['filledPolygons'].values()) for z in unfilled): raise PlaneCaptureError('Unfill did not establish empty caches')
            if _settings(baseline)!=_settings(unfilled): raise PlaneCaptureError('Unfill changed non-cache zone fields')
            unchanged_disk()
            if document()!=receipt['document']: raise PlaneCaptureError('Document changed after unfill')
            ports.refill_immediate()
            busy=0
            while True:
                try: filled=zones(target_ids); break
                except Exception as error:
                    if not ports.is_busy(error): raise
                    fence(); busy+=1; sleep(min(.1,max(0,deadline-monotonic())))
            receipt['zonesStaged']=filled
            if any(not z['filled'] or not any(z['filledPolygons'].values()) for z in filled): raise PlaneCaptureError('Fill failed to advance empty caches to filled state')
            if _settings(baseline)!=_settings(filled): raise PlaneCaptureError('Fill changed non-cache zone fields')
            receipt['epoch']={'unfillAction':'pcbnew.ZoneFiller.zoneUnfillAll','fillAction':'pcbnew.ZoneFiller.zoneFillAll','unfilledObserved':True,'filledObserved':True,'busyPollCount':busy}
            native=ports.source(); snapshot=ports.pad_snapshot(pad_ids)
            receipt.update(nativeSourceStaged=native,padSnapshot=snapshot)
            queries=snapshot['connectivity']; records=snapshot['padRecords']
            if [q['sourcePrimitiveId'] for q in queries]!=pad_ids: raise PlaneCaptureError('Incomplete individual-pad query inventory')
            owners={}
            for fp in snapshot['footprintInventory']['footprints']:
                for index in fp['padRecordIndexes']:
                    p=records[index]; key=p['id']['value']
                    if key in owners: raise PlaneCaptureError('Duplicate physical-pad ownership')
                    owners[key]=(fp['reference'],p.get('number',''))
            for ref,q in zip(refs,queries):
                if owners.get(ref['primitiveId'])!=(ref['reference'],ref['pad']) or q['request']['items']!=[{'value':ref['primitiveId']}] or q['request']['types']!=['KOT_PCB_PAD']:
                    raise PlaneCaptureError('PAD query is not exact individually owned source')
            if snapshot['boardSourceBefore']!=native or snapshot['boardSourceAfter']!=native or ports.source()!=native: raise PlaneCaptureError('Source drift during PAD capture')
            unchanged_disk()
            if document()!=receipt['document']: raise PlaneCaptureError('Final document changed')
            receipt['savedSourceStaged']=read_source(board)
            if receipt['savedSourceStaged']!=saved: raise PlaneCaptureError('Final saved source differs from preimage')
            receipt['identities']={k:identity(receipt[k]) for k in ('savedSourceBefore','nativeSourceBefore','nativeSourceUnfilled','savedSourceStaged','nativeSourceStaged')}
            receipt['counts']={'physicalPads':len(records),'individualQueries':len(queries),'returnedPadsPerQuery':[len(q['padRecordIndexes']) for q in queries]}
            receipt['complete']=True
        except Exception as error:
            receipt.update(error={'type':type(error).__name__,'message':str(error)},recoveryRequired=receipt['mutationDispatched'])
            if hasattr(error,'mutation_receipt'): receipt['zoneMutation']=error.mutation_receipt
            # No blind revert: a GUI edit might explain the failure. Host owns rollback.
            for key,read in [('currentSavedSource',lambda:read_source(board)),('currentNativeSource',ports.source)]:
                try: fence(); receipt[key]=read(); receipt[key+'Identity']=identity(receipt[key])
                except Exception as observation_error: receipt[key+'Error']=str(observation_error)
        finally:
            try:
                try: receipt['rpc']=ports.receipts()
                except Exception as error: receipt.update(complete=False,recoveryRequired=receipt['mutationDispatched'],rpcReceiptError=str(error),rpc=[])
            finally:
                try:
                    try: ports.end()
                    except Exception as error: receipt.update(complete=False,recoveryRequired=receipt['mutationDispatched'],transportRestorationError=str(error))
                finally: lock.release()
        if len(json.dumps(receipt,allow_nan=False).encode('utf-8'))>MAX_PAYLOAD:
            # Never emit a truncated positive/partial geometry receipt.
            raise PlaneCaptureError('Complete stage receipt exceeds payload cap; host must retain recovery state',receipt['mutationDispatched'])
        return receipt
    return stage
