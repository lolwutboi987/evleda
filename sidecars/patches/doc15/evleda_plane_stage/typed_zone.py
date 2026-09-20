"""Closed host-only rectangle mutation adapter for pinned KiCad10/kipy.

minimumSpokes is retained as an external DRC requirement, NOT a Zone setter.
No action names, code, runtime paths, or arbitrary protobufs accepted as input.
"""
import copy
import re
from .native_ports import NativePlanePorts, PlaneCaptureError, UUID


def validate_mutation(value):
    required={'operation','netName','layer','rectangleNm','clearanceNm','minWidthNm','connection','islandPolicy','priority','name'}
    if not isinstance(value,dict) or value.get('operation') not in ('create','update'):
        raise ValueError('Expected typed create/update rectangle mutation')
    if value.get('connection')=='thermal': required|={'thermalGapNm','thermalSpokeWidthNm','minimumSpokes'}
    if value.get('islandPolicy')=='area': required.add('minIslandAreaNm2')
    if set(value)!=(required|({'zoneId'} if value['operation']=='update' else set())):
        raise ValueError('Unexpected rectangle mutation fields')
    if 'zoneId' in value and (not isinstance(value['zoneId'],str) or not UUID.fullmatch(value['zoneId'])): raise ValueError('Invalid zone UUID')
    for key in ('netName','name'):
        if not isinstance(value[key],str) or not 1<=len(value[key])<=128 or any(ord(c)<32 for c in value[key]): raise ValueError('Invalid zone label')
    if value['layer'] not in ('F.Cu','In1.Cu','In2.Cu','B.Cu'): raise ValueError('Typed stage supports the bounded two/four-layer copper set only')
    rectangle=value['rectangleNm']
    if not isinstance(rectangle,dict) or set(rectangle)!={'x1','y1','x2','y2'} or any(type(v)is not int or abs(v)>2_000_000_000 for v in rectangle.values()): raise ValueError('Invalid integer-nm rectangle')
    if rectangle['x1']>=rectangle['x2'] or rectangle['y1']>=rectangle['y2']: raise ValueError('Rectangle must have positive area')
    for key in ('clearanceNm','minWidthNm')+(('thermalGapNm','thermalSpokeWidthNm') if value['connection']=='thermal' else ()):
        if type(value[key])is not int or not 1<=value[key]<=50_000_000: raise ValueError('Invalid positive bounded zone dimension')
    if value['connection'] not in ('thermal','full') or value['islandPolicy'] not in ('always','never','area'): raise ValueError('Unsupported zone policy')
    if value['connection']=='thermal' and (type(value['minimumSpokes'])is not int or not 1<=value['minimumSpokes']<=4): raise ValueError('Invalid external minimum-spokes requirement')
    if value['islandPolicy']=='area':
        area=value['minIslandAreaNm2']
        # Wire is uint64, but pinned ZONE stores this as signed long long.
        if not isinstance(area,str) or not re.fullmatch(r'0|[1-9][0-9]{0,18}',area) or int(area)>2**63-1: raise ValueError('Island area must be a canonical nonnegative signed64-range decimal integer string')
    if type(value['priority'])is not int or not 0<=value['priority']<=100: raise ValueError('Invalid priority')
    return copy.deepcopy(value)


class TypedNativePlanePorts(NativePlanePorts):
    def prepare_mutation(self,value,before):
        from google.protobuf.json_format import ParseDict
        from kipy.board_types import Zone
        from kipy.geometry import PolygonWithHoles, PolyLine, PolyLineNode, Vector2
        from kipy.proto.board import board_types_pb2 as p
        value=validate_mutation(value)
        layer={'F.Cu':p.BL_F_Cu,'In1.Cu':p.BL_In1_Cu,'In2.Cu':p.BL_In2_Cu,'B.Cu':p.BL_B_Cu}[value['layer']]
        if layer not in self.board.get_enabled_layers(): raise PlaneCaptureError('Requested copper layer is not enabled')
        nets=[n for n in self.board.get_nets() if n.name==value['netName']]
        if len(nets)!=1: raise PlaneCaptureError('Requested existing net is missing or ambiguous')
        zone=Zone()
        if value['operation']=='update':
            old=[z for z in before if z['uuid']==value['zoneId']]
            if len(old)!=1: raise PlaneCaptureError('Update zone missing from complete inventory')
            zone.proto.Clear()  # ParseDict merges; never inherit kipy defaults over omitted native zeros.
            ParseDict(old[0]['raw'],zone.proto,ignore_unknown_fields=False)
            if zone.type!=p.ZT_COPPER: raise PlaneCaptureError('Cannot mutate rule/graphical area')
        zone.type=p.ZT_COPPER; zone.net=nets[0]; zone.layers=[layer]
        # Pinned BOARD_CONNECTED_ITEM::UnpackNet resolves by name; PackNet emits
        # name only. The existing unique-net check above prevents silent creation.
        zone.proto.copper_settings.net.ClearField('code')
        zone.name=value['name']; zone.priority=value['priority']
        r=value['rectangleNm']; outline=PolyLine()
        for x,y in ((r['x1'],r['y1']),(r['x2'],r['y1']),(r['x2'],r['y2']),(r['x1'],r['y2'])):
            point=Vector2(); point.x=x; point.y=y
            outline.append(PolyLineNode.from_point(point))
        outline.closed=True; polygon=PolygonWithHoles(); polygon.outline=outline; zone.outline=polygon
        zone.clearance=value['clearanceNm']; zone.min_thickness=value['minWidthNm']
        zone.island_mode={'always':p.IRM_ALWAYS,'never':p.IRM_NEVER,'area':p.IRM_AREA}[value['islandPolicy']]
        if value['islandPolicy']=='area': zone.min_island_area=int(value['minIslandAreaNm2'])
        elif value['operation']=='create': zone.min_island_area=0
        zone.proto.copper_settings.fill_mode=p.ZFM_SOLID
        connection=zone.proto.copper_settings.connection
        connection.zone_connection=p.ZCS_THERMAL if value['connection']=='thermal' else p.ZCS_FULL
        if value['connection']=='thermal':
            connection.thermal_spokes.gap.value_nm=value['thermalGapNm']
            connection.thermal_spokes.width.value_nm=value['thermalSpokeWidthNm']
        elif value['operation']=='create':
            # Inactive native zero-valued messages, not invented thermal policy.
            connection.thermal_spokes.gap.SetInParent()
            connection.thermal_spokes.width.SetInParent()
        if value['operation']=='create':
            hatch=zone.proto.copper_settings.hatch_settings
            hatch.thickness.SetInParent();hatch.gap.SetInParent();hatch.orientation.SetInParent()
            hatch.border_mode=p.ZHFBM_USE_MIN_ZONE_THICKNESS
            zone.proto.copper_settings.teardrop.type=p.TDT_NONE
        # ZONE::SetLayerSet creates one empty filled-poly container per layer,
        # including in API UPDATE's new temporary ZONE before CopyFrom.
        zone.proto.filled=False; zone.proto.ClearField('filled_polygons')
        empty=zone.proto.filled_polygons.add();empty.layer=layer;empty.shapes.SetInParent()
        return (value,zone)

    def apply_mutation(self,candidate):
        from google.protobuf.json_format import MessageToDict
        value,zone=candidate; start=len(self.calls)
        results=self.board.create_items([zone]) if value['operation']=='create' else self.board.update_items([zone])
        calls=self.calls[start:]
        if len(calls)!=1 or len(results)!=1: raise PlaneCaptureError('Mutation did not return exactly one native result',True)
        call=calls[0]; response=call.get('response',{})
        kind='created_items' if value['operation']=='create' else 'updated_items'
        result=response.get(kind,[])
        if response.get('status')!='IRS_OK' or len(result)!=1 or result[0].get('status',{}).get('code')!='ISC_OK' or result[0].get('status',{}).get('error_message'):
            raise PlaneCaptureError('Native mutation status is not exact success',True)
        doc=MessageToDict(self.board.document,preserving_proto_field_name=True)
        header=response.get('header',{})
        if ('document' in header and header['document']!=doc) or header.get('container',{}).get('value') or header.get('field_mask'):
            raise PlaneCaptureError('Mutation response header contradicts complete bound document',True)
        expected='kiapi.common.commands.'+('CreateItems' if value['operation']=='create' else 'UpdateItems')
        if call['requestType']!=expected or call['request'].get('header',{}).get('document')!=doc: raise PlaneCaptureError('Mutation request document differs',True)
        observed=results[0]
        if not UUID.fullmatch(observed.id.value): raise PlaneCaptureError('Native mutation returned noncanonical UUID',True)
        if observed.proto.DESCRIPTOR.full_name!=zone.proto.DESCRIPTOR.full_name: raise PlaneCaptureError('Mutation returned wrong native item type',True)
        requested=MessageToDict(zone.proto,preserving_proto_field_name=True)
        actual=MessageToDict(observed.proto,preserving_proto_field_name=True)
        if value['operation']=='create': requested.pop('id',None); comparable=copy.deepcopy(actual); comparable.pop('id',None)
        else: comparable=actual
        receipt={'operation':value['operation'],'zoneId':observed.id.value,'request':value,'requestedProto':requested,'returnedProto':actual,
                'nativeIdentity':{'requestedId':zone.id.value,'returnedId':observed.id.value,'requestedName':zone.name,'returnedName':observed.name,
                                  'uuidAssignedByNative':value['operation']=='create' and zone.id.value!=observed.id.value,'nameNormalized':zone.name!=observed.name},
                'minimumSpokes':({'required':value['minimumSpokes'],'configured':False,'enforcement':'requires_external_owned_DRC_rule_and_resolved_spoke_validation'} if value['connection']=='thermal' else {'applicable':False,'reason':'solid_connection'}),
                'islandMinimumArea':({'requiredNm2':value['minIslandAreaNm2'],'active':True} if value['islandPolicy']=='area' else {'active':False,'sourceRepresentation':'not_serialized','enforced':False,'nativeProtoNm2':str(observed.proto.copper_settings.min_island_area)})}
        if requested!=comparable:
            error=PlaneCaptureError('Native mutation changed requested/default zone fields',True)
            error.mutation_receipt=receipt
            raise error
        return receipt
