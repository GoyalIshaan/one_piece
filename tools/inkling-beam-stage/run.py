#!/usr/bin/env python3
"""Stage or recover the pinned checkpoint under the harness's Beam pool lease."""
import argparse, concurrent.futures, fcntl, hashlib, json, os, re, signal, stat, subprocess, sys, time, uuid
from pathlib import Path
from stage_state import StageReceipt, terminal_receipt
from typing import Literal
from urllib.request import urlopen

HERE=Path(__file__).resolve().parent
OUT=HERE/'live'
SDK=Path.home()/'.local/share/uv/tools/beam-client/bin/python'
BEAM=Path.home()/'.local/bin/beam'
IMAGE='809ae21e5d81fd28'; MOUNT='/mnt/inkling-ref'; TTL=900
NAME='r54-inkling-'+uuid.uuid4().hex[:14]
LOG='stage-'+uuid.uuid4().hex+'.jsonl'
DATA=json.loads((HERE/'stage-manifest.json').read_text())
REV=DATA['revision']; WEIGHT='model-00001-of-00001.safetensors'
SRC='https://www.beam.cloud/pricing'
RECEIPT: StageReceipt = {'name':NAME,'provider_ttl_s':TTL,'image':IMAGE,'mount':MOUNT,'calls':[],'progress':[],'volume_disposition':'not_created','wheelhouse':'omitted_optional','gpu_count':0}

class Uncertain(RuntimeError): pass
class Signal(RuntimeError): pass

def mark(f,data):
    p=OUT/f; t=p.with_suffix(p.suffix+'.tmp')
    b=(json.dumps(data,indent=2,sort_keys=True)+'\n').encode() if not isinstance(data,bytes) else data
    with t.open('wb') as out: out.write(b); out.flush(); os.fsync(out.fileno())
    os.replace(t,p)

def mark_in_progress(status: Literal['not_started', 'reconciling'] = 'not_started') -> None:
    mark('receipt.json', {**RECEIPT, 'status': status, 'ready': False})

def get(f, directory=None):
    p=(directory or OUT)/f
    return json.loads(p.read_bytes()) if p.exists() else {}

def read_pricing():
    b=urlopen(SRC,timeout=9).read(2_000_000)
    text=b.decode('utf-8','replace').lower()
    assert 'storage is not billed yet' in text and '0.0001' in text
    assert '0.18972' in text and '0.0198' in text
    budget=TTL/3600*(4*0.18972+8*0.0198)
    return {'url':SRC,'checked_utc_epoch':time.time(),'response_sha256':hashlib.sha256(b).hexdigest(),'storage_billed':False,'planned_dollars_per_gb_hour':0.0001,'dollars_per_vcpu_hour':0.18972,'dollars_per_gib_hour':0.0198,'conservative_vcpu':4,'gib':8,'worst_compute_dollars':budget,'minimum_credit_cents':50}

def run(args,label,seconds=10,cwd=None):
    row={'label':label,'utc_epoch':time.time()}; RECEIPT['calls'].append(row)
    try:
        p=subprocess.run([str(a) for a in args],stdin=subprocess.DEVNULL,capture_output=True,timeout=seconds,cwd=cwd)
    except subprocess.TimeoutExpired: row['error']='client_deadline'; raise Uncertain(label+': client deadline') from None
    row['exit']=p.returncode
    if p.returncode:
        low=(p.stdout+p.stderr).lower()
        row['diagnostic']=[t for t in ('deadline_exceeded','not found','unavailable','permission denied','resource exhausted','invalid argument','quota','already exists','mount','insufficient','assertionerror','file sync','not running','no such file','not supported') if t.encode() in low]
        if label=='sandbox_create' and b'AssertionError' in p.stderr:
            row['assert_source']=[l.strip() for l in p.stderr.decode(errors='replace').splitlines() if l.strip().startswith('assert req.')]
        raise Uncertain(label+': exit '+str(p.returncode)+' '+','.join(row['diagnostic']))
    return p.stdout

def cli(*args,label=None,seconds=10):
    return run([BEAM,'--no-input','--context','default',*args],label or ' '.join(args[:2]),seconds)

def parsed(p):
    try: return json.loads(p)
    except ValueError: raise Uncertain('provider result was not JSON') from None

def inv():
    rows=parsed(cli('container','list','--format','json')); assert isinstance(rows,list)
    return rows

def vol():
    rows=parsed(cli('volume','list','--format','json')); assert isinstance(rows,list)
    return rows

def active(rows): return [r['container_id'] for r in rows]

def candidate(rows): return [r for r in rows if r.get('name')==NAME]

def safeid(x): return isinstance(x,str) and bool(re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9_-]{5,100}',x))

def admission(expected_volume_id=None):
    ops={'pricing':read_pricing,'containers':inv,'volumes':vol,'machines':lambda:parsed(cli('machine','list','--format','json','--no-offers')),'cache':lambda:parsed(run([BEAM,'--json','--context','default','image','get',IMAGE],'image get')),'credit':lambda:parsed(run([SDK,HERE/'credit.py'],'credit whoami'))}
    with concurrent.futures.ThreadPoolExecutor(max_workers=6) as pool:
        fs={k:pool.submit(fn) for k,fn in ops.items()}
        ad={}
        for k,f in fs.items():
            try: ad[k]=f.result()
            except Exception as e: ad[k]={'failure_type':type(e).__name__,'detail':str(e) if isinstance(e,Uncertain) else None}
    RECEIPT['admission']=ad
    assert not any(isinstance(a,dict) and 'failure_type' in a for a in ad.values()),'admission query failed'
    assert ad['containers']==[], 'unresolved active workspace containers'
    assert ad['machines']['machines']==[], 'workspace machine already provisioned'
    existing=candidate(ad['volumes'])
    if expected_volume_id:
        assert len(existing)==1 and existing[0]['id']==expected_volume_id, 'retained volume identity changed'
    else:
        assert existing==[], 'campaign name previously present'
    assert ad['cache']['exists'] is True and ad['cache']['image_id']==IMAGE, 'requested cached image absent'
    cred=ad['credit']; c=cred['sub']['credit']; assert cred['http']==200 and cred['error'] is None and c['ok'] is True and c['available_cents']>=ad['pricing']['minimum_credit_cents'], 'current credit not sufficient/proven'
    return ad

def fixed_exec(cid,*args,sec=8,label='exact_exec'):
    assert safeid(cid)
    return cli('container','exec','--timeout',str(sec),cid,'--',*args,label=label,seconds=sec+2)

def paths(*parts): return NAME+'/'+ '/'.join(parts)

def pathlist(path):
    r=parsed(cli('ls','--format','json',path,label='volume ls '+path)); assert isinstance(r,list)
    return r

def collect_events(blob):
    for line in blob.splitlines():
        if not line.startswith(b'{'): continue
        try: e=json.loads(line)
        except ValueError: continue
        if 'kind' not in e or 'utc_epoch' not in e: continue
        if e not in RECEIPT['progress']: RECEIPT['progress'].append(e)
    RECEIPT['progress'].sort(key=lambda e:e['utc_epoch'])

def validate_complete(blob,vid):
    c=parsed(blob)
    for k in ('revision','repo','publisher_files_sha256','git_tree_evidence','explicitly_excluded'): assert c[k]==DATA[k],k
    assert (c['volume_name'],c['volume_id'],c['mount'],c['path'])==(NAME,vid,MOUNT,MOUNT+'/'+REV)
    for group in ('files','supplemental'):
        assert [r['path'] for r in c[group]]==[r['path'] for r in DATA[group]]
        for got,want in zip(c[group],DATA[group]):
            sha=got.get('sha256')
            assert type(got.get('size')) is int and got['size']==want['size'],want['path']
            assert isinstance(sha,str) and re.fullmatch('[0-9a-f]{64}',sha),want['path']
            sha_pin=want.get('sha256'); git_pin=want.get('git_blob_sha1')
            # A null publisher SHA256 means no SHA256 pin, not an expected null measurement.
            # Require at least one authoritative pin and honor every non-null pin present.
            assert sha_pin or git_pin,want['path']
            if sha_pin is not None: assert sha==sha_pin,want['path']
            if git_pin is not None: assert got.get('git_blob_sha1')==git_pin,want['path']
            assert got.get('identity')==('pinned_git_blob_sha1' if git_pin else 'publisher_sha256'),want['path']
    assert c['required_bytes']==sum(r['size'] for r in DATA['files'])
    assert c['total_bytes']==sum(r['size'] for r in DATA['files']+DATA['supplemental'])
    return c

def capture(cid):
    code='if test -s "$1"; then tail -n 220 -- "$1"; fi; if test -f "$2"; then printf "\nR54_COMPLETE_START\n"; cat -- "$2"; printf "R54_COMPLETE_END\n"; fi'
    b=fixed_exec(cid,'sh','-c',code,'sh',MOUNT+'/'+LOG,MOUNT+'/'+REV+'/COMPLETE.json',label='poll_exact')
    if b'\nR54_COMPLETE_START\n' not in b:
        collect_events(b); return None
    logs,blob=b.split(b'\nR54_COMPLETE_START\n',1); collect_events(logs)
    assert blob.endswith(b'R54_COMPLETE_END\n')
    return blob.removesuffix(b'R54_COMPLETE_END\n')

def exact_absent():
    c=get('sandbox.json'); stub=get('stub.json'); cid=c.get('container_id'); sid=stub.get('stub_id') or c.get('stub_id')
    assert not cid or safeid(cid)
    assert not sid or safeid(sid)
    attempts=RECEIPT.setdefault('sandbox_reconcile',[])
    intent=bool(get('sandbox-intent.json'))
    # With no stub record, sdk never populated stub_id and cannot reach create_pod.
    confirmed=0; known=set([cid] if cid else [])
    for _ in range(7):
        try:
            rows=inv()
            matched={r['container_id'] for r in rows if r.get('container_id')==cid or (sid and r.get('stub_id')==sid)}
            known|=matched
            attempts.append({'utc_epoch':time.time(),'all_active':active(rows),'matching':sorted(matched),'exact_test_ids':sorted(known),'stub_id':sid})
            if matched:
                confirmed=0
                for i in sorted(matched):
                    assert safeid(i)
                    try: cli('container','stop',i,seconds=8,label='stop_exact '+i)
                    except Uncertain: pass # Reconcile through next inventory, not a new sandbox.
            else:
                confirmed+=1
                if confirmed>=2 and (known or not sid):
                    return {'terminal':True,'exact_id_absent_twice':bool(known),'exact_ids':sorted(known),'stub_id':sid,'create_intent':intent,'workspace_empty':not rows}
        except Uncertain as e:
            confirmed=0; attempts.append({'error':str(e),'utc_epoch':time.time()})
        time.sleep(2.5)
    return {'terminal':False,'exact_id_absent_twice':False,'exact_ids':sorted(known),'stub_id':sid,'create_intent':intent}

def check_poststop_volume(vid,marker,marker_size):
    assert candidate_latest_id()==vid
    tree={}
    for directory in ('', 'tiktoken'):
        rr=pathlist(paths(REV,*([directory] if directory else [])))
        for r in rr:
            name=Path(r['path']).name
            if r.get('is_dir'): continue
            tree['/'.join(x for x in (directory,name) if x)]=int(r.get('size',0))
    assert tree=={**{r['path']:r['size'] for r in marker['files']+marker['supplemental']},'COMPLETE.json':marker_size},'poststop volume sizes/set differ'
    RECEIPT['poststop_tree']=tree
    root=pathlist(paths())
    assert {Path(r['path']).name for r in root if r.get('is_dir')}=={REV},'poststop volume revision directory differs'
    assert all(re.fullmatch(r'stage(?:-[0-9a-f]{32})?\.jsonl',Path(r['path']).name) for r in root if not r.get('is_dir')),'poststop volume root has extra artifacts'

def recover_complete(vid):
    assert candidate_latest_id()==vid, 'owned volume ID changed'
    if not any(Path(r['path']).name==REV and r.get('is_dir') for r in pathlist(paths())):
        return None
    tree=pathlist(paths(REV)); r=next((r for r in tree if Path(r['path']).name=='COMPLETE.json' and not r.get('is_dir')),None)
    if not r: return None
    assert 1<=int(r.get('size',0))<=12000
    q=OUT/'empty'/'marker-recovery.json'; assert not q.exists()
    cli('cp','--multipart',f'beam://{NAME}/{REV}/COMPLETE.json',str(q),label='recover_small_marker_only',seconds=15)
    assert q.stat().st_size==int(r['size']); blob=q.read_bytes()
    RECEIPT['poststop_marker_recovery']={'recovered':True,'method':'exact owned Volume marker, provider multipart'}
    return blob

def candidate_latest_id():
    q=candidate(vol()); assert len(q)==1 and safeid(q[0]['id']); return q[0]['id']

def ls_partial():
    for loc in (paths(),paths(REV),paths(REV,'tiktoken')):
        try: RECEIPT.setdefault('failure_owned_volume_listing',{})[loc]=pathlist(loc)
        except Uncertain as e: RECEIPT.setdefault('failure_owned_volume_listing',{})[loc]={'error':str(e)}

def record_marker(blob):
    mark('COMPLETE.json',blob)
    RECEIPT['complete_sha256']=hashlib.sha256(blob).hexdigest()
    RECEIPT['complete_size']=len(blob)

def confirm_checkpoint(vid,blob):
    record_marker(blob)
    c=validate_complete(blob,vid)
    for attempt in range(3):
        try:
            check_poststop_volume(vid,c,len(blob))
            break
        except (Uncertain,AssertionError):
            if attempt==2:
                raise
            time.sleep(2)
    RECEIPT['consumption']={'uri':f'beam://{NAME}/{REV}','sandbox_mount_path':c['path'],'total_bytes':c['total_bytes'],'required_bytes':c['required_bytes']}
    RECEIPT['volume_disposition']='retained_verified_complete'

def cancel(sig,frame): raise Signal(str(sig))

def retained_volume(source):
    prior=json.loads(source.read_bytes())
    volume=prior.get('volume') or get('volume.json',source.parent)
    name=prior.get('name')
    if (not isinstance(name,str) or not re.fullmatch(r'r54-inkling-[0-9a-f]{14}',name)
            or volume.get('name')!=name or not safeid(volume.get('id'))
            or prior.get('revision',REV)!=REV):
        raise Uncertain('prior attempt has no exact volume identity for this revision')
    return prior,volume

def previous_create_deadline(source,prior):
    deadline=prior.get('unacknowledged_create_until',0)
    intent=get('sandbox-intent.json',source.parent)
    if intent and not prior.get('sandbox_terminal',{}).get('terminal') and not get('sandbox.json',source.parent):
        deadline=max(deadline,intent['utc_epoch']+TTL+60)
    return deadline

def check_resume_idle(vid):
    if time.time()<RECEIPT.get('unacknowledged_create_until',0):
        raise Uncertain('previous sandbox creation was unacknowledged; wait for its provider TTL')
    assert candidate_latest_id()==vid, 'retained volume identity changed'
    assert inv()==[], 'unresolved active workspace containers'
    time.sleep(2.5)
    assert inv()==[], 'workspace became active during reconciliation'

def diagnostic(error, phase):
    return {'phase':phase,'type':type(error).__name__,
            'detail':str(error) if isinstance(error,(Uncertain,AssertionError,Signal)) else None}

def main(source=None):
    prior,existing=retained_volume(source) if source else ({},{})
    OUT.mkdir(parents=True,exist_ok=False); (OUT/'empty').mkdir()
    RECEIPT.update({'started_utc_epoch': time.time(), 'revision': REV, 'stage_log': LOG})
    vid=existing.get('id')
    if source:
        RECEIPT.update({'resumes_receipt': str(source), 'volume': existing, 'volume_disposition': 'retained_unreconciled_do_not_use'})
        RECEIPT['unacknowledged_create_until']=previous_create_deadline(source,prior)
        mark('volume.json',existing)
    mark_in_progress()
    status='admission'; blob=None
    signals=(signal.SIGINT,signal.SIGTERM,signal.SIGHUP)
    handlers={sig:signal.signal(sig,cancel) for sig in signals}
    try:
        if source:
            status='resume_preflight'
            check_resume_idle(vid)
            RECEIPT.pop('unacknowledged_create_until',None)
            RECEIPT['sandbox_terminal']={'terminal':True,'workspace_empty':True,'not_launched':True}
            status='retained_marker_validation'
            RECEIPT['volume_disposition']='retained_unverified'
            blob=recover_complete(vid)
            if blob is not None:
                confirm_checkpoint(vid,blob)
            else:
                RECEIPT['volume_disposition']='retained_incomplete'
        if RECEIPT['volume_disposition']!='retained_verified_complete':
            status='admission'
            admission(vid)
            if not source:
                status='volume_create'
                mark('volume-intent.json',{'name':NAME,'utc_epoch':time.time(),'initial_absent':True})
                v=parsed(cli('volume','create','--format','json',NAME,label='create_one_volume',seconds=15))
                assert v['name']==NAME and safeid(v['id'])
                vid=v['id']
                mark('volume.json',v)
                RECEIPT.update({'volume': v, 'volume_disposition': 'created'})
            assert candidate_latest_id()==vid and inv()==[], 'volume ID or workspace admission changed'
            print('Exact owned volume:',NAME,vid,flush=True)
            RECEIPT.pop('sandbox_terminal',None)
            mark_in_progress()
            status='sandbox_create'; start=time.monotonic()
            run([SDK,HERE/'create.py',OUT,NAME,vid],'sandbox_create',57,cwd=OUT/'empty')
            c=get('sandbox.json'); cid=c['container_id']; assert safeid(cid) and c['volume_id']==vid
            print('Exact CPU sandbox:',cid,'stub:',c['stub_id'],flush=True)
            status='sandbox_startup'
            while time.monotonic()<start+165:
                rows=inv(); ours=[r for r in rows if r.get('container_id')==cid]
                if ours and ours[0]['status'].lower()=='running':
                    RECEIPT['running']=ours[0]; break
                if not ours:
                    time.sleep(2); again=inv()
                    if cid not in active(again): raise Uncertain('sandbox absent twice before running')
                time.sleep(2)
            else: raise Uncertain('sandbox exceeded t+165 startup gate')
            status='guest_bootstrap'
            tmp='/tmp/r54-stage'; fixed_exec(cid,'mkdir','-p',tmp,label='guest_mkdir')
            for fn in ('guest.py','stage-manifest.json'):
                cli('container','cp',HERE/fn,f'{cid}:{tmp}/{fn}',label='upload '+fn,seconds=12)
            limit=int(start+855-time.monotonic()); assert 10<limit<=855
            RECEIPT['guest_limit_s']=limit
            status='guest_launch'
            command='set -euC; test -d "$1"; mountpoint -q -- "$1"; nohup timeout -k 5s "$2"s python3.12 -I -u "$3/guest.py" "$3/stage-manifest.json" "$2" "$4" "$5" "$6" "$7" </dev/null >"$1/$6" 2>&1 & echo $!'
            try:
                b=fixed_exec(cid,'sh','-c',command,'sh',MOUNT,str(limit),tmp,NAME,vid,LOG,'resume' if source else 'fresh',label='guest_launch_once')
                pids=[int(l) for l in b.splitlines() if l.isdigit()]; assert len(pids)==1
                RECEIPT['guest_watchdog_pid']=pids[0]
            except Uncertain as e:
                RECEIPT['ambiguous_guest_launch']=str(e)
                # Never restart. Check sandbox and poll only this ID for an existing guest.
            status='guest_poll'
            while time.monotonic()<start+855:
                old=len(RECEIPT['progress']); poll_ok=False
                try: blob=capture(cid); poll_ok=True
                except Uncertain as e: RECEIPT['last_poll_rpc_error']=str(e)
                rows=inv()
                if cid not in active(rows):
                    time.sleep(2)
                    if cid not in active(inv()):
                        RECEIPT['host_loss_before_evidence']=not bool(blob)
                        if not blob: raise Uncertain('sandbox absent twice during stage')
                        break
                for event in RECEIPT['progress'][old:]:
                    if event['kind'] in ('boot','progress','failure','complete') and event.get('file',WEIGHT)==WEIGHT: print(json.dumps(event,separators=(',',':')),flush=True)
                if blob: break
                if any(e['kind']=='failure' for e in RECEIPT['progress']): raise Uncertain('guest reported terminal failure')
                if not RECEIPT['progress'] and poll_ok and time.monotonic()>start+210: raise Uncertain('no evidence guest launched before t+210')
                if len(RECEIPT['calls'])%5==0: mark_in_progress()
                time.sleep(max(0,min(7,start+855-time.monotonic())))
            if not blob: raise Uncertain('controller stage deadline, no verified marker')
            status='capture_guest'
            record_marker(blob)
    except BaseException as e:
        RECEIPT['error']=diagnostic(e,status)
    finally:
        for sig in signals:
            signal.signal(sig,signal.SIG_IGN)
        try:
            ready=reconcile(vid,blob)
        finally:
            for sig,handler in handlers.items():
                signal.signal(sig,handler)
    return 0 if ready else 1

def reconcile(vid,blob):
    phase='sandbox_reconciliation'
    try:
        RECEIPT.update({'sandbox': get('sandbox.json'), 'sandbox_intent': get('sandbox-intent.json'), 'stub': get('stub.json')})
        mark_in_progress('reconciling')
        volume_intent=get('volume-intent.json')
        attempted=bool(volume_intent or RECEIPT['sandbox_intent'])
        terminal=exact_absent() if attempted else RECEIPT.get('sandbox_terminal',{})
        RECEIPT['sandbox_terminal']=terminal
        if volume_intent and not vid:
            for attempt in range(2):
                if attempt:
                    time.sleep(3)
                seen=candidate(vol())
                if seen:
                    break
            if len(seen)==1 and safeid(seen[0]['id']):
                vid=seen[0]['id']
                RECEIPT.update({'volume': seen[0], 'volume_disposition': 'retained_unreconciled_do_not_use'})
                mark('volume.json',seen[0])
            else:
                RECEIPT['volume_disposition']='ambiguous_exact_volume' if seen else 'create_unacknowledged_name_absent_twice'
        if attempted and vid and terminal.get('terminal') and terminal.get('workspace_empty'):
            phase='poststop_volume_validation'
            assert candidate_latest_id()==vid, 'owned volume ID changed'
            RECEIPT['volume_disposition']='retained_unverified'
            if blob is None:
                blob=recover_complete(vid)
            if blob is not None:
                confirm_checkpoint(vid,blob)
            else:
                RECEIPT['volume_disposition']='retained_incomplete'
                ls_partial()
        elif attempted and vid:
            RECEIPT['volume_disposition']='retained_unreconciled_do_not_use'
    except BaseException as e:
        RECEIPT['reconcile_error']=diagnostic(e,phase)
        if vid and RECEIPT['volume_disposition'] not in ('retained_unverified','retained_verified_complete'):
            RECEIPT['volume_disposition']='retained_unreconciled_do_not_use'
    final=terminal_receipt(RECEIPT['volume_disposition'])
    if vid and not final['ready']:
        RECEIPT['resume_from']=str(OUT/'receipt.json')
    RECEIPT['elapsed_s']=time.time()-RECEIPT['started_utc_epoch']
    receipt={**RECEIPT, **final}
    mark('receipt.json',receipt)
    print(json.dumps({k:receipt.get(k) for k in ('status','name','ready','volume_disposition','resume_from','sandbox_terminal','consumption','error','reconcile_error')}),flush=True)
    return final['ready']

def entrypoint():
    global NAME,OUT
    if not __debug__:
        raise RuntimeError('checkpoint staging requires Python assertions')
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--single-authorized-run',action='store_true',required=True)
    parser.add_argument('--resume-from',type=Path,help='receipt.json recording the exact retained Beam volume')
    parser.add_argument('--output-dir',type=Path,required=True,help='new local directory for this attempt')
    args=parser.parse_args()
    source=args.resume_from.resolve() if args.resume_from else None
    if source:
        _,volume=retained_volume(source)
        NAME=volume['name']
    OUT=args.output_dir.resolve()
    RECEIPT['name']=NAME
    lockdir=volume_lock_dir(Path('/tmp').resolve())
    with (lockdir/(NAME+'.lock')).open('a') as lock:
        fcntl.flock(lock,fcntl.LOCK_EX|fcntl.LOCK_NB)
        return main(source)

def volume_lock_dir(shared_temp):
    # Keep the same per-volume lock for direct and sandboxed invocations on this host.
    uid=os.getuid()
    directory=shared_temp/f'one-piece-inkling-beam-stage-{uid}'
    directory.mkdir(mode=0o700,exist_ok=True)
    info=directory.lstat()
    if not stat.S_ISDIR(info.st_mode) or info.st_uid!=uid or info.st_mode & 0o077:
        raise Uncertain('Beam staging lock directory must be private to the local user')
    return directory

if __name__=='__main__':
    sys.exit(entrypoint())
