# Builds the page script that the installer embeds as script.js: core.js (wrapped, exports kept as CT.*) + script.js.
# The page script is inlined into layout.html as one module, so it can't import core.js.
import re
core = open('files/core.js', encoding='utf-8').read()
names = re.findall(r'^export const (\w+)', core, re.M)
body = re.sub(r'^export const ', 'const ', core, flags=re.M)
page = open('files/script.js', encoding='utf-8').read()
out = 'const CT = (() => {\n' + body + '\nreturn { ' + ', '.join(names) + ' };\n})();\n' + page
open('files/ct-page.js', 'w', encoding='utf-8').write(out)
print('ct-page.js', len(out), 'chars;', len(names), 'core exports')
