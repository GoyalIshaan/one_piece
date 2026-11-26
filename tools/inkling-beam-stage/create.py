"""Single sandbox create; write exact handles before stdout is sent."""
import json, os, sys, time
from pathlib import Path
from beam import Sandbox, Image, Volume
from beam.client import settings
from beta9.channel import rpc_timeout
from beta9.config import set_settings, load_config

IMAGE='809ae21e5d81fd28'
TTL=900
MOUNT='/mnt/inkling-ref'

def main():
    out=Path(sys.argv[1]); name=sys.argv[2]; vid=sys.argv[3]
    set_settings(settings)
    ctx=load_config()['default']
    assert ctx.token and vid and name.startswith('r54-inkling-')
    def persist(file, value):
        with (out/file).open('x') as f:
            json.dump({**value,'utc_epoch':time.time()},f); f.write('\n'); f.flush(); os.fsync(f.fileno())
    class RecordedSandbox(Sandbox):
        def _get_or_create_stub(self, req):
            assert req.keep_warm_seconds==TTL and req.image_id==IMAGE
            assert req.cpu==2000 and req.memory==8192 and not req.gpu and not req.gpu_count
            assert len(req.volumes)==1 and req.volumes[0].id==vid and req.volumes[0].mount_path==MOUNT
            r=super()._get_or_create_stub(req)
            if r.ok: persist('stub.json',{'stub_id':r.stub_id,'volume_id':vid})
            return r
        def _print_submission(self, cid):
            persist('sandbox.json',{'container_id':cid,'stub_id':self.stub_id,'volume_id':vid})
            super()._print_submission(cid)
    v=Volume(name=name,mount_path=MOUNT)
    # Bind the exact ID provided by verified volume create/list. No second create.
    v.volume_id=vid; v.ready=True
    s=RecordedSandbox(image=Image.from_id(IMAGE),name=name+'-cpu',gpu='',gpu_count=0,cpu=2.0,memory='8Gi',keep_warm_seconds=TTL,authorized=False,ports=[],sync_local_dir=False,secrets=[],volumes=[v],env={},context=ctx)
    with rpc_timeout(48):
        persist('sandbox-intent.json',{'name':name+'-cpu','volume_id':vid,'image':IMAGE,'ttl_s':TTL,'cpu_millicore':2000,'memory_mib':8192,'gpu_count':0,'mount':MOUNT})
        i=s.create()
        assert i.ok and i.container_id

if __name__=='__main__': main()
