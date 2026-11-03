import httpx

r = httpx.get('https://nb557.github.io/plugins/online_mod.js', timeout=10)
lines = r.text.split('\n')
for j in range(670, 730):
    print(f'[{j}] {lines[j]}')
