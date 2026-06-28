import os

file_path = r'.\gui_src\src\components\StatusBar.jsx'
with open(file_path, 'r', encoding='utf-8') as f:
    content = f.read()

bad_str_1 = "\\`https://opalacoder.com/?license=\\${licenseData.key}#products\\`"
bad_str_2 = "\\`https://opalacoder.com/?license=\\${licenseData.key}#products\\`"
good_str = "`https://opalacoder.com/?license=${licenseData.key}#products`"

content = content.replace(bad_str_1, good_str).replace(bad_str_2, good_str)

with open(file_path, 'w', encoding='utf-8') as f:
    f.write(content)

print("Fixed StatusBar.jsx")
