const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const dependencies = Object.keys(require('../package.json').dependencies);
const chunks = ['Metro Designer — Open-source notices\nGenerated from installed dependencies.\n'];
for (const name of dependencies) {
  const dir = path.join(root, 'node_modules', name);
  const pkg = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'));
  chunks.push(`\n========== ${name} ${pkg.version} (${pkg.license || 'see notices'}) ==========\n`);
  for (const file of fs.readdirSync(dir).filter(file => /^licen[cs]e(?:\.|$)/i.test(file))) {
    const target = path.join(dir, file);
    if (fs.statSync(target).isFile()) chunks.push(fs.readFileSync(target, 'utf8'));
  }
}
const buildDir = path.join(root, 'build/static/js');
if (fs.existsSync(buildDir)) for (const file of fs.readdirSync(buildDir).filter(file => file.endsWith('.LICENSE.txt'))) {
  chunks.push(`\n========== Bundled dependency notices: ${file} ==========\n`, fs.readFileSync(path.join(buildDir, file), 'utf8'));
}
chunks.push('\nWindows client: Electron — https://www.electronjs.org/docs/latest/tutorial/acknowledgements\nAndroid client: AndroidX WebKit — Apache License 2.0, https://www.apache.org/licenses/LICENSE-2.0\n');
fs.writeFileSync(path.join(root, 'public/open-source-notices.txt'), chunks.join('\n').replace(/[ \t]+$/gm, ''));
console.log('Wrote public/open-source-notices.txt');
