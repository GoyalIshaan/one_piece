import json
from beam.client import settings
from beta9.config import set_settings
set_settings(settings)

from beta9.mcp.server import RemoteMCP,context_or_none
remote=RemoteMCP(context_or_none('default'))
for i,(method, params) in enumerate([('tools/call', {'name':'whoami','arguments':{}})]):
 code,d=remote.call(dict(jsonrpc='2.0',id=i,method=method,params=params))
 r=d.get('result',{}) if isinstance(d,dict) else {}
 texts=[]
 for a in r.get('content',[]):
  try: texts.append(json.loads(a.get('text','')))
  except ValueError: pass
 sub=r.get('structuredContent') or (texts[0] if texts else {})
 print(json.dumps({'http':code,'error':d.get('error',{}).get('code') if isinstance(d,dict) else None,'sub':{k:v for k,v in sub.items() if any(t in k.lower() for t in ('ok','balance','cent','credit')) and not isinstance(v,list)},'shape':sorted(sub)},indent=2))
