import os
import re
import sys

emoji_pattern = re.compile(
    "["
    "\U0001F600-\U0001F64F"  # emoticons
    "\U0001F300-\U0001F5FF"  # symbols & pictographs
    "\U0001F680-\U0001F6FF"  # transport & map
    "\U0001F1E0-\U0001F1FF"  # flags (iOS)
    "\U00002702-\U000027B0"
    "\U000024C2-\U0001F251"
    "\U0001F900-\U0001F9FF"  # supplemental symbols
    "\U0001FA70-\U0001FAFF"
    "]+",
    flags=re.UNICODE
)

dirs_to_scan = [
    os.path.abspath(os.path.join(os.path.dirname(__file__), '../../client/src')),
    os.path.abspath(os.path.join(os.path.dirname(__file__), '../src')),
    '/mazideveloper/client/src',
    '/mazideveloper/server/src'
]

found = 0
scanned_dirs = set()
for d in dirs_to_scan:
    if os.path.exists(d) and d not in scanned_dirs:
        scanned_dirs.add(d)
        print(f"Scanning directory: {d}")
        for root, _, files in os.walk(d):
            for f in files:
                if not f.endswith(('.ts', '.tsx', '.js', '.css', '.html', '.json')):
                    continue
                p = os.path.join(root, f)
                with open(p, 'r', encoding='utf-8', errors='ignore') as fp:
                    content = fp.read()
                    matches = emoji_pattern.findall(content)
                    if matches:
                        print(f"[!] Emoji found in {p}: {matches}")
                        found += len(matches)

if found == 0:
    print("[SUCCESS] ZERO EMOJIS CONFIRMED across all client and server files!")
else:
    print(f"[FAILURE] Found {found} emojis!")

sys.exit(1 if found > 0 else 0)
