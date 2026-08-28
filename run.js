const spawn = require('child_process').spawn;
const clc = require('./vendor/nodejs/node_modules/cli-color');
const TorControl = require('./vendor/nodejs/node_modules/tor-control');

const stdin = process.stdin;
stdin.setRawMode(true);
stdin.resume();
stdin.setEncoding('utf8');

let torProcess = null;
let currentExitIp = null;
let statusPollTimer = null;

// ── Layout constants ─────────────────────────────────────────────────────────

const W = 62; // total width including side borders
const INNER = W - 2; // width between │ chars

// ── Box drawing primitives ───────────────────────────────────────────────────

function line(ch) {
  return clc.white(' ' + ch.repeat(W));
}

function row(content) {
  const visible = clc.strip(content);
  const pad = Math.max(0, INNER - visible.length);
  return clc.white('│') + content + ' '.repeat(pad) + clc.white('│');
}

function rowCenter(content) {
  const visible = clc.strip(content);
  const totalPad = Math.max(0, INNER - visible.length);
  const left = Math.floor(totalPad / 2);
  const right = totalPad - left;
  return clc.white('│') + ' '.repeat(left) + content + ' '.repeat(right) + clc.white('│');
}

function topBorder() {
  return clc.white(' ┌' + '─'.repeat(INNER) + '┐');
}

function bottomBorder() {
  return clc.white(' └' + '─'.repeat(INNER) + '┘');
}

function divider() {
  return clc.white(' ├' + '─'.repeat(INNER) + '┤');
}

function emptyRow() {
  return row('');
}

function blank() {
  console.log();
}

// ── Section header ───────────────────────────────────────────────────────────

function sectionHeader(title) {
  const tag = `  ${title}  `;
  const innerW = INNER;
  const tagVisible = tag.length;
  const remain = Math.max(0, innerW - tagVisible);
  const left = Math.floor(remain / 2);
  const right = remain - left;
  console.log();
  console.log(clc.white(' ┌') + '─'.repeat(left) + clc.cyanBright(tag) + '─'.repeat(right) + clc.white('┐'));
}

function sectionFooter() {
  console.log(clc.white(' └' + '─'.repeat(INNER) + '┘'));
  console.log();
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function torControl(action, callback) {
  const control = new TorControl();
  const method = `signal${action.charAt(0).toUpperCase() + action.slice(1)}`;
  control[method](function (error, status) {
    if (error) {
      console.log();
      console.log(row('  ' + clc.redBright(`✕ error: ${error}`)));
      sectionFooter();
    } else {
      console.log();
      console.log(row('  ' + clc.greenBright(`✓ ${status.messages[0]}`)));
      sectionFooter();
    }
    if (callback) callback(error);
  });
}

function statusText() {
  const state = torProcess ? clc.greenBright('● RUNNING') : clc.redBright('○ STOPPED');
  const ip = currentExitIp ? clc.white(`Exit IP: ${clc.cyanBright(currentExitIp)}`) : clc.blackBright('Exit IP: ---');
  return `Tor: ${state}    │    ${ip}`;
}

function refreshStatus() {
  // Overwrite the status line in place
  process.stdout.write('\r\x1b[K');
  process.stdout.write(' ' + clc.bgColor(233, 233, 233).blackBright(' ' + statusText() + ' '));
  process.stdout.write('\r');
}

// ── Banner ───────────────────────────────────────────────────────────────────

function showBanner() {
  console.log();
  console.log(clc.white(' ┌' + '─'.repeat(INNER) + '┐'));
  console.log(rowCenter(clc.cyanBright.bold('████████╗')));
  console.log(rowCenter(clc.cyanBright.bold('╚══██╔══╝') + clc.white('   T O R   C O N T R O L L E R')));
  console.log(rowCenter(clc.cyanBright.bold('   ██║   ') + clc.white('   ─────────────────────────────')));
  console.log(rowCenter(clc.cyanBright.bold('   ██║   ') + clc.blackBright('   v1.0  •  node + tor')));
  console.log(rowCenter(clc.cyanBright.bold('   ╚═╝   ')));
  console.log(divider());
  console.log(row('  ' + statusText()));
  console.log(clc.white(' └' + '─'.repeat(INNER) + '┘'));
}

// ── Menu ─────────────────────────────────────────────────────────────────────

function showMenu() {
  blank();
  console.log(topBorder());
  console.log(rowCenter(clc.white.bold('M A I N   M E N U')));
  console.log(divider());

  const items = [
    { key: '1', label: 'Start TOR connection',  color: clc.greenBright,   icon: '▶' },
    { key: '2', label: 'Log connection info',    color: clc.blueBright,    icon: '📋' },
    { key: '3', label: 'Stop TOR connection',    color: clc.redBright,     icon: '■' },
    { key: '4', label: 'Debug TOR connection',   color: clc.yellowBright,  icon: '🔍' },
    { key: '5', label: 'New TOR identity',       color: clc.magentaBright, icon: '↻' },
    { key: '6', label: 'Restart TOR connection', color: clc.blueBright,    icon: '↻' },
    { key: '7', label: 'Show exit IP',           color: clc.cyanBright,    icon: '🌍' },
    { key: '8', label: 'Show circuit path',      color: clc.cyanBright,    icon: '◈' },
    { key: '9', label: 'Network stats',          color: clc.yellowBright,  icon: '📊' },
  ];

  items.forEach((item) => {
    const key = clc.white.bold(` [${item.key}] `);
    const icon = ` ${item.icon} `;
    const label = item.color(item.label);
    console.log(row(`  ${key}${icon}${label}`));
  });

  console.log(divider());
  console.log(row('  ' + clc.blackBright(' Press a key (1-9) or ' + clc.white.bold('Q') + ' to quit')));
  console.log(bottomBorder());
  blank();
}

// ── SOCKS5 helper ────────────────────────────────────────────────────────────

const SOCKS_HOST = '127.0.0.1';
const SOCKS_PORT = 9050;

function httpGetThroughSocks(host, path, callback) {
  const net = require('net');
  const socket = net.connect(SOCKS_PORT, SOCKS_HOST, () => {
    socket.write(Buffer.from([0x05, 0x01, 0x00]));
  });

  let step = 0;
  const hostBuf = Buffer.from(host);
  const portBuf = Buffer.alloc(2);
  portBuf.writeUInt16BE(80);

  const connectReq = Buffer.concat([
    Buffer.from([0x05, 0x01, 0x00, 0x03, hostBuf.length]),
    hostBuf,
    portBuf,
  ]);

  let bodyBuf = '';

  socket.on('data', (data) => {
    if (step === 0) {
      step = 1;
      socket.write(connectReq);
    } else if (step === 1) {
      if (data[1] !== 0x00) {
        socket.destroy();
        return callback(new Error(`SOCKS5 CONNECT failed: 0x${data[1].toString(16)}`));
      }
      step = 2;
      socket.write(`GET ${path} HTTP/1.1\r\nHost: ${host}\r\nConnection: close\r\n\r\n`);
    } else {
      bodyBuf += data.toString();
      const parts = bodyBuf.split('\r\n\r\n');
      if (parts.length >= 2) {
        socket.destroy();
        return callback(null, parts[1]);
      }
    }
  });

  socket.on('error', (err) => callback(err));
  socket.setTimeout(10000, () => {
    socket.destroy();
    callback(new Error('Connection timed out'));
  });
}

// ── Actions ──────────────────────────────────────────────────────────────────

function startTor() {
  blank();
  console.log(topBorder());
  console.log(rowCenter(clc.greenBright.bold('▶  S T A R T   T O R')));
  console.log(divider());

  torProcess = spawn('./vendor/tor-bundle/tor.exe', ['-f', 'torrc']);

  torProcess.on('exit', (code) => {
    console.log();
    console.log(row('  ' + clc.yellow(`Tor exited with code ${code}`)));
    torProcess = null;
    currentExitIp = null;
    sectionFooter();
    showMenu();
  });

  torProcess.stdout.on('data', (data) => {
    const msg = data.toString();
    if (msg.indexOf('100%:') !== -1) {
      console.log();
      console.log(row('  ' + clc.greenBright.bold('✓ Tor connected successfully!')));
      sectionFooter();
      fetchExitIp(() => showMenu());
    } else {
      // Stream connect progress quietly
      if (msg.indexOf('[notice]') !== -1 || msg.indexOf('[warn]') !== -1) {
        console.log(row('  ' + clc.blackBright(msg.trim())));
      }
    }
  });

  torProcess.stderr.on('data', (data) => {
    console.log(row('  ' + clc.redBright(data.toString().trim())));
  });
}

function stopTor() {
  blank();
  console.log(topBorder());
  console.log(rowCenter(clc.redBright.bold('■  S T O P   T O R')));
  console.log(divider());
  if (!torProcess) {
    console.log(row('  ' + clc.yellow('No running Tor process found.')));
    sectionFooter();
    return showMenu();
  }
  torControl('halt', () => {
    torProcess = null;
    currentExitIp = null;
    showMenu();
  });
}

function restartTor() {
  blank();
  console.log(topBorder());
  console.log(rowCenter(clc.blueBright.bold('↻  R E S T A R T')));
  console.log(divider());
  if (torProcess) {
    torControl('halt', () => {
      torProcess = null;
      currentExitIp = null;
      startTor();
    });
  } else {
    startTor();
  }
}

function logInfo() {
  blank();
  console.log(topBorder());
  console.log(rowCenter(clc.blueBright.bold('📋  L O G   I N F O R M A T I O N')));
  console.log(divider());
  torControl('dump', () => showMenu());
}

function debugInfo() {
  blank();
  console.log(topBorder());
  console.log(rowCenter(clc.yellowBright.bold('🔍  D E B U G')));
  console.log(divider());
  torControl('debug', () => showMenu());
}

function newIdentity() {
  blank();
  console.log(topBorder());
  console.log(rowCenter(clc.magentaBright.bold('↻  N E W   I D E N T I T Y')));
  console.log(divider());
  torControl('newnym', () => showMenu());
}

function fetchExitIp(callback) {
  if (!torProcess) {
    currentExitIp = null;
    return callback ? callback() : null;
  }
  console.log(row('  ' + clc.white('Querying exit IP...')));
  httpGetThroughSocks('api.ipify.org', '/', (err, body) => {
    if (err) {
      currentExitIp = null;
      console.log(row('  ' + clc.redBright(`Failed to fetch IP: ${err.message}`)));
    } else {
      currentExitIp = body.trim();
      console.log(row('  ' + clc.greenBright(`Exit IP: ${currentExitIp}`)));
    }
    if (callback) callback();
  });
}

function showExitIp() {
  blank();
  console.log(topBorder());
  console.log(rowCenter(clc.cyanBright.bold('🌍  E X I T   I P')));
  console.log(divider());
  if (!torProcess) {
    console.log(row('  ' + clc.yellow('Tor is not running. Start it first.')));
    sectionFooter();
    return showMenu();
  }
  fetchExitIp(() => {
    sectionFooter();
    showMenu();
  });
}

function showCircuitPath() {
  blank();
  console.log(topBorder());
  console.log(rowCenter(clc.cyanBright.bold('◈  C I R C U I T   P A T H')));
  console.log(divider());
  if (!torProcess) {
    console.log(row('  ' + clc.yellow('Tor is not running. Start it first.')));
    sectionFooter();
    return showMenu();
  }
  const control = new TorControl();
  control.getInfo('circuit-status', (err, result) => {
    if (err) {
      console.log(row('  ' + clc.redBright(`Error: ${err}`)));
      sectionFooter();
      return showMenu();
    }
    const lines = result.messages.filter((m) => m.trim() !== '' && m.trim() !== 'OK');
    if (lines.length === 0) {
      console.log(row('  ' + clc.yellow('No active circuits found.')));
      sectionFooter();
      return showMenu();
    }
    lines.forEach((line) => {
      const parts = line.trim().split(' ');
      const id = parts[0];
      const state = parts[1];
      const pathRaw = parts.slice(2).join(' ');
      const purposeMatch = pathRaw.match(/PURPOSE=\S+/);
      const purpose = purposeMatch ? purposeMatch[0] : '';
      const path = pathRaw.split(' PURPOSE=')[0];
      const relays = path.split(',').map((r) => r.trim());

      console.log(row(`  ${clc.white.bold('Circuit')} ${clc.white('#' + id)} ${clc.greenBright('[' + state + ']')} ${clc.blackBright(purpose)}`));
      relays.forEach((relay, i) => {
        const role = i === 0 ? 'Entry' : i === relays.length - 1 ? 'Exit ' : `Hop ${i}`;
        const arrow = i === 0 ? '  ' : ' ↓ ';
        const roleColor = i === 0 ? clc.greenBright : i === relays.length - 1 ? clc.redBright : clc.yellowBright;
        console.log(row(`  ${clc.blackBright(arrow)}${roleColor(role + ':')} ${clc.white(relay)}`));
      });
      console.log(row(''));
    });
    sectionFooter();
    showMenu();
  });
}

// ── Dispatch ─────────────────────────────────────────────────────────────────

const actions = {
  '1': startTor,
  '2': logInfo,
  '3': stopTor,
  '4': debugInfo,
  '5': newIdentity,
  '6': restartTor,
  '7': showExitIp,
  '8': showCircuitPath,
  '9': showNetworkStats,
};

function formatBytes(bytes) {
  if (bytes === 0 || !bytes) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(1024));
  return (bytes / Math.pow(1024, i)).toFixed(2) + ' ' + units[i];
}

function formatUptime(seconds) {
  if (!seconds || seconds < 0) return '---';
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  const parts = [];
  if (d > 0) parts.push(`${d}d`);
  if (h > 0) parts.push(`${h}h`);
  if (m > 0) parts.push(`${m}m`);
  parts.push(`${s}s`);
  return parts.join(' ');
}

function showNetworkStats() {
  blank();
  console.log(topBorder());
  console.log(rowCenter(clc.yellowBright.bold('📊  N E T W O R K   S T A T S')));
  console.log(divider());
  if (!torProcess) {
    console.log(row('  ' + clc.yellow('Tor is not running. Start it first.')));
    sectionFooter();
    return showMenu();
  }
  const control = new TorControl();
  const keys = [
    'status/client/uptime',
    'traffic/read',
    'traffic/written',
    'bandwidth-rate',
    'bandwidth-burst',
    'network-liveness',
    'orconn-status',
    'circuit-status',
  ];
  control.getInfo(keys, (err, result) => {
    if (err) {
      console.log(row('  ' + clc.redBright(`Error: ${err}`)));
      sectionFooter();
      return showMenu();
    }
    // Parse key=value pairs from messages
    const info = {};
    result.messages.forEach((msg) => {
      const idx = msg.indexOf('=');
      if (idx !== -1) {
        info[msg.substring(0, idx)] = msg.substring(idx + 1);
      } else if (msg.trim() === 'OK' || msg.trim() === '') {
        // skip
      } else {
        // multi-line value like orconn-status or circuit-status
        const key = Object.keys(info).length;
        if (!info['_lines']) info['_lines'] = [];
        info['_lines'].push(msg);
      }
    });

    console.log(row(''));

    // Uptime
    const uptime = info['status/client/uptime'];
    console.log(row('  ' + clc.white.bold('⏱  Uptime:              ') + clc.cyanBright(formatUptime(parseInt(uptime, 10)))));

    // Bandwidth
    const bwRate = info['bandwidth-rate'];
    const bwBurst = info['bandwidth-burst'];
    console.log(row('  ' + clc.white.bold('📡  Bandwidth Rate:      ') + clc.cyanBright(formatBytes(parseInt(bwRate, 10)) + '/s')));
    console.log(row('  ' + clc.white.bold('📡  Bandwidth Burst:     ') + clc.cyanBright(formatBytes(parseInt(bwBurst, 10)) + '/s')));

    console.log(row(''));

    // Traffic
    const trafficRead = info['traffic/read'];
    const trafficWritten = info['traffic/written'];
    console.log(row('  ' + clc.white.bold('📥  Data Downloaded:     ') + clc.greenBright(formatBytes(parseInt(trafficRead, 10)))));
    console.log(row('  ' + clc.white.bold('📤  Data Uploaded:       ') + clc.greenBright(formatBytes(parseInt(trafficWritten, 10)))));

    console.log(row(''));

    // Network liveness
    const liveness = info['network-liveness'];
    const livenessColor = liveness === 'up' ? clc.greenBright : clc.redBright;
    console.log(row('  ' + clc.white.bold('🌐  Network:             ') + livenessColor(liveness === 'up' ? '● UP' : '○ DOWN')));

    // OR connections count
    const orLines = info['_lines'] || [];
    const orCount = orLines.filter((l) => l.indexOf('orconn-status') !== -1 || (!l.includes('=') && l.trim() !== '' && !l.includes('circuit'))).length;
    if (orLines.length > 0) {
      console.log(row(''));
      console.log(row('  ' + clc.white.bold('🔗  Active Circuits:     ') + clc.white(orLines.length)));
    }

    // Exit IP
    console.log(row(''));
    if (currentExitIp) {
      console.log(row('  ' + clc.white.bold('🌍  Exit IP:             ') + clc.cyanBright(currentExitIp)));
    } else {
      console.log(row('  ' + clc.white.bold('🌍  Exit IP:             ') + clc.blackBright('---')));
    }

    console.log(row(''));
    sectionFooter();
    showMenu();
  });
}

function shutdown() {
  blank();
  console.log(topBorder());
  console.log(rowCenter(clc.redBright.bold('Q U I T T I N G')));
  console.log(divider());
  if (torProcess) {
    console.log(row('  ' + clc.yellow('Stopping Tor process...')));
    torProcess.on('exit', () => process.exit());
    torProcess.kill('SIGTERM');
    setTimeout(() => process.exit(), 3000);
  } else {
    process.exit();
  }
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

stdin.on('data', (e) => {
  if (e === '\u0003') return shutdown();

  const key = e.trim().toLowerCase();
  if (key === 'q') return shutdown();

  const action = actions[key];
  if (action) {
    action();
  } else if (key !== '') {
    blank();
    console.log(topBorder());
    console.log(row('  ' + clc.redBright(`Invalid option: "${key}" — press 1-9 or Q to quit.`)));
    console.log(bottomBorder());
    blank();
    showMenu();
  }
});

// ── CLI arg support ──────────────────────────────────────────────────────────

const arg = process.argv[2];
if (arg) {
  if (arg.toLowerCase() === 'q' || arg.toLowerCase() === 'quit') {
    shutdown();
  } else if (actions[arg]) {
    showBanner();
    actions[arg]();
  } else {
    showBanner();
    console.log();
    console.log(topBorder());
    console.log(row('  ' + clc.redBright(`Unknown command: "${arg}". Available: 1-9 or q`)));
    console.log(bottomBorder());
  }
} else {
  showBanner();
  showMenu();
}
