import re,sys,os
src=open('/home/claude/scripts/degoog/install.ps1',encoding='utf-8').read()
pat=re.compile(r'\[IO\.File\]::WriteAllText\("\$t\\([^"]+)", @\'\n(.*?)\n\'@\)',re.S)
os.makedirs('files',exist_ok=True)
for m in pat.finditer(src):
    open('files/'+m.group(1),'w',encoding='utf-8').write(m.group(2)); print(m.group(1),len(m.group(2)))
