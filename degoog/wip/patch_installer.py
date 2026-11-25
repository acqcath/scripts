# Releases a new version on top of the installer that is already on main (the v49 skeleton that build_installer.py pins
# is no longer in the repo's history): replaces the body of every embedded file with its source in files/, sets the
# version, writes ../install.ps1, then checks that every embedded file equals its source.
#   CT_VERSION=v51 python3 build.py && python3 patch_installer.py v51
import re, sys, hashlib
ver = sys.argv[1]
path = '../install.ps1'
out = open(path, encoding='utf-8').read()
old_ver = re.search(r'^// clean-titles (v\d+\S*)', out, re.M).group(1)
page = open('files/ct-page.js', encoding='utf-8').read()
assert page.startswith(f'// clean-titles {ver}\n'), 'run build.py with CT_VERSION first'
embeds = {  # target in installer -> source file
    '$t\\index.js': 'files/index.js', '$t\\script.js': 'files/ct-page.js', '$t\\names.js': 'files/names.js', '$t\\inline.js': 'files/inline.js',
    '$t\\custom.css': 'files/custom.css', '$t\\setcss.js': 'files/setcss.js', '$t\\aittl.js': 'files/aittl.js', '$t\\safeoff.js': 'files/safeoff.js',
    '$env:TEMP\\ct-check.js': 'files/ctcheck.js',
}
vision = {'$vd\\Dockerfile': 'files/vision/Dockerfile', '$vd\\app.py': 'files/vision/app.py', '$vd\\setup.sh': 'files/vision/setup.sh'}
def src(p): return open(p, encoding='utf-8').read()
for tgt, f in embeds.items():
    body = src(f)
    assert "\n'@" not in body and not body.startswith("'@"), f
    pat = re.compile(r'(\[IO\.File\]::WriteAllText\("' + re.escape(tgt) + r'", @\'\n).*?(\n\'@\))', re.S)
    assert len(pat.findall(out)) == 1, tgt
    out = pat.sub(lambda m: m.group(1) + body + m.group(2), out, count=1)
for tgt, f in vision.items():
    body = src(f)
    assert "\n'@" not in body and '\r' not in body, f
    pat = re.compile(r'(\[IO\.File\]::WriteAllText\("' + re.escape(tgt) + r'", \(@\'\n).*?(\n\'@\)\.Replace)', re.S)
    assert len(pat.findall(out)) == 1, tgt
    out = pat.sub(lambda m: m.group(1) + body + m.group(2), out, count=1)
vtag = hashlib.sha256(''.join(src(f'files/vision/{n}') for n in sorted(['Dockerfile', 'app.py', 'setup.sh'])).encode()).hexdigest()[:12]
out, n = re.subn(r'(\[IO\.File\]::WriteAllText\("\$vd\\tag", ")[0-9a-f]+("\))', lambda m: m.group(1) + vtag + m.group(2), out)
assert n == 1
out = out.replace(f'should be {old_ver})', f'should be {ver})')
open(path, 'w', encoding='utf-8', newline='\n').write(out)
# Round trip: every embedded file in the written installer equals its source
chk = open(path, encoding='utf-8').read()
for tgt, f in embeds.items():
    m = re.search(r'\[IO\.File\]::WriteAllText\("' + re.escape(tgt) + r'", @\'\n(.*?)\n\'@\)', chk, re.S)
    assert m and m.group(1) == src(f), 'round trip: ' + tgt
for tgt, f in vision.items():
    m = re.search(r'\[IO\.File\]::WriteAllText\("' + re.escape(tgt) + r'", \(@\'\n(.*?)\n\'@\)\.Replace', chk, re.S)
    assert m and m.group(1) == src(f), 'round trip: ' + tgt
print(f'{path}: {old_ver} -> {ver}, ct-vision tag {vtag}, {len(chk)} chars')
