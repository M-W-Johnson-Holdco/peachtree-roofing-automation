import os

base = r'C:\Users\kliss\Desktop\CLaude Code\peachtree-roofing-automation'

# Read source files
with open(os.path.join(base, 'index.template.html'), encoding='utf-8') as f:
    lines = f.readlines()

print(f"Total lines in index.template.html: {len(lines)}")

# The template is already fully assembled (no separate part files for Peachtree).
# This script is a placeholder for future use if sections are split out.
# If you add a separate work order or upgrades app, update the paths below.

# Optional: read separate component files if they exist
workorder_path = os.path.join(base, 'Peachtree_Work_Order.html')
upgrades_path  = os.path.join(base, 'peachtree_upgrades_app.html')

if os.path.exists(workorder_path):
    with open(workorder_path, encoding='utf-8-sig') as f:
        workorder_html = f.read()
    print(f"Work order size: {len(workorder_html)} chars")
else:
    print("No separate work order file found — using embedded version in template.")
    workorder_html = None

if os.path.exists(upgrades_path):
    with open(upgrades_path, encoding='utf-8') as f:
        upgrades_html = f.read()
    print(f"Upgrades app size: {len(upgrades_html)} chars")
else:
    print("No separate upgrades app file found — using embedded version in template.")
    upgrades_html = None

def escape_srcdoc(html):
    # Must replace & first, then "
    html = html.replace('&', '&amp;')
    html = html.replace('"', '&quot;')
    return html

# Extract parts A and B (lines 0-407 and 764+ are the non-dynamic sections)
# Adjust these line numbers if the template structure changes.
part_a = ''.join(lines[0:408])
part_b = ''.join(lines[764:])

print(f"Part A size: {len(part_a)} chars")
print(f"Part B size: {len(part_b)} chars")

# Build commissions section
if upgrades_html:
    auto_bypass = (
        "document.addEventListener('DOMContentLoaded', function(){"
        " var auth=document.getElementById('s-auth');"
        " var app=document.getElementById('s-app');"
        " if(auth){auth.style.display='none';auth.classList.remove('on');}"
        " if(app){app.style.display='flex';app.classList.add('on');}"
        " var bnav=document.getElementById('bnav');"
        " if(bnav){bnav.style.display='flex';}"
        " });"
    )
    last_script = upgrades_html.rfind('<script')
    if last_script != -1:
        tag_end = upgrades_html.find('>', last_script) + 1
        upgrades_modified = upgrades_html[:tag_end] + '\n' + auto_bypass + '\n' + upgrades_html[tag_end:]
    else:
        upgrades_modified = upgrades_html.replace('</body>', f'<script>\n{auto_bypass}\n</script>\n</body>')
    escaped_upgrades = escape_srcdoc(upgrades_modified)
    commissions_section = (
        '  <div class="section" id="tab-commissions">\n'
        f'    <iframe id="comm-iframe" style="width:100%;height:calc(100vh - 120px);border:none;border-radius:8px;" srcdoc="{escaped_upgrades}"></iframe>\n'
        '  </div>'
    )
    print(f"Commissions section size: {len(commissions_section)} chars")
else:
    # Keep the existing embedded commissions section (lines 413-576 approx)
    commissions_section = ''.join(lines[413:577]).rstrip()

# Build logs section
logs_section = '''\
  <div class="section" id="tab-logs">
    <div class="card">
      <h2>Run Logs</h2>
      <div class="btn-row" style="margin-bottom:12px;">
        <button class="btn btn-secondary btn-sm" id="clear-log-btn">&#128465; Clear Logs</button>
      </div>
      <div class="log-box" id="log-box" style="margin-bottom:12px;"></div>
      <div class="log-box" id="log-box-2"></div>
    </div>
  </div>'''

# Build work order section
if workorder_html:
    escaped_workorder = escape_srcdoc(workorder_html)
    workorder_section = (
        '  <div class="section" id="tab-workorder">\n'
        f'    <iframe id="wo-iframe" style="width:100%;height:calc(100vh - 120px);border:none;background:#fff;" srcdoc="{escaped_workorder}"></iframe>\n'
        '  </div>'
    )
    print(f"Work order section size: {len(workorder_section)} chars")
else:
    # Keep the existing embedded work order section
    workorder_section = ''.join(lines[577:764]).rstrip()

# PTO section
pto_section = '''\
  <div class="section" id="tab-pto">
    <div class="card">
      <h2>PTO Tracker</h2>
      <p style="color:#64748b;font-size:0.85rem;">Coming soon.</p>
    </div>
  </div>'''

# Smart Scheduler section
smartsched_section = '''\
  <div class="section" id="tab-smartsched">
    <div class="card">
      <h2>Smart Home Scheduler</h2>
      <p style="color:#64748b;font-size:0.85rem;">Coming soon.</p>
    </div>
  </div>'''

# Assemble (only used when rebuilding from separate component files)
if upgrades_html or workorder_html:
    output = (
        part_a +
        '\n\n' +
        commissions_section +
        '\n\n' +
        logs_section +
        '\n\n' +
        workorder_section +
        '\n\n' +
        pto_section +
        '\n\n' +
        smartsched_section +
        '\n\n  </div>\n\n' +
        part_b
    )
    print(f"Total output size: {len(output)} chars")
    out_path = os.path.join(base, 'index.template.html')
    with open(out_path, 'w', encoding='utf-8') as f:
        f.write(output)
    print(f"Written to {out_path}")
else:
    print("Template is already fully assembled — nothing to rebuild.")
    print("To rebuild with new components, add Peachtree_Work_Order.html or peachtree_upgrades_app.html to this directory.")

print("Done!")
