"""Pinned public original checkpoint staging. No deps or inference."""
import hashlib, json, os, re, shutil, sys, time
from pathlib import Path
from urllib.error import HTTPError, URLError
from urllib.parse import urlsplit
from urllib.request import Request, build_opener, ProxyHandler, HTTPRedirectHandler

ROOT=Path('/mnt/inkling-ref')
BUFFER=4*1024**2
WEIGHT='model-00001-of-00001.safetensors'

class Deadline(Exception): pass
class Verification(Exception): pass
class ShortRead(Exception): pass

class Redirect(HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        if urlsplit(newurl).scheme!='https': raise Verification('non_https_redirect')
        emit('redirect',status=code,source=urlsplit(req.full_url).hostname,target=urlsplit(newurl).hostname)
        return super().redirect_request(req,fp,code,msg,headers,newurl)

OPENER=build_opener(ProxyHandler({}),Redirect())

def emit(kind, **extra):
    print(json.dumps(dict(kind=kind,utc_epoch=time.time(),**extra),separators=(',',':')),flush=True)

def check(deadline):
    if time.monotonic()>=deadline: raise Deadline()

def syncdir(p):
    fd=os.open(p,os.O_RDONLY|os.O_DIRECTORY)
    try: os.fsync(fd)
    finally: os.close(fd)

def publish(p,data):
    temp=p.with_suffix('.tmp')
    # This is an unpublished marker from a possibly interrupted write.
    with temp.open('w') as f:
        json.dump(data,f,indent=2,sort_keys=True); f.write('\n'); f.flush(); os.fsync(f.fileno())
    os.replace(temp,p); syncdir(p.parent)

def response_check(r,off,total):
    if r.headers.get('Content-Encoding','identity').lower()!='identity': raise Verification('encoded_body')
    if r.status==206:
        match=re.fullmatch(r'bytes (\d+)-(\d+)/(\d+)',r.headers.get('Content-Range',''))
        if not match or tuple(map(int,match.groups()))!=(off,total-1,total): raise Verification('content_range')
    elif r.status!=200 or off: raise Verification('resume_requires_206')
    n=r.headers.get('Content-Length')
    if n is not None and n!=str(total-off): raise Verification('content_length')

def digest(part,row,deadline):
    total=row['size']; a=hashlib.sha256(); b=hashlib.sha1(f'blob {total}\0'.encode()) if row.get('git_blob_sha1') else None
    if not row.get('sha256') and not b: raise Verification('missing_publisher_pin')
    if part.stat().st_size!=total: raise Verification('disk_size')
    with part.open('rb') as f:
        while data:=f.read(BUFFER):
            check(deadline); a.update(data)
            if b: b.update(data)
    if row.get('sha256') and a.hexdigest()!=row['sha256']: raise Verification('sha256')
    if b and b.hexdigest()!=row['git_blob_sha1']: raise Verification('git_blob_sha1')
    return dict(path=row['path'],size=total,sha256=a.hexdigest(),identity='publisher_sha256' if not b else 'pinned_git_blob_sha1',**({'git_blob_sha1':b.hexdigest()} if b else {}))

def transfer(out, base, row, deadline):
    dst=out/row['path']; dst.parent.mkdir(exist_ok=True); part=dst.with_name(dst.name+'.part'); total=row['size']
    if dst.exists():
        result=digest(dst,row,deadline)
        emit('reused_verified',**result)
        return result
    last_report=0.0
    for k in range(14):
        check(deadline)
        off=part.stat().st_size if part.exists() else 0
        if off==total: break
        if off>total: raise Verification('part_oversize')
        h={'Accept-Encoding':'identity','User-Agent':'r54-finite-public-stage/1'}
        if off: h['Range']=f'bytes={off}-'
        try:
            with OPENER.open(Request(base+row['path'],headers=h),timeout=min(11,max(1,deadline-time.monotonic()))) as r:
                emit('http',file=row['path'],status=r.status,host=urlsplit(r.geturl()).hostname,offset=off,content_range=r.headers.get('Content-Range'))
                response_check(r,off,total)
                with part.open('ab',buffering=0) as f:
                    while off<total:
                        check(deadline)
                        data=r.read1(min(BUFFER,total-off))
                        if not data: raise ShortRead()
                        if f.write(data)!=len(data): raise Verification('short_disk_write')
                        off+=len(data)
                        if time.monotonic()-last_report>=10 or off==total:
                            last_report=time.monotonic(); emit('progress',file=row['path'],bytes_on_volume=off,expected=total)
                    if r.read(1): raise Verification('oversize_body')
                    os.fsync(f.fileno())
            break
        except HTTPError as e:
            emit('retry_http',file=row['path'],status=e.code,offset=off,host=urlsplit(e.url).hostname,attempt=k+1)
            if e.code not in (403,408,429,500,502,503,504): raise Verification(f'http_{e.code}') from None
        except (URLError,ConnectionError,TimeoutError,ShortRead) as e:
            emit('retry_stream',file=row['path'],error_type=type(e).__name__,offset=off,attempt=k+1)
        time.sleep(min(4,1+k, max(0,deadline-time.monotonic())))
    check(deadline)
    if not part.exists() or part.stat().st_size!=total: raise Verification('transfer_incomplete')
    # Re-read on-disk bytes, including bytes persisted by any prior transfer attempt.
    with part.open('r+b') as f: os.fsync(f.fileno())
    emit('verify_start',file=row['path'],bytes_on_volume=total)
    result=digest(part,row,deadline)
    if dst.exists() or dst.is_symlink(): raise Verification('published_file_appeared')
    os.replace(part,dst); syncdir(dst.parent)
    emit('verified',**result)
    return result

def bytes_remaining(out,rows):
    files={row['path']:row['size'] for row in rows}
    directories={str(parent) for name in files for parent in Path(name).parents if parent!=Path('.')}
    for path in out.rglob('*'):
        name=str(path.relative_to(out))
        if path.is_symlink():
            raise Verification('unexpected_symlink')
        if path.is_dir() and name in directories:
            continue
        if path.is_file() and (name in files or (name.endswith('.part') and name[:-5] in files) or name=='COMPLETE.tmp'):
            continue
        raise Verification('unexpected_checkpoint_entry')
    missing=0
    for name,size in files.items():
        dst=out/name
        part=dst.with_name(dst.name+'.part')
        if dst.exists():
            if part.exists() or dst.stat().st_size!=size:
                raise Verification('inconsistent_published_file')
        elif part.exists():
            have=part.stat().st_size
            if have>size:
                raise Verification('part_oversize')
            missing+=size-have
        else:
            missing+=size
    return missing

def stage(cfg, secs, volume_name, volume_id, log_name, mode):
    deadline=time.monotonic()+secs
    out=ROOT/cfg['revision']
    entries=list(ROOT.iterdir())
    if mode=='fresh':
        if {p.name for p in entries}!={log_name}: raise Verification('fresh_volume_not_empty')
    elif mode=='resume':
        for path in entries:
            if path.is_symlink() or not (
                (path==out and path.is_dir()) or
                (path.is_file() and re.fullmatch(r'stage(?:-[0-9a-f]{32})?\.jsonl',path.name))
            ):
                raise Verification('unexpected_volume_entry')
    else:
        raise Verification('unknown_staging_mode')
    out.mkdir(exist_ok=True)
    free=shutil.disk_usage(ROOT).free
    all_rows=cfg['files']+cfg['supplemental']
    expected=sum(x['size'] for x in all_rows)
    remaining=bytes_remaining(out,all_rows)
    emit('boot',free_bytes=free,expected=expected,remaining_bytes=remaining,deadline_s=secs,volume_name=volume_name,volume_id=volume_id)
    if free<remaining+128*1024**2: raise Verification('free_space')
    base=f"https://huggingface.co/{cfg['repo']}/resolve/{cfg['revision']}/"
    got={}
    for row in sorted(all_rows,key=lambda r:r['path']==WEIGHT):
        got[row['path']]=transfer(out,base,row,deadline)
        if row['path']=='model.safetensors.index.json':
            index=json.loads((out/row['path']).read_bytes()); names=set(index['weight_map'].values());
            if names!={WEIGHT}: raise Verification('safetensors_index_unexpected_shards')
            emit('index_verified',weight_shards=sorted(names),entries=len(index['weight_map']))
    if bytes_remaining(out,all_rows):
        raise Verification('transfer_incomplete')
    check(deadline)
    marker={k:cfg[k] for k in ('repo','revision','git_tree_evidence','explicitly_excluded','publisher_files_sha256')}
    marker.update(files=[got[x['path']] for x in cfg['files']], supplemental=[got[x['path']] for x in cfg['supplemental']], required_bytes=sum(x['size'] for x in cfg['files']), total_bytes=expected, volume_name=volume_name,volume_id=volume_id,mount=str(ROOT),path=str(out),verified_utc_epoch=time.time())
    publish(out/'COMPLETE.json',marker)
    emit('complete',size=(out/'COMPLETE.json').stat().st_size,sha256=hashlib.sha256((out/'COMPLETE.json').read_bytes()).hexdigest())

def main():
    manifest, limit, volume_name, volume_id, log_name, mode=sys.argv[1:]
    if sys.version_info[:2]!=(3,12) or not any(line.split()[4]==str(ROOT) for line in Path('/proc/self/mountinfo').read_text().splitlines()): raise Verification('cached_python_or_exact_mount_missing')
    stage(json.loads(Path(manifest).read_bytes()),min(int(limit),865),volume_name,volume_id,log_name,mode)

if __name__=='__main__':
    try: main()
    except BaseException as e:
        # Never emit outbound signed URLs or credential-containing exception text.
        emit('failure',error_type=type(e).__name__,reason=str(e) if isinstance(e,Verification) else None,errno=getattr(e,'errno',None)); raise SystemExit(1) from None
