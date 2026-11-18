"""The view is vanilla source: validation is the build, web/ is its dist."""
from pathlib import Path
root = Path(__file__).resolve().parent.parent
for name in ('index.html', 'boot.js', 'wizard-tokens.css', 'wizard-ui.css', 'wizard-sheet.js', 'standalone.css', 'styles.css', 'app.js', 'device.js', 'device-worker.js'):
    assert (root / 'web' / name).is_file(), name
html = (root / 'web/index.html').read_text()
assert '/wizard-os-home/core/app-client.js' in html, 'Shared system client must load before app code'
assert html.index('/wizard-os-home/core/app-client.js') < html.index('app.js'), 'Shared client load order'
print('View built: web/ (vanilla source, no dependencies)')
import importlib.util
spec = importlib.util.spec_from_file_location('build_worker', root / 'tools/build_worker.py')
bw = importlib.util.module_from_spec(spec); spec.loader.exec_module(bw)
assert (root / 'web/device-worker.js').read_text() == bw.build(), 'web/device-worker.js is stale: run python3 tools/build_worker.py'
