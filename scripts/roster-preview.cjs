const http = require('node:http');
const path = require('node:path');
const fs = require('node:fs/promises');
const { networkInterfaces } = require('node:os');

const root = path.resolve(__dirname, '..');
const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml' };
const assets = new Set([
  'admin-roster.html', 'css/admin-roster.css', 'assets/logo.svg', 'assets/favicon.svg',
  'js/admin-roster.js', 'js/roster-model.js', 'js/roster-generator.js', 'js/roster-policy.js', 'js/roster-export.js',
  'js/roster-weekly.js', 'js/roster-optimize.js', 'js/roster-diagnostic-bundle.js',
  'vendor/exceljs-4.4.0/dist/exceljs.min.js'
]);

function startPreview(port = 8765, host = '127.0.0.1') {
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
    server.listen(port, host, () => resolve(server));
  });
}

function previewOptions(args, interfaces = networkInterfaces()) {
  const lan = args[0] === '--lan';
  const host = lan ? args[1] : '127.0.0.1';
  const portArg = lan ? args[2] : args[0];
  const port = portArg === undefined ? 8765 : Number(portArg);
  const privateIpv4 = /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/;
  const addresses = Object.values(interfaces).flat().filter(n => n.family === 'IPv4' && !n.internal && privateIpv4.test(n.address)).map(n => n.address);
  if (lan && !addresses.includes(host)) throw new Error('Specify a private IPv4 address on this PC: --lan <address> [port]. Available: ' + addresses.join(', '));
  if (!Number.isInteger(port) || port < 1 || port > 65535 || args.length > (lan ? 3 : 1)) throw new Error('Invalid port or arguments');
  return { lan, host, port };
}

if (require.main === module) {
  Promise.resolve().then(async () => {
    const { lan, host, port } = previewOptions(process.argv.slice(2));
    const server = await startPreview(port, host);
    console.log('http://' + host + ':' + server.address().port + '/admin-roster.html');
    if (lan) {
      console.log('Synthetic data only. Use the same trusted Wi-Fi and stop with Ctrl+C; LAN preview expires in 30 minutes.');
      setTimeout(() => { server.close(); server.closeAllConnections(); }, 30 * 60 * 1000).unref();
    }
  }).catch(error => { console.error(error.message); process.exitCode = 1; });
}
module.exports = { startPreview, previewOptions };
