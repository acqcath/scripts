import sys
rules=[l.strip() for l in open(sys.argv[1],encoding='utf-8') if l.strip() and not l.startswith('//') and '.' in l.strip()]
t={}
for r in rules:
    n=t
    for p in reversed(r.split('.')): n=n.setdefault(p,{})
    n['$']=1
def enc(n):
    ks=sorted(k for k in n if k!='$')
    out=[]
    for k in ks:
        c=n[k]; sub=[x for x in c if x!='$']
        s=k+('!' if '$' in c and sub else '')
        if sub: s+='('+enc(c)+')'
        out.append(s)
    return ','.join(out)
s=enc(t); open(sys.argv[2],'w').write(s); print(len(s.encode()))
