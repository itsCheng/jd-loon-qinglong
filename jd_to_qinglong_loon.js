/*
 * 京东 CK 自动同步到青龙 - Loon
 * 主 App: pt_key/pt_pin -> JD_COOKIE；wskey -> JD_WSCK（可独立关闭）及 jdUser.ini[wskey]
 * 特价版: pt_key/pt_pin -> JD_COOKIE（可独立关闭）；wskey -> jdUser.ini[jskey]（可独立关闭）
 * 所有青龙请求只访问用户配置的 QL_URL，并固定 DIRECT；不含 PHP 中转、遥测或第三方上传。
 */
(function () {
  'use strict';

  var VERSION = '2.0.0';
  var ARG = (typeof $argument === 'object' && $argument) ? $argument : {};
  var CFG = {
    base: str(ARG.ql_url).replace(/\/+$/, ''),
    clientId: str(ARG.client_id),
    clientSecret: str(ARG.client_secret),
    device: str(ARG.device_tag) || 'iphone-main',
    captureJD: boolArg('capture_jd', true),
    captureLite: boolArg('capture_lite', true),
    jdCookie: boolArg('upload_jd_cookie', true),
    jdWsck: boolArg('upload_jd_wsck', true),
    jdIni: boolArg('upload_jd_ini_wskey', true),
    liteCookie: boolArg('upload_lite_cookie', true),
    liteIni: boolArg('upload_lite_ini_jskey', true),
    timeout: 18000,
    pendingSec: 300,
    pinRecentSec: 300,
    dedupeSec: 45
  };
  var STORE = 'jdql_rebuild_v2';
  var ended = false;

  function str(v) { return v === null || v === undefined ? '' : String(v).trim(); }
  function boolArg(k, d) {
    if (!Object.prototype.hasOwnProperty.call(ARG, k)) return d;
    return ARG[k] === true || ARG[k] === 1 || String(ARG[k]).toLowerCase() === 'true';
  }
  function log(s) { console.log('[JDQL v' + VERSION + '] ' + s); }
  function finish() { if (!ended) { ended = true; $done({}); } }
  function notify(t, s, m) { try { $notification.post(t, s || '', m || ''); } catch (e) { log('通知失败'); } }
  function readState() {
    try { var x = $persistentStore.read(STORE); return x ? JSON.parse(x) : {}; }
    catch (e) { return {}; }
  }
  function saveState(x) {
    try { return $persistentStore.write(JSON.stringify(x), STORE); }
    catch (e) { return false; }
  }
  function header(headers, name) {
    if (!headers) return '';
    var keys = Object.keys(headers), i;
    for (i = 0; i < keys.length; i++) if (keys[i].toLowerCase() === name.toLowerCase()) return str(headers[keys[i]]);
    return '';
  }
  function cookieMap(headers) {
    var raw = '';
    if (headers) Object.keys(headers).forEach(function (k) { if (k.toLowerCase() === 'cookie' || k.toLowerCase() === 'cookie2') raw += (raw ? '; ' : '') + str(headers[k]); });
    var out = {}, parts = raw.split(';'), i, p, n;
    for (i = 0; i < parts.length; i++) {
      p = parts[i].indexOf('=');
      if (p < 1) continue;
      n = parts[i].slice(0, p).trim();
      if (!Object.prototype.hasOwnProperty.call(out, n)) out[n] = decode(parts[i].slice(p + 1).trim());
    }
    return out;
  }
  function decode(v) { try { return decodeURIComponent(String(v).replace(/\+/g, '%20')); } catch (e) { return String(v); } }
  function validPin(v) {
    v = str(v);
    if (!v || /^(null|undefined|none)$/i.test(v) || v.length > 128 || /[\r\n\[\]]/.test(v)) return '';
    return v;
  }
  function detectApp(h) {
    var ua = header(h, 'User-Agent');
    var pkg = header(h, 'X-Referer-Package');
    var extra = header(h, 'J-E-C') + ' ' + header(h, 'J-E-H');
    // 先判断更具体的 Lite 特征，避免被通用 JD UA 提前命中。
    if (/JDMobileLite|com\.jd\.jdmobilelite/i.test(ua + ' ' + pkg + ' ' + extra)) return 'lite';
    if (/JD4iPhone|com\.360buy\.jdmobile/i.test(ua + ' ' + pkg + ' ' + extra)) return 'jd';
    return 'unknown';
  }
  function hash(s) {
    var h = 5381;
    for (var i = 0; i < String(s).length; i++) h = ((h * 33) ^ String(s).charCodeAt(i)) >>> 0;
    return ('00000000' + h.toString(16)).slice(-8);
  }
  function safeLogResponse(obj, raw) {
    var code = obj && obj.code !== undefined ? String(obj.code) : '无';
    var msg = obj ? str(obj.message || obj.msg) : '';
    return '业务code=' + code + (msg ? '，message=' + msg.slice(0, 100) : '');
  }
  function parseBody(data) {
    if (data && typeof data === 'object') return data;
    try { return JSON.parse(String(data || '')); } catch (e) { return null; }
  }
  function apiSuccess(httpStatus, obj) {
    if (httpStatus < 200 || httpStatus >= 300 || !obj || typeof obj !== 'object') return false;
    // 青龙不同版本/文档存在 code=200 与 code=0 两种成功约定；不把任意 HTTP 200 当成功。
    if (obj.code === 200 || obj.code === 0 || obj.code === '200' || obj.code === '0') return true;
    return false;
  }
  function http(method, path, body, token, cb) {
    var headers = { Accept: 'application/json' };
    if (token) headers.Authorization = 'Bearer ' + token;
    if (body !== null && body !== undefined) headers['Content-Type'] = 'application/json';
    var opt = { url: CFG.base + path, timeout: CFG.timeout, headers: headers, node: 'DIRECT', 'auto-redirect': false, 'auto-cookie': false };
    if (body !== null && body !== undefined) opt.body = JSON.stringify(body);
    var fn = String(method).toLowerCase();
    if (!$httpClient || typeof $httpClient[fn] !== 'function') { cb('Loon HTTP 方法不可用：' + method); return; }
    $httpClient[fn](opt, function (err, resp, data) {
      var status = resp ? Number(resp.status || resp.statusCode || 0) : 0;
      var obj = parseBody(data);
      if (err) { cb('网络请求失败：' + str(err).slice(0, 120), obj, status); return; }
      if (!resp) { cb('没有收到 HTTP 响应', obj, status); return; }
      if (status < 200 || status >= 300) { cb('HTTP ' + status + '；' + safeLogResponse(obj, data), obj, status); return; }
      if (!apiSuccess(status, obj)) { cb('HTTP ' + status + '，但青龙业务响应未成功；' + safeLogResponse(obj, data), obj, status); return; }
      cb(null, obj, status);
    });
  }
  function token(cb, retry) {
    var st = readState(), now = Math.floor(Date.now() / 1000);
    if (st.token && Number(st.exp || 0) > now + 180) { cb(null, st.token); return; }
    if (!CFG.base || !/^https?:\/\//i.test(CFG.base) || !CFG.clientId || !CFG.clientSecret) { cb('请在插件参数中填写青龙 HTTPS 地址、Client ID 和 Client Secret'); return; }
    var path = '/open/auth/token?client_id=' + encodeURIComponent(CFG.clientId) + '&client_secret=' + encodeURIComponent(CFG.clientSecret);
    http('GET', path, null, null, function (err, obj) {
      if (err) { cb('获取青龙 Token 失败：' + err); return; }
      var d = obj && obj.data;
      if (!d || !d.token) { cb('Token 接口成功响应中没有 data.token'); return; }
      st.token = String(d.token); st.exp = Number(d.expiration || now + 25 * 86400); saveState(st);
      cb(null, st.token);
    });
  }
  function ql(method, path, body, cb, retried) {
    token(function (te, tk) {
      if (te) { cb(te); return; }
      http(method, path, body, tk, function (err, obj, status) {
        if (!retried && (status === 401 || (obj && (obj.code === 401 || obj.code === '401')))) {
          var st = readState(); delete st.token; delete st.exp; saveState(st);
          ql(method, path, body, cb, true); return;
        }
        cb(err, obj);
      });
    });
  }
  function arrayData(obj) {
    if (!obj || obj.data === undefined || obj.data === null) return [];
    if (Array.isArray(obj.data)) return obj.data;
    if (obj.data && Array.isArray(obj.data.data)) return obj.data.data;
    if (obj.data && Array.isArray(obj.data.list)) return obj.data.list;
    if (obj.data && Array.isArray(obj.data.files)) return obj.data.files;
    if (obj.data && Array.isArray(obj.data.envs)) return obj.data.envs;
    if (obj.data && Array.isArray(obj.data.items)) return obj.data.items;
    return [];
  }
  function mask(pin) { return pin.length > 4 ? pin.slice(0, 2) + '***' + pin.slice(-2) : '***'; }
  function envHasPin(value, pin) {
    var m = String(value || '').match(/(?:^|;)\s*pt_pin\s*=\s*([^;]+)/);
    return !!m && decode(m[1].trim()) === pin;
  }
  function upsertEnv(name, value, pin, cb) {
    ql('GET', '/open/envs?searchValue=' + encodeURIComponent(name), null, function (err, obj) {
      if (err) { cb('查询环境变量 ' + name + ' 失败：' + err); return; }
      var list = arrayData(obj), found = null;
      for (var i = 0; i < list.length; i++) if (list[i].name === name && envHasPin(list[i].value, pin)) { found = list[i]; break; }
      if (found) {
        var payload = { id: found.id, name: name, value: value };
        if (found.remarks !== undefined) payload.remarks = found.remarks;
        ql('PUT', '/open/envs', payload, function (e) {
          if (e) { cb('更新环境变量 ' + name + ' 失败：' + e); return; }
          var id = found.id;
          ql('PUT', '/open/envs/enable', [id], function (ee) {
            if (ee) { cb('变量已更新，但启用失败：' + ee); return; }
            cb(null, '更新');
          });
        });
      } else {
        ql('POST', '/open/envs', [{ name: name, value: value, remarks: pin }], function (e) {
          if (e) { cb('新增环境变量 ' + name + ' 失败：' + e); return; }
          cb(null, '新增');
        });
      }
    });
  }
  function quoteIni(v) {
    v = String(v);
    if (/[\s=;#"'\\]/.test(v)) return '"' + v.replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"';
    return v;
  }
  function patchIni(text, pin, key, value) {
    var newline = String(text).indexOf('\r\n') >= 0 ? '\r\n' : '\n';
    var lines = String(text || '').replace(/\r\n/g, '\n').split('\n');
    var begin = -1, end = lines.length, i, match;
    for (i = 0; i < lines.length; i++) {
      match = lines[i].match(/^\s*\[([^\]]+)\]\s*(?:[;#].*)?$/);
      if (match) {
        if (begin >= 0) { end = i; break; }
        if (match[1].trim() === pin) begin = i;
      }
    }
    var line = key + ' = ' + quoteIni(value);
    if (begin >= 0) {
      var replaced = false;
      for (i = begin + 1; i < end; i++) {
        match = lines[i].match(/^\s*(wskey|jskey)\s*=/i);
        if (match && match[1].toLowerCase() === key.toLowerCase()) { lines[i] = line; replaced = true; break; }
      }
      if (!replaced) {
        var at = end;
        while (at > begin + 1 && lines[at - 1] === '') at--;
        lines.splice(at, 0, line);
      }
    } else {
      while (lines.length && lines[lines.length - 1] === '') lines.pop();
      if (lines.length) lines.push('');
      lines.push('[' + pin + ']', 'pin = ' + quoteIni(pin), line);
    }
    return lines.join(newline).replace(/[\r\n]*$/, '') + newline;
  }
  function updateIni(pin, value, field, cb) {
    ql('GET', '/open/configs/files', null, function (e, obj) {
      if (e) { cb('读取配置文件列表失败：' + e); return; }
      var files = arrayData(obj), file = null;
      for (var i = 0; i < files.length; i++) {
        var candidates = [files[i].title, files[i].value, files[i].name, files[i].path];
        for (var j = 0; j < candidates.length; j++) if (str(candidates[j]).split('/').pop() === 'jdUser.ini') { file = files[i]; break; }
        if (file) break;
      }
      if (!file) { cb('配置文件列表没有 jdUser.ini（检查文件名及 configs 权限）'); return; }
      var path = str(file.value || file.path || file.title || file.name);
      ql('GET', '/open/configs/detail?path=' + encodeURIComponent(path), null, function (de, detail) {
        if (de) { cb('读取 jdUser.ini 详情失败：' + de); return; }
        var content = detail && detail.data;
        if (content && typeof content === 'object') content = content.content !== undefined ? content.content : (content.value !== undefined ? content.value : content);
        if (typeof content !== 'string') { cb('jdUser.ini 内容不是字符串，拒绝覆盖以防损坏文件'); return; }
        var changed;
        try { changed = patchIni(content, pin, field, value); } catch (ex) { cb('解析 jdUser.ini 失败：' + String(ex)); return; }
        if (changed === content) { cb(null, '已存在相同内容'); return; }
        ql('POST', '/open/configs/save', { name: path, content: changed }, function (se) {
          if (se) { cb('保存 jdUser.ini 失败：' + se); return; }
          // 保存后重新读取并校验，避免把接口接受请求误报成写入成功。
          ql('GET', '/open/configs/detail?path=' + encodeURIComponent(path), null, function (ve, verify) {
            if (ve) { cb('保存请求成功，但回读校验失败：' + ve); return; }
            var saved = verify && verify.data;
            if (saved && typeof saved === 'object') saved = saved.content !== undefined ? saved.content : saved.value;
            if (typeof saved !== 'string' || saved.indexOf(keyLine(field, value)) < 0) { cb('保存请求已返回成功，但回读未找到目标字段，不能确认写入'); return; }
            cb(null, '写入并回读校验成功');
          });
        });
      });
    });
  }
  function keyLine(k, v) { return k + ' = ' + quoteIni(v); }
  function process(app, creds, cb) {
    var pin = validPin(creds.pt_pin), ptKey = str(creds.pt_key), wskey = str(creds.wskey);
    var st = readState(), now = Math.floor(Date.now() / 1000);
    st.pins = st.pins || {}; st.pending = st.pending || {}; st.done = st.done || {};
    var appId = app + ':' + CFG.device;
    st.pins[appId] = st.pins[appId] || {};
    st.pending[appId] = st.pending[appId] || [];
    // 先保存 PIN 观察记录，不依赖 JD_COOKIE 上传开关。
    if (pin) st.pins[appId][pin] = now;
    var active = [];
    Object.keys(st.pins[appId]).forEach(function (p) {
      if (now - Number(st.pins[appId][p]) <= CFG.pinRecentSec) active.push(p);
      else delete st.pins[appId][p];
    });
    if (wskey && !pin) {
      if (active.length === 1) pin = active[0];
      else {
        st.pending[appId].push({ value: wskey, ts: now });
        st.pending[appId] = st.pending[appId].filter(function (x) { return now - x.ts <= CFG.pendingSec; }).slice(-4);
        saveState(st);
        log(appName(app) + ' 捕获到 wskey，但当前无法唯一确定 PIN，已暂存 5 分钟；不会猜账号');
        cb(null); return;
      }
    }
    if (pin && !wskey && st.pending[appId].length) {
      st.pending[appId] = st.pending[appId].filter(function (x) { return now - x.ts <= CFG.pendingSec; });
      if (st.pending[appId].length === 1 && active.length <= 1) wskey = st.pending[appId].shift().value;
      else if (st.pending[appId].length > 1) log('存在多条待配对 wskey，安全起见不自动配对');
    }
    saveState(st);
    if (!pin) { cb(null); return; }

    var tasks = [];
    if (app === 'jd' && CFG.jdCookie && ptKey) tasks.push({ id: 'JD_COOKIE', run: function (next) { upsertEnv('JD_COOKIE', 'pt_key=' + ptKey + ';pt_pin=' + pin + ';', pin, next); } });
    if (app === 'lite' && CFG.liteCookie && ptKey) tasks.push({ id: 'JD_COOKIE', run: function (next) { upsertEnv('JD_COOKIE', 'pt_key=' + ptKey + ';pt_pin=' + pin + ';', pin, next); } });
    if (app === 'jd' && wskey && CFG.jdWsck) tasks.push({ id: 'JD_WSCK', run: function (next) { upsertEnv('JD_WSCK', 'pin=' + pin + ';wskey=' + wskey + ';', pin, next); } });
    if (app === 'jd' && wskey && CFG.jdIni) tasks.push({ id: 'jdUser.ini[wskey]', run: function (next) { updateIni(pin, wskey, 'wskey', next); } });
    if (app === 'lite' && wskey && CFG.liteIni) tasks.push({ id: 'jdUser.ini[jskey]', run: function (next) { updateIni(pin, wskey, 'jskey', next); } });

    if (!tasks.length) {
      if (wskey) log(appName(app) + ' 检测到 wskey，但对应写入开关关闭');
      cb(null); return;
    }
    var errors = [], idx = 0;
    function nextTask() {
      if (idx >= tasks.length) {
        if (errors.length) {
          log(appName(app) + ' 同步存在失败：' + errors.join('；'));
          notify('京东同步失败', appName(app) + ' / PIN ' + mask(pin), errors.join('\n'));
        }
        cb(errors.length ? errors.join('；') : null); return;
      }
      var task = tasks[idx++];
      task.run(function (e, action) {
        if (e) { errors.push(task.id + '：' + e); log(task.id + ' 失败：' + e); }
        else log(appName(app) + ' ' + task.id + ' 成功' + (action ? '（' + action + '）' : '') + '，PIN=' + mask(pin));
        nextTask();
      });
    }
    nextTask();
  }
  function appName(a) { return a === 'lite' ? '京东特价版' : '京东主 App'; }
  function runTest() {
    if (!CFG.base || !CFG.clientId || !CFG.clientSecret) { log('请填写青龙连接参数'); finish(); return; }
    ql('GET', '/open/envs?searchValue=JD_COOKIE', null, function (e) {
      if (e) { log('青龙环境变量接口测试失败：' + e); finish(); return; }
      ql('GET', '/open/configs/files', null, function (ce, obj) {
        if (ce) { log('环境变量权限正常；配置文件接口失败：' + ce); finish(); return; }
        var names = arrayData(obj).map(function (x) { return str(x.title || x.value || x.name || x.path); });
        log('连接测试通过：Token、envs、configs 均可用；jdUser.ini=' + (names.some(function (n) { return n.split('/').pop() === 'jdUser.ini'; }) ? '已找到' : '未找到'));
        finish();
      });
    });
  }

  try {
    if (typeof $request === 'undefined' || !$request || !$request.url) { runTest(); return; }
    var url = str($request.url);
    if (!/^https?:\/\/(?:[^/]+\.)?jd\.com\//i.test(url)) { finish(); return; }
    var h = $request.headers || {};
    var app = detectApp(h);
    if (app === 'unknown') { finish(); return; }
    if ((app === 'jd' && !CFG.captureJD) || (app === 'lite' && !CFG.captureLite)) { finish(); return; }
    var c = cookieMap(h);
    var creds = { pt_key: c.pt_key || '', pt_pin: c.pt_pin || '', wskey: c.wskey || '' };
    var hasCookie = !!(creds.pt_key || creds.pt_pin || creds.wskey);
    if (!hasCookie) { finish(); return; }
    // 即使 Cookie 上传关闭，仍处理 PIN/WSKEY 识别与配对，确保各写入开关真正独立。
    log(appName(app) + ' 请求命中；pt_key=' + (creds.pt_key ? '有' : '无') + '；pt_pin=' + (validPin(creds.pt_pin) ? '有' : '无') + '；wskey=' + (creds.wskey ? '有' : '无'));
    process(app, creds, function () { finish(); });
  } catch (e) {
    log('脚本异常：' + String(e).slice(0, 180)); finish();
  }
})();
