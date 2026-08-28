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

// ── Layout (matching FramerExport style) ─────────────────────────────────────

function getWidth() {
  return Math.min(process.stdout.columns || 80, 76);
}

function stripAnsi(s) {
  return s.replace(/\x1B\[[0-9;]*[a-zA-Z]/g, '');
}

// ── Box drawing primitives ───────────────────────────────────────────────────

function boxTop(w) {
  const inner = w - 4;
  return '  ' + clc.white('╭─' + '─'.repeat(inner) + '─╮');
}

function boxBot(w) {
  const inner = w - 4;
  return '  ' + clc.white('╰─' + '─'.repeat(inner) + '─╯');
}

function boxLine(w, text) {
  const inner = w - 4;
  const visible = stripAnsi(text).length;
  if (visible <= inner) {
    const pad = Math.max(0, inner - visible);
    return '  ' + clc.white('│ ') + text + ' '.repeat(pad) + clc.white(' │');
  }
  // Truncate long text
  const truncated = text.slice(0, inner - 2) + '..';
  return '  ' + clc.white('│ ') + truncated + clc.white(' │');
}

function boxLines(w, text) {
  // Split text by newlines and return an array of boxLine strings
  const inner = w - 4;
  return text.split('\n').filter((l) => l.trim() !== '').map((line) => {
    const trimmed = line.trim();
    const visible = stripAnsi(trimmed).length;
    if (visible <= inner) {
      const pad = Math.max(0, inner - visible);
      return '  ' + clc.white('│ ') + trimmed + ' '.repeat(pad) + clc.white(' │');
    }
    const truncated = trimmed.slice(0, inner - 2) + '..';
    return '  ' + clc.white('│ ') + truncated + clc.white(' │');
  });
}

function boxSep(w) {
  const inner = w - 4;
  return '  ' + clc.white('├─' + '─'.repeat(inner) + '─┤');
}

function centerText(text, width) {
  const visible = stripAnsi(text).length;
  if (visible >= width) return text;
  const left = Math.floor((width - visible) / 2);
  return ' '.repeat(left) + text + ' '.repeat(width - visible - left);
}

function boxRow(w, label, value) {
  const inner = w - 4;
  const labelPlain = stripAnsi(label);
  const avail = Math.max(0, inner - labelPlain.length - 2);
  const valueVisible = stripAnsi(value).length;
  const fittedValue = valueVisible <= avail ? value : value.slice(0, avail - 2) + '..';
  const right = Math.max(0, inner - labelPlain.length - 2 - stripAnsi(fittedValue).length);
  return '  ' + clc.white('│ ') + label + ': ' + value + ' '.repeat(right) + clc.white(' │');
}

function blank() {
  console.log();
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function torControl(action, callback) {
  const control = new TorControl();
  const method = `signal${action.charAt(0).toUpperCase() + action.slice(1)}`;
  control[method](function (error, status) {
    const w = getWidth();
    if (error) {
      blank();
      console.log(boxLine(w, '  ' + clc.redBright('X error: ' + error)));
      console.log(boxBot(w));
    } else {
      blank();
      console.log(boxLine(w, '  ' + clc.greenBright('> ' + status.messages[0])));
      console.log(boxBot(w));
    }
    if (callback) callback(error);
  });
}

function statusText() {
  const state = torProcess ? clc.greenBright('RUNNING') : clc.redBright('STOPPED');
  const ip = currentExitIp ? clc.cyanBright(currentExitIp) : clc.blackBright('---');
  return 'Tor: ' + state + '  |  Exit IP: ' + ip;
}

// ── Banner ───────────────────────────────────────────────────────────────────

function showBanner() {
  const w = getWidth();
  const ASCII_ART = [
    '████████╗',
    '╚══██╔══╝',
    '   ██║   ',
    '   ██║   ',
    '   ╚═╝   ',
  ];

  console.log('');
  console.log(boxTop(w));
  ASCII_ART.forEach((line) => {
    console.log(boxLine(w, centerText(clc.cyanBright.bold(line), w - 4)));
  });
  console.log(boxLine(w, centerText(clc.white('T O R   C O N T R O L L E R'), w - 4)));
  console.log(boxLine(w, centerText(clc.blackBright('v1.0  |  node + tor'), w - 4)));
  console.log(boxSep(w));
  console.log(boxLine(w, '  ' + statusText()));
  console.log(boxBot(w));
}

// ── Menu ─────────────────────────────────────────────────────────────────────

function showMenu() {
  const w = getWidth();
  blank();
  console.log(boxTop(w));
  console.log(boxLine(w, centerText(clc.white.bold('M A I N   M E N U'), w - 4)));
  console.log(boxSep(w));

  const items = [
    { key: '1', label: 'Start TOR connection',  color: clc.greenBright },
    { key: '2', label: 'Log connection info',    color: clc.blueBright },
    { key: '3', label: 'Stop TOR connection',    color: clc.redBright },
    { key: '4', label: 'Debug TOR connection',   color: clc.yellowBright },
    { key: '5', label: 'New TOR identity',       color: clc.magentaBright },
    { key: '6', label: 'Restart TOR connection', color: clc.blueBright },
    { key: '7', label: 'Show exit IP',           color: clc.cyanBright },
    { key: '8', label: 'Show circuit path',      color: clc.cyanBright },
    { key: '9', label: 'Network stats',          color: clc.yellowBright },
    { key: '0', label: 'Live dashboard',         color: clc.cyanBright },
  ];

  items.forEach((item) => {
    const key = clc.white.bold('[' + item.key + ']');
    const label = item.color(item.label);
    console.log(boxLine(w, '  ' + key + '  ' + label));
  });

  console.log(boxSep(w));
  console.log(boxLine(w, '  ' + clc.blackBright('Press a key (1-9, 0) or ' + clc.white.bold('Q') + ' to quit')));
  console.log(boxBot(w));
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
        return callback(new Error('SOCKS5 CONNECT failed: 0x' + data[1].toString(16)));
      }
      step = 2;
      socket.write('GET ' + path + ' HTTP/1.1\r\nHost: ' + host + '\r\nConnection: close\r\n\r\n');
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
  const w = getWidth();
  blank();
  console.log(boxTop(w));
  console.log(boxLine(w, centerText(clc.greenBright.bold('S T A R T   T O R'), w - 4)));
  console.log(boxSep(w));

  if (torProcess) {
    console.log(boxLine(w, '  ' + clc.yellow('Tor is already running. Stop it first (option 3).')));
    console.log(boxBot(w));
    return showMenu();
  }

  torProcess = spawn('./vendor/tor-bundle/tor.exe', ['-f', 'torrc']);

  torProcess.on('exit', (code) => {
    blank();
    console.log(boxLine(w, '  ' + clc.yellow('Tor exited with code ' + code)));
    torProcess = null;
    currentExitIp = null;
    console.log(boxBot(w));
    showMenu();
  });

  torProcess.stdout.on('data', (data) => {
    const msg = data.toString();
    if (msg.indexOf('100%:') !== -1) {
      blank();
      console.log(boxLine(w, '  ' + clc.greenBright.bold('> Tor connected successfully!')));
      console.log(boxBot(w));
      fetchExitIp(() => showMenu());
    } else {
      if (msg.indexOf('[notice]') !== -1 || msg.indexOf('[warn]') !== -1 || msg.indexOf('[err]') !== -1) {
        // Split multi-line output into individual box lines
        const lines = boxLines(w, '  ' + clc.blackBright(msg.trim()));
        lines.forEach((line) => console.log(line));
      }
    }
  });

  torProcess.stderr.on('data', (data) => {
    const lines = boxLines(w, '  ' + clc.redBright(data.toString().trim()));
    lines.forEach((line) => console.log(line));
  });
}

function stopTor() {
  const w = getWidth();
  blank();
  console.log(boxTop(w));
  console.log(boxLine(w, centerText(clc.redBright.bold('S T O P   T O R'), w - 4)));
  console.log(boxSep(w));
  if (!torProcess) {
    console.log(boxLine(w, '  ' + clc.yellow('No running Tor process found.')));
    console.log(boxBot(w));
    return showMenu();
  }
  torControl('halt', () => {
    torProcess = null;
    currentExitIp = null;
    showMenu();
  });
}

function restartTor() {
  const w = getWidth();
  blank();
  console.log(boxTop(w));
  console.log(boxLine(w, centerText(clc.blueBright.bold('R E S T A R T'), w - 4)));
  console.log(boxSep(w));
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
  const w = getWidth();
  blank();
  console.log(boxTop(w));
  console.log(boxLine(w, centerText(clc.blueBright.bold('L O G   I N F O R M A T I O N'), w - 4)));
  console.log(boxSep(w));
  torControl('dump', () => showMenu());
}

function debugInfo() {
  const w = getWidth();
  blank();
  console.log(boxTop(w));
  console.log(boxLine(w, centerText(clc.yellowBright.bold('D E B U G'), w - 4)));
  console.log(boxSep(w));
  torControl('debug', () => showMenu());
}

function newIdentity() {
  const w = getWidth();
  blank();
  console.log(boxTop(w));
  console.log(boxLine(w, centerText(clc.magentaBright.bold('N E W   I D E N T I T Y'), w - 4)));
  console.log(boxSep(w));
  torControl('newnym', () => showMenu());
}

function fetchExitIp(callback) {
  const w = getWidth();
  if (!torProcess) {
    currentExitIp = null;
    return callback ? callback() : null;
  }
  console.log(boxLine(w, '  ' + clc.white('Querying exit IP...')));
  httpGetThroughSocks('api.ipify.org', '/', (err, body) => {
    if (err) {
      currentExitIp = null;
      console.log(boxLine(w, '  ' + clc.redBright('Failed to fetch IP: ' + err.message)));
    } else {
      currentExitIp = body.trim();
      console.log(boxLine(w, '  ' + clc.greenBright('Exit IP: ' + currentExitIp)));
    }
    if (callback) callback();
  });
}

function showExitIp() {
  const w = getWidth();
  blank();
  console.log(boxTop(w));
  console.log(boxLine(w, centerText(clc.cyanBright.bold('E X I T   I P'), w - 4)));
  console.log(boxSep(w));
  if (!torProcess) {
    console.log(boxLine(w, '  ' + clc.yellow('Tor is not running. Start it first.')));
    console.log(boxBot(w));
    return showMenu();
  }
  fetchExitIp(() => {
    console.log(boxBot(w));
    showMenu();
  });
}

function showCircuitPath() {
  const w = getWidth();
  blank();
  console.log(boxTop(w));
  console.log(boxLine(w, centerText(clc.cyanBright.bold('C I R C U I T   P A T H'), w - 4)));
  console.log(boxSep(w));
  if (!torProcess) {
    console.log(boxLine(w, '  ' + clc.yellow('Tor is not running. Start it first.')));
    console.log(boxBot(w));
    return showMenu();
  }
  const control = new TorControl();
  control.getInfo('circuit-status', (err, result) => {
    if (err) {
      console.log(boxLine(w, '  ' + clc.redBright('Error: ' + err)));
      console.log(boxBot(w));
      return showMenu();
    }
    const lines = result.messages.filter((m) => m.trim() !== '' && m.trim() !== 'OK');
    if (lines.length === 0) {
      console.log(boxLine(w, '  ' + clc.yellow('No active circuits found.')));
      console.log(boxBot(w));
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

      console.log(boxLine(w, '  ' + clc.white.bold('Circuit #' + id) + ' ' + clc.greenBright('[' + state + ']') + ' ' + clc.blackBright(purpose)));
      relays.forEach((relay, i) => {
        const role = i === 0 ? 'Entry' : i === relays.length - 1 ? 'Exit ' : 'Hop ' + i;
        const arrow = i === 0 ? '  ' : ' -> ';
        const roleColor = i === 0 ? clc.greenBright : i === relays.length - 1 ? clc.redBright : clc.yellowBright;
        console.log(boxLine(w, '  ' + clc.blackBright(arrow) + roleColor(role + ':') + ' ' + clc.white(relay)));
      });
      console.log(boxLine(w, ''));
    });
    console.log(boxBot(w));
    showMenu();
  });
}

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
  if (d > 0) parts.push(d + 'd');
  if (h > 0) parts.push(h + 'h');
  if (m > 0) parts.push(m + 'm');
  parts.push(s + 's');
  return parts.join(' ');
}

function renderStats(w) {
  return new Promise((resolve) => {
    if (!torProcess) {
      console.log(boxLine(w, '  ' + clc.yellow('Tor is not running. Start it first.')));
      console.log(boxBot(w));
      return resolve();
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
        console.log(boxLine(w, '  ' + clc.redBright('Error: ' + err)));
        console.log(boxBot(w));
        return resolve();
      }
      const info = {};
      result.messages.forEach((msg) => {
        const idx = msg.indexOf('=');
        if (idx !== -1) {
          info[msg.substring(0, idx)] = msg.substring(idx + 1);
        } else if (msg.trim() !== 'OK' && msg.trim() !== '') {
          if (!info['_lines']) info['_lines'] = [];
          info['_lines'].push(msg);
        }
      });

      const now = new Date().toLocaleTimeString();
      console.log(boxLine(w, '  ' + clc.blackBright('Last updated: ' + now)));
      console.log(boxLine(w, ''));

      const uptime = info['status/client/uptime'];
      console.log(boxRow(w, 'Uptime', clc.cyanBright(formatUptime(parseInt(uptime, 10)))));

      const bwRate = info['bandwidth-rate'];
      const bwBurst = info['bandwidth-burst'];
      console.log(boxRow(w, 'Bandwidth Rate', clc.cyanBright(formatBytes(parseInt(bwRate, 10)) + '/s')));
      console.log(boxRow(w, 'Bandwidth Burst', clc.cyanBright(formatBytes(parseInt(bwBurst, 10)) + '/s')));

      console.log(boxLine(w, ''));

      const trafficRead = info['traffic/read'];
      const trafficWritten = info['traffic/written'];
      console.log(boxRow(w, 'Downloaded', clc.greenBright(formatBytes(parseInt(trafficRead, 10)))));
      console.log(boxRow(w, 'Uploaded', clc.greenBright(formatBytes(parseInt(trafficWritten, 10)))));

      console.log(boxLine(w, ''));

      const liveness = info['network-liveness'];
      const livenessColor = liveness === 'up' ? clc.greenBright : clc.redBright;
      console.log(boxRow(w, 'Network', livenessColor(liveness === 'up' ? 'UP' : 'DOWN')));

      const orLines = info['_lines'] || [];
      if (orLines.length > 0) {
        console.log(boxRow(w, 'Active Circuits', clc.white(orLines.length)));
      }

      console.log(boxLine(w, ''));
      if (currentExitIp) {
        console.log(boxRow(w, 'Exit IP', clc.cyanBright(currentExitIp)));
      } else {
        console.log(boxRow(w, 'Exit IP', clc.blackBright('---')));
      }

      console.log(boxLine(w, ''));
      console.log(boxBot(w));
      resolve();
    });
  });
}

function showNetworkStats() {
  const w = getWidth();
  blank();
  console.log(boxTop(w));
  console.log(boxLine(w, centerText(clc.yellowBright.bold('N E T W O R K   S T A T S'), w - 4)));
  console.log(boxSep(w));
  renderStats(w).then(() => showMenu());
}

// ── Live Dashboard ───────────────────────────────────────────────────────────

let dashboardInterval = null;

function stopDashboard() {
  if (dashboardInterval) {
    clearInterval(dashboardInterval);
    dashboardInterval = null;
  }
}

function liveDashboard() {
  const w = getWidth();
  stopDashboard();
  blank();
  console.log(boxTop(w));
  console.log(boxLine(w, centerText(clc.cyanBright.bold('L I V E   D A S H B O R D'), w - 4)));
  console.log(boxSep(w));
  console.log(boxLine(w, '  ' + clc.blackBright('Refreshing every 3s... Press any key to Stop.')));
  console.log(boxBot(w));
  blank();

  renderStats(w);

  dashboardInterval = setInterval(() => {
    process.stdout.write('\x1b[2J\x1b[H');
    showBanner();
    console.log(boxTop(w));
    console.log(boxLine(w, centerText(clc.cyanBright.bold('L I V E   D A S H B O R D'), w - 4)));
    console.log(boxSep(w));
    console.log(boxLine(w, '  ' + clc.blackBright('Refreshing every 3s... Press any key to stop.')));
    console.log(boxBot(w));
    blank();
    renderStats(w);
  }, 3000);
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
  '0': liveDashboard,
};

function shutdown() {
  const w = getWidth();
  stopDashboard();
  blank();
  console.log(boxTop(w));
  console.log(boxLine(w, centerText(clc.redBright.bold('Q U I T T I N G'), w - 4)));
  console.log(boxSep(w));
  if (torProcess) {
    console.log(boxLine(w, '  ' + clc.yellow('Stopping Tor process...')));
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

  // Stop dashboard on any key press
  if (dashboardInterval) {
    stopDashboard();
    showMenu();
    return;
  }

  const action = actions[key];
  if (action) {
    action();
  } else if (key !== '') {
    const w = getWidth();
    blank();
    console.log(boxTop(w));
    console.log(boxLine(w, '  ' + clc.redBright('Invalid option: "' + key + '" -- press 1-9, 0 or Q to quit.')));
    console.log(boxBot(w));
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
    const w = getWidth();
    showBanner();
    blank();
    console.log(boxTop(w));
    console.log(boxLine(w, '  ' + clc.redBright('Unknown command: "' + arg + '". Available: 1-9, 0 or q')));
    console.log(boxBot(w));
  }
} else {
  showBanner();
  showMenu();
}
