# Builds the page script that the installer embeds as script.js: core.js (wrapped, exports kept as CT.*) + script.js.
# The page script is inlined into layout.html as one module, so it can't import core.js.
import re, os
VERSION = os.environ.get('CT_VERSION', 'v50-preview')
# answers.js (local answer card) shares core's scope: both become CT.*
core = open('files/core.js', encoding='utf-8').read() + '\n' + open('files/answers.js', encoding='utf-8').read()
names = re.findall(r'^export const (\w+)', core, re.M)
body = re.sub(r'^export const ', 'const ', core, flags=re.M)
page = open('files/script.js', encoding='utf-8').read()
out = f'// clean-titles {VERSION}\n' + 'const CT = (() => {\n' + body + '\nreturn { ' + ', '.join(names) + ' };\n})();\n' + page
open('files/ct-page.js', 'w', encoding='utf-8').write(out)
print('ct-page.js', len(out), 'chars;', len(names), 'core exports')
