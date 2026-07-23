#!/usr/bin/env python3
import re

with open('server.js', 'r') as f:
    content = f.read()

# Find the traversal encoding section  
start = content.find('// Directory traversal encoding bypass detection (URL-encoded, double-encoded, unicode)')
if start == -1:
    print("Section not found")
    exit(1)

# Find the end of this section (next top-level blank line + command injection)
rest = content[start:]
lines = rest.split('\n')

# Find end of section
end_idx = 0
for i, line in enumerate(lines):
    if i > 0 and line.strip() == '' and i + 1 < len(lines):
        trimmed = lines[i+1].strip()
        if '// Command injection prevention' in trimmed:
            end_idx = i
            break

if end_idx == 0:
    # Find via text search
    for i, line in enumerate(lines):
        if '// Command injection prevention' in line:
            end_idx = i
            break

replacement = """// Directory traversal encoding bypass detection (URL-encoded, double-encoded, unicode)
  // Decode URL-encoded paths to detect hidden traversal attacks
  const decodedPath = (() => { try { return decodeURIComponent(repoPath); } catch { return repoPath; } })();
  const doubleDecoded = (() => { try { return decodeURIComponent(decodedPath); } catch { return decodedPath; } })();

  // Check all decoded forms for path traversal patterns
  for (const decoded of [repoPath, decodedPath, doubleDecoded]) {
    if (typeof decoded !== 'string') continue;
    // Check for ../ or ..\\ patterns in any form
    if (/\.\.(\/|\\)/.test(decoded)) {
      return res.status(400).json({ error: 'Invalid repoPath: path traversal encoding detected' });
    }
    // Block paths starting with .. (relative escape attempts)
    if (decoded.startsWith('..')) {
      return res.status(400).json({ error: 'Invalid repoPath: path traversal detected' });
    }
  }

"""

# Build result
new_content = content[:start] + replacement + '\n'.join(lines[end_idx:])

with open('server.js', 'w') as f:
    f.write(new_content)

print(f'Replaced section from position {start} through end of traversal block')
