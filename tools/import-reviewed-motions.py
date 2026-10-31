#!/usr/bin/env python3
"""Import an explicitly exported workbench review. The review itself stays private."""
import sys,json,hashlib,re,shutil,pathlib
root=pathlib.Path(__file__).resolve().parents[1]; source=root.parent/'animations'
review=json.load(open(sys.argv[1])); catalog=json.load(open(source/'catalog.json'))
byid={m['id']:m for m in catalog['motions']+catalog['sequences']}
approved=[x for x in review['reviews'] if x.get('rating')=='usable']
seq=[byid[x['id']] for x in approved if x['id'].startswith('sequence__')]
# A complete sequence supersedes its partial clips, except posture transitions/idle,
# which are needed to remain seated after an intentional sit-down.
parts={p['motionId'] for s in seq for p in s['parts']}
keep={'hanami-quaternius__world-sit-enter','hanami-quaternius__world-sit-exit','hanami-overte__world-sit-idle'}
exclude={'legacy-unverified__motion_cute','quaternius-converted__sitting-enter','quaternius-converted__sitting-exit'}
category={'待机':'idle','开心与鼓励':'cheer','问候与回应':'greet','拒绝与生气':'refuse','俏皮与害羞':'tease','疲倦与伸展':'tired','说话':'talk','思考与倾听':'think','难过与道歉':'sorry','惊讶':'surprise','行走与运动':'motion','运动与展示':'motion','坐姿':'pose'}
notes={'rocketbox-review__rb-happy':('握拳欢呼','开心庆祝时握拳说耶'), 'rocketbox-review__rb-neutral-4':('梳理头发','自然地用手梳理头发'), 'rocketbox-review__rb-relaxed-3':('困倦揉眼','困了时擦揉眼睛'), 'rocketbox-review__rb-relaxed':('伸懒腰','疲倦时伸懒腰'), 'rocketbox-review__rb-think-2':('抓头思考','抓头思考或困惑')}
manifest=json.load(open(root/'resources-manifest.json')); old={a.get('key'):a for a in manifest['assets'] if a.get('key')}; assets=[a for a in manifest['assets'] if not a.get('key')]; motions=[]; removed=[]
for rev in approved:
 id=rev['id']; m=byid[id]
 if (id in parts and id not in keep) or id in exclude:
  removed.append(id); continue
 if rev.get('sha256')!=m.get('sha256'): raise ValueError('reviewed source has changed: '+id)
 prefix,name=id.split('__',1)
 key=name.replace('-','_') if prefix in ('workbunny-builtins','legacy-unverified') else ('seq_' if prefix=='sequence' else {'hanami-overte':'ov_','hanami-quaternius':'hq_','rocketbox-review':'rb_','quaternius-converted':'q_','ekza-quaternius':'ek_','vox-cc0':'vox_'}[prefix])+name.replace('-','_')
 if prefix=='rocketbox-review' and key.startswith('rb_rb_'):key=key[3:]
 assert re.fullmatch('[a-z][a-z0-9_]{0,79}',key),key
 baked=False
 if prefix=='sequence': src=m['mergedPath']; expected=m['mergedSha256']; baked=True
 elif m.get('correctedPath') and rev.get('previewMode')=='workbunny' and rev.get('correctionVersion')==m.get('previewCorrection',{}).get('version'):
  src=m['correctedPath'];expected=m['correctedSha256'];baked=True
 else:src=m['path'];expected=m['sha256']
 data=(source/src).read_bytes();digest=hashlib.sha256(data).hexdigest()
 if digest!=expected:raise ValueError('changed motion '+id)
 dst=root/'src/renderer/assets/motions'/f'{key}.vrma';dst.parent.mkdir(parents=True,exist_ok=True);dst.write_bytes(data)
 label,use=notes.get(id,(m['label'],m.get('description') or m['label']))
 slot=category.get(m['category'],'motion')
 # Preserve the legacy library's more specific intent instead of treating
 # goodbyes as greetings or dances as generic exercise.
 if prefix in ('legacy-unverified','workbunny-builtins') and name.split('_',1)[0] in ('idle','work','greet','bye','cheer','praise','sign','dance','tease','refuse','angry','shy','think','sorry','tired','thanks','surprise','pose','motion','talk'):
  slot=name.split('_',1)[0]
 elif m['category']=='问候与回应':
  if any(x in label for x in ('告别','再见','拜拜')): slot='bye'
  elif any(x in label for x in ('指向','举手','手势')): slot='sign'
  elif any(x in label for x in ('点头','赞同')): slot='praise'
 is_sitting=(m['category']=='坐姿' and prefix!='sequence') or id=='workbunny-builtins__work_sit' or name in ('sitting-idle-loop','sitting-talking-loop')
 if is_sitting:
  slot=('idle' if any(x in name for x in ['idle','fidget','shift','lean']) or id=='workbunny-builtins__work_sit' else 'talk' if 'talk' in name else 'cheer' if any(x in name for x in ['clap','cheer']) else 'praise' if 'nod' in name else 'refuse' if any(x in name for x in ['shake','dismiss']) else 'greet' if 'ack' in name else 'think' if any(x in name for x in ['look','disbelief']) else 'sign' if any(x in name for x in ['point','raise-hand']) else 'sorry' if 'sad' in name else 'pose')
 transition='sit' if id=='hanami-quaternius__world-sit-enter' else 'stand' if id=='hanami-quaternius__world-sit-exit' else None
 if transition:slot='pose'
 prop=bool(re.search(r'需要道具|需道具',str(m.get('description',''))+' '.join(rev.get('issues',[]))+str(rev.get('notes','')))) or any(s in name for s in ['sword','pistol','driving','torch','pickup','fixing','push-loop','texting','drink-water','review-phone'])
 unusual=any(s in name for s in ['swim','crouch','kneel','crawl','situp','idle_walk']) or id=='sequence__sit' or slot in ('motion','dance')
 idle=bool(m.get('loopSuggested')) and (slot=='idle' or id=='hanami-overte__world-sit-idle') and not prop and not unusual
 item=dict(key=key,slot=slot,label=label,loop=bool(m.get('loopSuggested')),tag='llm',use=use[:300],src=m.get('sourceLabel','')+' / '+m.get('file',''),idle=idle,posture=('sitting' if is_sitting and transition!='sit' else 'standing'),transition=transition,requiresProp=prop,autonomous=not (prop or unusual or transition),bakedPreview=baked,sourceId=id)
 if id=='sequence__sit':item.update(posture='standing',autonomous=False,postureChanging=True)
 if transition:item.update(posture=('standing' if transition=='sit' else 'sitting'),autonomous=False)
 motions.append(item)
 previous=old.get(key,{}) if prefix=='workbunny-builtins' else {}
 asset={**previous,**item,'path':str(dst.relative_to(root)),'sha256':digest,'redistribution':'unverified' if m['licenseStatus']=='unverified' else 'allowed','license':m.get('license'),'source':m.get('sourceURL') or m.get('sourceLabel'),'sourceMotion':id,'reviewedAsset':True}
 if asset['redistribution']=='unverified':asset['selectedForRelease']=True
 assets.append(asset)
manifest['assets']=assets
selected={a['path'] for a in assets}
manifest['privateAssets']=[a for a in manifest.get('privateAssets',[]) if a.get('path') not in selected and a.get('key') not in {m['key'] for m in motions}]
(root/'resources-manifest.json').write_text(json.dumps(manifest,ensure_ascii=False,indent=2)+'\n')
(root/'src/main/reviewed-motions.js').write_text("'use strict';\n// Generated from the user's explicitly approved workbench review.\nmodule.exports = "+json.dumps(motions,ensure_ascii=False,indent=2)+';\n')
print('approved',len(approved),'included',len(motions),'deduplicated',len(removed),'unverified',sum(a.get('redistribution')=='unverified' for a in assets),'baked',sum(m['bakedPreview'] for m in motions));print('excluded',', '.join(removed))
