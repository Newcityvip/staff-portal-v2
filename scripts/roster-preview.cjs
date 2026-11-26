const http = require('node:http');
const path = require('node:path');
const fs = require('node:fs/promises');

const root = path.resolve(__dirname, '..');
const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml' };
const assets = new Set([
  'admin-roster.html', 'css/admin-roster.css', 'assets/logo.svg', 'assets/favicon.svg',
  'js/admin-roster.js', 'js/roster-model.js', 'js/roster-generator.js', 'js/roster-export.js',
  'vendor/exceljs-4.4.0/dist/exceljs.min.js'
]);

function startPreview(port = 8765) {
  const server = http.createServer(async (req, res) => {
    try {
      const file = new URL(req.url, 'http://localhost').pathname.replace(/^\/(?:staff-portal-v2\/)?/, '');
      if (req.method !== 'GET' || !assets.has(file)) return res.writeHead(404).end();
      const body = await fs.readFile(path.join(root, file));
      res.writeHead(200, { 'Content-Type': types[path.extname(file)], 'Cache-Control': 'no-store' });
      res.end(body);
    } catch { res.writeHead(404).end(); }
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => resolve(server));
  });
}

if (require.main === module) {
  startPreview(process.argv[2] ? Number(process.argv[2]) : 8765)
    .then(server => console.log('http://127.0.0.1:' + server.address().port + '/admin-roster.html'))
    .catch(error => { console.error(error.message); process.exitCode = 1; });
}
module.exports = { startPreview };
