/*
 * 京东 CK / wskey -> 青龙 OpenAPI 直连版（Loon 插件参数版）
 * Main JD app: pt_key -> JD_COOKIE; wskey -> independently enabled JD_WSCK / jdUser.ini[wskey]
 * JD Lite app: pt_key -> JD_COOKIE; wskey -> jdUser.ini[jskey]
 * Qinglong URL / Client ID / Client Secret are read from Loon plugin arguments.
 * No PHP relay, no external telemetry, no third-party upload endpoint.
 */

// Loon 插件设置页传入参数；不需要、也不要在源码中填写青龙地址或密钥。
var ARG = (typeof $argument === 'object' && $argument) ? $argument : {};
function argString(name, fallback) {
  var value = ARG[name];
  return value === undefined || value === null ? (fallback || '') : String(value).trim();
}
function argBool(name, fallback) {
  var value = ARG[name];
  if (value === undefined || value === null || value === '') return fallback;
  if (value === true || value === 1) return true;
  var text = String(value).toLowerCase();
  return text === 'true' || text === '1' || text === 'yes' || text === 'on';
}

var CONFIG = {
  QL_URL: argString('ql_url').replace(/\/+$/, ''),
  // Public-domain mode: force Qinglong API requests to DIRECT (no proxy node).
  CLIENT_ID: argString('client_id'),
  CLIENT_SECRET: argString('client_secret'),
  DEVICE_TAG: argString('device_tag', 'iphone-main'),
  TIMEOUT_MS: 15000,
  DEDUPE_SECONDS: 30,
  COOLDOWN_SECONDS: 60,
  PIN_LOOKBACK_SECONDS: 30,
  PENDING_WSKEY_SECONDS: 300,
  PAIR_WINDOW_SECONDS: 300,
  NOTIFY_REPEAT_SECONDS: 600,
  NOTIFY_FAILURE_SECONDS: 60,
  // 每个同步目标独立读取 Loon 插件开关。
  UPLOAD_JD_COOKIE: argBool('upload_jd_cookie', true),
  UPLOAD_LITE_COOKIE: argBool('upload_lite_cookie', true),
  SYNC_JD_WSCK: argBool('upload_jd_wsck', true),
  SYNC_JDUSER_INI: argBool('upload_jd_ini_wskey', true),
  SYNC_LITE_JSKEY: argBool('upload_lite_ini_jskey', true),
  LOG_VERBOSE: false
};

var STORE = {
  TOKEN: 'jdql_direct_token_v1',
  STATE_PREFIX: 'jdql_direct_state_v1_',
  DEDUPE_PREFIX: 'jdql_direct_dedupe_v1_',
  LAST_PREFIX: 'jdql_direct_last_v1_',
  PAIR_PREFIX: 'jdql_direct_pair_v1_',
  FAIL_PREFIX: 'jdql_direct_fail_v1_'
};

var APP_NAMES = { jd: '京东主App', lite: '京东特价版' };
var finished = false;

function log(message) {
  console.log('[JD→青龙 v1.3] ' + message);
}
function notify(title, subtitle, message) {
  try { $notification.post(title, subtitle || '', message || ''); }
  catch (e) { log('通知调用失败：' + String(e)); }
}
function done() {
  if (finished) return;
  finished = true;
  $done({});
}
function readStore(key, fallback) {
  try {
    var raw = $persistentStore.read(key);
    if (raw === null || raw === undefined || raw === '') return fallback;
    return raw;
  } catch (e) { return fallback; }
}
function writeStore(key, value) {
  try { return $persistentStore.write(String(value), key); }
  catch (e) { return false; }
}
function removeStore(key) {
  try { $persistentStore.write(undefined, key); } catch (e) {}
}
function readJSON(key, fallback) {
  try { var v = readStore(key, ''); return v ? JSON.parse(v) : fallback; }
  catch (e) { return fallback; }
}
function writeJSON(key, value) { return writeStore(key, JSON.stringify(value)); }
function enc(v) { return encodeURIComponent(String(v)); }
function safeDecode(v) {
  try { return decodeURIComponent(String(v).replace(/\+/g, '%20')); }
  catch (e) { return String(v); }
}
function hash8(s) {
  // Non-cryptographic fingerprint used only for local dedup/notification state.
  var h = 5381, str = String(s || ''), i;
  for (i = 0; i < str.length; i++) h = ((h << 5) + h + str.charCodeAt(i)) >>> 0;
  return ('00000000' + h.toString(16)).slice(-8);
}
function validPin(value) {
  if (value === null || value === undefined) return '';
  var p = safeDecode(String(value)).trim();
  if (!p || /^(none|null)$/i.test(p) || /^[*%]+$/.test(p) || p.length > 128) return '';
  if (/[\r\n\[\]]/.test(p)) return '';
  return p;
}
function headerValue(headers, name) {
  if (!headers) return '';
  var keys = Object.keys(headers), i;
  for (i = 0; i < keys.length; i++) {
    if (keys[i].toLowerCase() === name.toLowerCase()) return String(headers[keys[i]] || '');
  }
  return '';
}
function cookieValue(cookie, name) {
  var parts = String(cookie || '').split(';'), i, pos, key;
  for (i = 0; i < parts.length; i++) {
    pos = parts[i].indexOf('=');
    if (pos < 0) continue;
    key = parts[i].slice(0, pos).trim();
    if (key === name) return safeDecode(parts[i].slice(pos + 1).trim());
  }
  return '';
}
function detectApp(headers) {
  var ua = headerValue(headers, 'User-Agent');
  var pkg = headerValue(headers, 'X-Referer-Package');
  var jec = headerValue(headers, 'J-E-C') + ' ' + headerValue(headers, 'J-E-H');
  if (/JDMobileLite/i.test(ua)) return 'lite';
  if (/JD4iPhone/i.test(ua)) return 'jd';
  if (/com\.jd\.jdmobilelite/i.test(pkg) || /com\.jd\.jdmobilelite/i.test(jec)) return 'lite';
  if (/com\.360buy\.jdmobile/i.test(pkg)) return 'jd';
  if (/lite/i.test(ua) || /lite/i.test(pkg)) return 'lite';
  return 'jd';
}
function appKey(app) { return app + '_' + CONFIG.DEVICE_TAG; }
function qlBase() { return CONFIG.QL_URL.replace(/\/+$/, ''); }
function parseResponse(data) {
  if (data && typeof data === 'object') return data;
  try { return JSON.parse(String(data || '')); } catch (e) { return null; }
}
function isApiOK(err, response, body) {
  if (err || !response) return false;
  var status = Number(response.status || response.statusCode || 0);
  if (status < 200 || status >= 300) return false;
  var obj = parseResponse(body);
  return !!obj && Number(obj.code) === 200;
}
function http(method, url, body, headers, callback) {
  var opts = {
    url: url,
    timeout: CONFIG.TIMEOUT_MS,
    headers: headers || { 'Accept': 'application/json' },
    'auto-redirect': false,
    'auto-cookie': false,
    node: 'DIRECT'
  };
  if (body !== null && body !== undefined) {
    opts.body = JSON.stringify(body);
    opts.headers['Content-Type'] = 'application/json';
  }
  var fn = String(method).toLowerCase();
  if (!$httpClient[fn]) { callback('Loon HTTP 方法不存在：' + method, null, null); return; }
  $httpClient[fn](opts, callback);
}
function clearToken() { removeStore(STORE.TOKEN); }
function getToken(callback) {
  var cached = readJSON(STORE.TOKEN, null), now = Math.floor(Date.now() / 1000);
  if (cached && cached.token && Number(cached.expiration || 0) > now + 180) {
    callback(null, cached.token); return;
  }
  if (!CONFIG.CLIENT_ID || /替换/.test(CONFIG.CLIENT_ID) || !CONFIG.CLIENT_SECRET || /替换/.test(CONFIG.CLIENT_SECRET)) {
    callback('请先填写青龙 Client ID / Client Secret', null); return;
  }
  var url = qlBase() + '/open/auth/token?client_id=' + enc(CONFIG.CLIENT_ID) + '&client_secret=' + enc(CONFIG.CLIENT_SECRET);
  http('GET', url, null, { 'Accept': 'application/json' }, function (err, response, data) {
    var obj = parseResponse(data);
    if (!isApiOK(err, response, data) || !obj.data || !obj.data.token) {
      callback('青龙获取 Token 失败（HTTP ' + (response ? response.status : '网络错误') + '，请检查外网域名、HTTPS证书、网络及应用权限）', null);
      return;
    }
    var exp = Number(obj.data.expiration || 0);
    if (!exp) exp = now + 29 * 24 * 3600;
    writeJSON(STORE.TOKEN, { token: obj.data.token, expiration: exp });
    callback(null, obj.data.token);
  });
}
function qlRequest(method, path, body, callback, retried) {
  getToken(function (tokenErr, token) {
    if (tokenErr) { callback(tokenErr, null); return; }
    var headers = { 'Accept': 'application/json', 'Authorization': 'Bearer ' + token };
    http(method, qlBase() + path, body, headers, function (err, response, data) {
      var obj = parseResponse(data);
      var status = response ? Number(response.status || response.statusCode || 0) : 0;
      if (!retried && (status === 401 || (obj && Number(obj.code) === 401))) {
        clearToken();
        qlRequest(method, path, body, callback, true);
        return;
      }
      if (!isApiOK(err, response, data)) {
        var detail = obj && (obj.message || obj.msg) ? (obj.message || obj.msg) : (err || ('HTTP ' + status));
        callback('青龙 API 失败：' + String(detail).slice(0, 180), obj);
        return;
      }
      callback(null, obj);
    });
  });
}
function getDataArray(obj) {
  if (!obj || obj.data === undefined || obj.data === null) return [];
  if (Array.isArray(obj.data)) return obj.data;
  if (obj.data.data && Array.isArray(obj.data.data)) return obj.data.data;
  return [];
}
function valueHasPin(value, key, pin) {
  var segments = String(value || '').split(';'), i, p, k, v;
  for (i = 0; i < segments.length; i++) {
    p = segments[i].indexOf('=');
    if (p < 0) continue;
    k = segments[i].slice(0, p).trim();
    v = safeDecode(segments[i].slice(p + 1).trim());
    if (k === key && v === pin) return true;
  }
  return false;
}
function upsertEnv(name, value, matchKey, pin, callback) {
  qlRequest('GET', '/open/envs?searchValue=' + enc(name), null, function (err, obj) {
    if (err) { callback(err, null); return; }
    var envs = getDataArray(obj), found = null, i;
    for (i = 0; i < envs.length; i++) {
      if (envs[i].name === name && valueHasPin(envs[i].value, matchKey, pin)) { found = envs[i]; break; }
    }
    if (found) {
      var payload = { id: /^\d+$/.test(String(found.id)) ? Number(found.id) : found.id, name: name, value: value };
      if (found.remarks !== undefined) payload.remarks = found.remarks;
      qlRequest('PUT', '/open/envs', payload, function (putErr) {
        if (putErr) { callback(putErr, null); return; }
        qlRequest('PUT', '/open/envs/enable', [payload.id], function (enableErr) {
          if (enableErr) { callback('环境变量内容已更新，但启用失败：' + enableErr, null); return; }
          callback(null, { action: '更新', enabled: true, warning: '' });
        });
      });
    } else {
      qlRequest('POST', '/open/envs', [{ name: name, value: value, remarks: pin }], function (postErr) {
        if (postErr) { callback(postErr, null); return; }
        callback(null, { action: '新增', enabled: true, warning: '' });
      });
    }
  });
}
function iniQuote(value) {
  var s = String(value);
  if (/[\s=;#"'\\]/.test(s)) return '"' + s.replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"';
  return s;
}
function updateIniText(content, pin, field, value) {
  var lines = String(content || '').replace(/\r\n/g, '\n').split('\n');
  var start = -1, end = lines.length, i, section;
  for (i = 0; i < lines.length; i++) {
    var m = lines[i].match(/^\s*\[([^\]]+)\]\s*(?:[;#].*)?$/);
    if (m) {
      if (start >= 0) { end = i; break; }
      if (m[1].trim() === pin) start = i;
    }
  }
  var newLine = field + ' = ' + iniQuote(value);
  if (start >= 0) {
    var found = false;
    for (i = start + 1; i < end; i++) {
      var kv = lines[i].match(/^(\s*)(wskey|jskey)\s*=/i);
      if (kv && kv[2].toLowerCase() === field.toLowerCase()) {
        lines[i] = kv[1] + newLine;
        found = true;
        break;
      }
    }
    if (!found) {
      var insertAt = end;
      while (insertAt > start + 1 && lines[insertAt - 1] === '') insertAt--;
      lines.splice(insertAt, 0, newLine);
    }
  } else {
    while (lines.length && lines[lines.length - 1] === '') lines.pop();
    if (lines.length) lines.push('');
    lines.push('[' + pin + ']');
    lines.push('pin = ' + iniQuote(pin));
    lines.push(newLine);
  }
  return lines.join('\n').replace(/\n+$/, '') + '\n';
}
function updateJdUserIni(pin, wskey, field, callback) {
  qlRequest('GET', '/open/configs/files', null, function (err, obj) {
    if (err) { callback('读取青龙配置文件列表失败：' + err); return; }
    var files = getDataArray(obj), target = null, i;
    for (i = 0; i < files.length; i++) {
      if (files[i].title === 'jdUser.ini' || files[i].value === 'jdUser.ini' || String(files[i].value || '').split('/').pop() === 'jdUser.ini') {
        target = files[i]; break;
      }
    }
    if (!target) { callback('青龙配置文件列表中找不到 jdUser.ini，请确认文件存在及应用有 configs 权限'); return; }
    var filePath = target.value || target.title;
    function handleConfigDetail(detailErr, detailObj) {
      if (detailErr) { callback('读取 jdUser.ini 失败：' + detailErr); return; }
      var content = detailObj.data;
      if (content && typeof content === 'object') content = content.content || content.value || '';
      if (typeof content !== 'string') { callback('青龙返回的 jdUser.ini 内容格式无法识别'); return; }
      var updated;
      try { updated = updateIniText(content, pin, field, wskey); }
      catch (e) { callback('解析 jdUser.ini 失败：' + String(e)); return; }
      qlRequest('POST', '/open/configs/save', { name: filePath, content: updated }, function (saveErr) {
        if (saveErr) { callback('保存 jdUser.ini 失败：' + saveErr); return; }
        callback(null, { action: '写入', field: field });
      });
    }
    qlRequest('GET', '/open/configs/detail?path=' + enc(filePath), null, function (detailErr, detailObj) {
      // Current Qinglong uses /detail?path=. Some older builds used /configs/:file.
      // Try the legacy route only when the modern route fails; no other host is contacted.
      if (detailErr) {
        var legacyPath = encodeURI(String(filePath).replace(/^\/+/, ''));
        qlRequest('GET', '/open/configs/' + legacyPath, null, handleConfigDetail);
      } else handleConfigDetail(null, detailObj);
    });
  });
}
function normalizePendingWskeys(pending, now) {
  var out = [], i, item, value, ts, found;
  if (!Array.isArray(pending)) return out;
  for (i = 0; i < pending.length; i++) {
    item = pending[i];
    if (!item || item.wskey === null || item.wskey === undefined) continue;
    value = String(item.wskey);
    ts = Number(item.ts || 0);
    if (!value || !ts || now - ts > CONFIG.PENDING_WSKEY_SECONDS || ts > now + 60) continue;
    found = -1;
    for (var j = 0; j < out.length; j++) {
      if (out[j].wskey === value) { found = j; break; }
    }
    if (found >= 0) {
      if (ts > out[found].ts) out[found].ts = ts;
    } else out.push({ wskey: value, ts: ts });
  }
  return out.slice(-5);
}
function localState(app) {
  var key = STORE.STATE_PREFIX + appKey(app);
  var s = readJSON(key, { pins: {}, pending: [] });
  if (!s || typeof s !== 'object') s = { pins: {}, pending: [] };
  if (!s.pins || typeof s.pins !== 'object') s.pins = {};
  s.pending = normalizePendingWskeys(s.pending, Math.floor(Date.now() / 1000));
  return s;
}
function saveLocalState(app, s) {
  var now = Math.floor(Date.now() / 1000), k;
  for (k in s.pins) if (now - Number(s.pins[k] || 0) > 3600) delete s.pins[k];
  s.pending = normalizePendingWskeys(s.pending, now);
  writeJSON(STORE.STATE_PREFIX + appKey(app), s);
}
function activePins(s, now) {
  var out = [], k;
  for (k in s.pins) if (now - Number(s.pins[k] || 0) <= CONFIG.PIN_LOOKBACK_SECONDS) out.push(k);
  return out;
}
function lastKey(app, kind, pin) { return STORE.LAST_PREFIX + appKey(app) + '_' + kind + '_' + hash8(pin); }
function dedupeKey(app, kind, pin, credential) { return STORE.DEDUPE_PREFIX + appKey(app) + '_' + kind + '_' + hash8(pin + '|' + credential); }
function shouldDedupe(key) {
  var now = Math.floor(Date.now() / 1000), last = Number(readStore(key, '0')) || 0;
  if (now - last < CONFIG.DEDUPE_SECONDS) return true;
  writeStore(key, String(now));
  return false;
}
function inCooldown(app, kind, pin) {
  var v = readJSON(lastKey(app, kind, pin), null), now = Math.floor(Date.now() / 1000);
  return !!(v && now - Number(v.ts || 0) < CONFIG.COOLDOWN_SECONDS);
}
function markSuccess(app, kind, pin, sig, action, target) {
  var now = Math.floor(Date.now() / 1000);
  writeJSON(lastKey(app, kind, pin), { ts: now, sig: sig });
  var key = STORE.PAIR_PREFIX + appKey(app) + '_' + hash8(pin);
  var p = readJSON(key, {});
  p[kind] = { sig: sig, ts: now, action: action, target: target || '' };
  writeJSON(key, p);

  // Notify each credential independently, immediately after its own upload completes.
  // Cookie and wskey no longer need to arrive as a pair before the user is notified.
  var pinText = pinMask(pin);
  var isCookie = kind === 'ck';
  var title = APP_NAMES[app] + (isCookie ? ' Cookie同步成功' : ' wskey同步成功');
  var subtitle = 'PIN: ' + pinText;
  var detail = (target || (isCookie ? 'JD_COOKIE' : 'wskey')) + '（' + (action || '写入') + '成功）';
  notify(title, subtitle, '✅ ' + detail);
}
function maybeNotifyPair(app, pin, key, p) {
  var now = Math.floor(Date.now() / 1000), ck = p.ck, ws = p.wskey;
  if (!ck || !ws || now - Number(ck.ts || 0) > CONFIG.PAIR_WINDOW_SECONDS || now - Number(ws.ts || 0) > CONFIG.PAIR_WINDOW_SECONDS) return;
  var sig = ck.sig + '|' + ws.sig;
  var prevSig = p.notifiedSig || '', prevAt = Number(p.notifiedAt || 0);
  if (prevAt && now - prevAt < CONFIG.NOTIFY_REPEAT_SECONDS) {
    if (prevSig === sig) return;
    var old = prevSig.split('|');
    if (old.length === 2 && (old[0] === ck.sig || old[1] === ws.sig)) return;
  }
  p.notifiedSig = sig;
  p.notifiedAt = now;
  writeJSON(key, p);
  var pinText = String(pin).length > 4 ? String(pin).slice(0, 2) + '***' + String(pin).slice(-2) : String(pin);
  notify(APP_NAMES[app] + ' CK + wskey 同步成功', 'PIN: ' + pinText,
    '✅ pt_key → JD_COOKIE（' + ck.action + '）\n✅ wskey → ' + ws.target + '（' + ws.action + '）');
}
function failOnce(app, key, message) {
  var k = STORE.FAIL_PREFIX + appKey(app) + '_' + hash8(key);
  var now = Math.floor(Date.now() / 1000), last = Number(readStore(k, '0')) || 0;
  if (now - last < CONFIG.NOTIFY_FAILURE_SECONDS) return;
  writeStore(k, String(now));
  notify(APP_NAMES[app] + ' 同步失败', '请检查 Loon / 网络 / 青龙', message);
}
function uploadCookie(app, pin, ptKey, callback) {
  var value = 'pt_key=' + ptKey + ';pt_pin=' + pin + ';';
  var sig = hash8(value), key = dedupeKey(app, 'ck', pin, value);
  if (shouldDedupe(key)) { callback(null, { skipped: true }); return; }
  if (inCooldown(app, 'ck', pin)) { callback(null, { skipped: true, cooldown: true }); return; }
  upsertEnv('JD_COOKIE', value, 'pt_pin', pin, function (err, result) {
    if (err) { removeStore(key); callback(err); return; }
    markSuccess(app, 'ck', pin, sig, result.action, 'JD_COOKIE');
    log(APP_NAMES[app] + ' JD_COOKIE ' + result.action + '成功，PIN=' + pinMask(pin));
    callback(null, result);
  });
}
function uploadWskey(app, pin, wskey, callback) {
  var key = dedupeKey(app, 'ws', pin, wskey);
  if (shouldDedupe(key)) { callback(null, { skipped: true }); return; }
  if (inCooldown(app, 'ws', pin)) { callback(null, { skipped: true, cooldown: true }); return; }

  // Each destination is an independent sync target. A disabled or failed target
  // must never prevent another enabled target from being attempted or notified.
  var tasks = [];
  if (app === 'lite') {
    if (CONFIG.SYNC_LITE_JSKEY) tasks.push({ field: 'jskey', target: 'jdUser.ini[jskey]' });
  } else {
    if (CONFIG.SYNC_JD_WSCK) tasks.push({ type: 'env', target: 'JD_WSCK' });
    if (CONFIG.SYNC_JDUSER_INI) tasks.push({ field: 'wskey', target: 'jdUser.ini[wskey]' });
  }
  if (!tasks.length) {
    log(APP_NAMES[app] + ' wskey 同步目标均已关闭，跳过');
    callback(null, { skipped: true, disabled: true });
    return;
  }

  var sig = hash8(wskey), errors = [], completed = 0;
  function finishOne() {
    completed++;
    if (completed < tasks.length) return;
    if (errors.length) {
      removeStore(key);
      callback(errors.join('；'));
    } else {
      callback(null, { action: '写入', targets: tasks.map(function (t) { return t.target; }) });
    }
  }
  function success(task, action) {
    // Notify immediately for this destination only; no dependency on other targets.
    markSuccess(app, 'wskey', pin, sig, action || '写入', task.target);
    log(APP_NAMES[app] + ' wskey 目标 ' + task.target + ' 同步成功，PIN=' + pinMask(pin));
    finishOne();
  }
  tasks.forEach(function (task) {
    if (task.type === 'env') {
      var envValue = 'pin=' + pin + ';wskey=' + wskey + ';';
      upsertEnv('JD_WSCK', envValue, 'pin', pin, function (err, result) {
        if (err) errors.push('JD_WSCK：' + err);
        else success(task, result.action);
        if (err) finishOne();
      });
    } else {
      updateJdUserIni(pin, wskey, task.field, function (err, result) {
        if (err) errors.push(task.target + '：' + err);
        else success(task, result.action);
        if (err) finishOne();
      });
    }
  });
}
function pinMask(pin) {
  var s = String(pin || '');
  return s.length > 4 ? s.slice(0, 2) + '***' + s.slice(-2) : s;
}
function testConnection() {
  if (!/^https?:\/\//i.test(CONFIG.QL_URL)) { log('请在 Loon 插件设置页填写正确的青龙地址'); done(); return; }
  getToken(function (err, token) {
    if (err) { log(err); notify('京东直连青龙测试失败', '', err); done(); return; }
    qlRequest('GET', '/open/envs?searchValue=JD_COOKIE', null, function (envErr, envObj) {
      if (envErr) { log(envErr); notify('京东直连青龙测试失败', '', envErr); done(); return; }
      qlRequest('GET', '/open/configs/files', null, function (cfgErr, cfgObj) {
        if (cfgErr) { log('环境变量权限正常，但配置文件权限/接口异常：' + cfgErr); notify('青龙部分权限测试失败', '', cfgErr); done(); return; }
        var files = getDataArray(cfgObj), hasIni = files.some(function (f) { return f.title === 'jdUser.ini' || f.value === 'jdUser.ini' || String(f.value || '').split('/').pop() === 'jdUser.ini'; });
        var msg = '青龙 API 连接成功；envs 权限正常；configs 权限正常；' + (hasIni ? '已找到 jdUser.ini' : '未找到 jdUser.ini（请先确认配置文件存在）');
        log(msg);
        notify('京东直连青龙连接测试', '连接成功', msg);
        done();
      });
    });
  });
}
function main() {
  if (!CONFIG.QL_URL || !/^https?:\/\//i.test(CONFIG.QL_URL) || !CONFIG.CLIENT_ID || !CONFIG.CLIENT_SECRET) {
    log('请在 Loon 插件设置页填写青龙地址、Client ID 和 Client Secret；无需编辑脚本源码');
    done(); return;
  }
  if (typeof $request === 'undefined' || !$request || !$request.headers) { testConnection(); return; }
  var url = String($request.url || '');
  if (!/^https?:\/\/(?:[^/]+\.)?jd\.com\//i.test(url)) { done(); return; }
  var headers = $request.headers;
  var cookie = headerValue(headers, 'Cookie');
  if (!cookie) { done(); return; }
  var ptKey = cookieValue(cookie, 'pt_key');
  var ptPin = validPin(cookieValue(cookie, 'pt_pin'));
  var wskey = cookieValue(cookie, 'wskey');
  if (!ptKey && !ptPin && !wskey) { done(); return; }
  if (!ptPin) ptKey = '';
  var app = detectApp(headers), now = Math.floor(Date.now() / 1000);
  var state = localState(app), targetPin = '';

  // Match original behavior: wskey without a pin may use a unique recent pin from the same app/device.
  if (wskey) {
    if (ptPin) targetPin = ptPin;
    else {
      var candidates = activePins(state, now);
      if (candidates.length === 1) targetPin = candidates[0];
      else {
        // Multiple requests can carry the same wskey. Refresh its timestamp instead
        // of creating duplicate pending entries; distinct wskeys remain separate.
        var pendingFound = false;
        for (var pi = 0; pi < state.pending.length; pi++) {
          if (state.pending[pi].wskey === wskey) {
            state.pending[pi].ts = now;
            pendingFound = true;
            break;
          }
        }
        if (!pendingFound) state.pending.push({ wskey: wskey, ts: now });
        saveLocalState(app, state);
        log(APP_NAMES[app] + ' 捕获到 wskey，但无法安全确定 PIN，已在本机暂存 5 分钟；不会猜账号');
        done(); return;
      }
    }
  } else if (ptPin) {
    // Original server consumes a pending wskey on a later pin-bearing request, only when unambiguous.
    var currentPins = activePins(state, now);
    if (currentPins.length <= 1 && state.pending.length) {
      state.pending = state.pending.filter(function (x) { return now - Number(x.ts || 0) <= CONFIG.PENDING_WSKEY_SECONDS; });
      if (state.pending.length === 1) {
        wskey = state.pending.shift().wskey;
        targetPin = ptPin;
      } else if (state.pending.length > 1) {
        log('同一 App 有多条待配对 wskey，为防止串号，本次不自动配对');
      }
    }
  }

  // Store pin timestamp after pending resolution, matching the source server's order.
  if (ptPin) state.pins[ptPin] = now;
  saveLocalState(app, state);

  var jobs = [];
  if (ptKey && ptPin && ((app === 'lite' && CONFIG.UPLOAD_LITE_COOKIE) || (app !== 'lite' && CONFIG.UPLOAD_JD_COOKIE))) jobs.push(function (next) { uploadCookie(app, ptPin, ptKey, next); });
  if (wskey && targetPin) jobs.push(function (next) { uploadWskey(app, targetPin, wskey, next); });
  if (wskey && !targetPin) log('wskey 暂存等待 PIN；未上传青龙');
  if (!jobs.length) { done(); return; }

  var errors = [];
  function runNext(index) {
    if (index >= jobs.length) {
      if (errors.length) {
        var msg = errors.join('；');
        log(APP_NAMES[app] + ' 同步失败：' + msg);
        failOnce(app, (ptPin || targetPin || 'unknown') + '|' + msg, msg);
      }
      done(); return;
    }
    jobs[index](function (err) {
      if (err) errors.push(String(err));
      runNext(index + 1);
    });
  }
  runNext(0);
}

main();
