# Builds an installer from main's install.ps1 skeleton with the v50 files from files/ (run build.py first).
#   python3 build_installer.py preview  -> install-preview.ps1 (prints "clean-titles v50-preview")
#   python3 build_installer.py release  -> ../install.ps1 on this branch (v50); only at READY TO SHIP
import re, sys, subprocess
mode = sys.argv[1] if len(sys.argv) > 1 else 'preview'
ver = 'v50-preview' if mode == 'preview' else 'v50'
src = subprocess.run(['git', 'show', 'main:degoog/install.ps1'], capture_output=True, text=True, check=True).stdout
page = open('files/ct-page.js', encoding='utf-8').read()
page = re.sub(r'^// clean-titles \S+', f'// clean-titles {ver}', page, count=1)
files = {n: open(f'files/{n}', encoding='utf-8').read() for n in ['index.js', 'names.js', 'inline.js', 'custom.css', 'setcss.js']}
files['script.js'] = page
psl = open('psl.enc', encoding='utf-8').read().strip()
for name, body in list(files.items()) + [('psl.enc', psl)]:
    assert "\n'@" not in body and not body.startswith("'@"), name  # would end the PowerShell here-string early
def put(m):
    n = m.group(1)
    return f'[IO.File]::WriteAllText("$t\\{n}", @\'\n' + files.pop(n) + "\n'@)"
out = re.sub(r'\[IO\.File\]::WriteAllText\("\$t\\([^"]+)", @\'\n.*?\n\'@\)', put, src, flags=re.S)
assert not files, f'not placed: {list(files)}'
# The public suffix list rides along to the inline step
old = 'docker cp "$t\\script.js" "${c}:/tmp/ct.js"; docker cp "$t\\inline.js" "${c}:/tmp/inline.js"\ndocker exec -u 0 $c bun /tmp/inline.js; docker exec -u 0 $c rm -f /tmp/ct.js /tmp/inline.js'
assert old in out, 'inline step changed on main'
new = ('[IO.File]::WriteAllText("$t\\psl.enc", @\'\n' + psl + "\n'@)\n"
       'docker cp "$t\\script.js" "${c}:/tmp/ct.js"; docker cp "$t\\inline.js" "${c}:/tmp/inline.js"; docker cp "$t\\psl.enc" "${c}:/tmp/psl.enc"\n'
       'docker exec -u 0 $c bun /tmp/inline.js; docker exec -u 0 $c rm -f /tmp/ct.js /tmp/inline.js /tmp/psl.enc')
out = out.replace(old, new)
old = '"plugin code inside the page (should be v49): " + (docker exec $c grep -o \'clean-titles v[0-9]*\' /app/src/public/themes/degoog-theme/layout.html)'
assert old in out, 'version check changed on main'
out = out.replace(old, f'"plugin code inside the page (should be {ver}): " + (docker exec $c grep -o -m1 \'clean-titles v[0-9a-z-]*\' /app/src/public/themes/degoog-theme/layout.html | Select-Object -First 1)\n'
                  '"public suffix file (should be a psl file): " + (docker exec $c sh -c \'ls /app/src/public/ct/\')\n'
                  '"progressive results off (should be False): $($ss.settings.streamingEnabled -eq $true)"')
target = 'install-preview.ps1' if mode == 'preview' else '../install.ps1'
open(target, 'w', encoding='utf-8', newline='\n').write(out)
print(target, len(out), 'chars,', ver)
