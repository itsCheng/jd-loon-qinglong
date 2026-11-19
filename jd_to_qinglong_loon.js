/*
 * 京东 CK 自动同步到青龙 - Loon 独立重构版（同 PIN 新增/覆盖逻辑修正版）
 * 主 App: pt_key/pt_pin -> JD_COOKIE；wskey -> JD_WSCK（可独立关闭）及 jdUser.ini[wskey]
 * 特价版: pt_key/pt_pin -> JD_COOKIE（可独立关闭）；wskey -> jdUser.ini[jskey]（可独立关闭）
 * JD_COOKIE 按 pt_pin 匹配；JD_WSCK 按 pin 匹配；jdUser.ini 按 [PIN] 区段新增/覆盖目标字段。
 * 所有青龙请求只访问用户配置的 QL_URL，并固定 DIRECT；不含 PHP 中转、遥测或第三方上传。
 */
(function () {
  'use strict';

  var VERSION = '2.0.6';
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
    var code = obj && obj.code !== undefined ? String(obj.code) : '未提供';
    var msg = obj ? str(obj.message || obj.msg || obj.error) : '';
    var keys = obj && typeof obj === 'object' ? Object.keys(obj).slice(0, 8).join(',') : '';
    return '业务code=' + code + (msg ? '，message=' + msg.slice(0, 100) : '') + (keys ? '，响应字段=' + keys : '');
  }
  function parseBody(data) {
    // Loon 不同版本/响应类型下，第三个回调参数可能是文本、对象，
    // 也可能为空而正文实际挂在 response.body。统一提取真正的 JSON 正文。
    if (data === null || data === undefined) return null;
    if (typeof data === 'string') {
      var raw = data.replace(/^\uFEFF/, '').trim();
      if (!raw) return null;
      try { return JSON.parse(raw); } catch (e) { return null; }
    }
    if (typeof data === 'object') {
      if (Array.isArray(data)) return data;
      if (Object.prototype.hasOwnProperty.call(data, 'code') ||
          Object.prototype.hasOwnProperty.call(data, 'data') ||
          Object.prototype.hasOwnProperty.call(data, 'message') ||
          Object.prototype.hasOwnProperty.call(data, 'msg')) return data;
      if (typeof data.body === 'string') return parseBody(data.body);
      if (typeof data.responseText === 'string') return parseBody(data.responseText);
      if (typeof data.text === 'string') return parseBody(data.text);
      // 不把 Loon 的空响应包装对象误当成业务 JSON。
      if (Object.keys(data).length === 0) return null;
      return data;
    }
    return null;
  }
  function responseObject(resp, data) {
    var obj = parseBody(data);
    if (obj !== null) return obj;
    if (resp) {
      obj = parseBody(resp.body);
      if (obj !== null) return obj;
      obj = parseBody(resp.data);
      if (obj !== null) return obj;
      obj = parseBody(resp.responseText);
      if (obj !== null) return obj;
    }
    return null;
  }
  function apiSuccess(httpStatus, obj) {
    // HTTP 层只判断传输状态及明确的业务失败。青龙 2.19.2 的部分接口
    // 可能返回不带顶层 code 的 JSON；不能因此误判失败，也不能仅凭 200 宣告成功。
    if (httpStatus < 200 || httpStatus >= 300 || !obj || typeof obj !== 'object') return false;
    if (!Object.prototype.hasOwnProperty.call(obj, 'code')) return true; // 仅放行到接口级结构校验；列表/Token/详情均必须有有效数据
    var code = obj.code;
    if (code === 200 || code === 0 || code === '200' || code === '0') return true;
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
      var obj = responseObject(resp, data);
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
    if (Array.isArray(obj)) return obj;
    if (!obj || obj.data === undefined || obj.data === null) return [];
    if (Array.isArray(obj.data)) return obj.data;
    if (obj.data && Array.isArray(obj.data.data)) return obj.data.data;
    if (obj.data && Array.isArray(obj.data.list)) return obj.data.list;
    if (obj.data && Array.isArray(obj.data.files)) return obj.data.files;
    if (obj.data && Array.isArray(obj.data.envs)) return obj.data.envs;
    if (obj.data && Array.isArray(obj.data.items)) return obj.data.items;
    if (Array.isArray(obj.files)) return obj.files;
    if (Array.isArray(obj.list)) return obj.list;
    if (Array.isArray(obj.items)) return obj.items;
    return [];
  }
  function mask(pin) { return pin.length > 4 ? pin.slice(0, 2) + '***' + pin.slice(-2) : '***'; }
  function envHasPin(name, value, pin) {
    // JD_COOKIE 使用 pt_pin；JD_WSCK 使用 pin。两者格式不同，必须分别匹配。
    var key = name === 'JD_WSCK' ? 'pin' : 'pt_pin';
    var re = new RegExp('(?:^|;)\\s*' + key + '\\s*=\\s*([^;]+)', 'i');
    var m = String(value || '').match(re);
    return !!m && decode(m[1].trim()).replace(/^['"]|['"]$/g, '') === pin;
  }
  function upsertEnv(name, value, pin, cb) {
    ql('GET', '/open/envs?searchValue=' + encodeURIComponent(name), null, function (err, obj) {
      if (err) { cb('查询环境变量 ' + name + ' 失败：' + err); return; }
      var list = arrayData(obj), found = [];
      for (var i = 0; i < list.length; i++) {
        if (list[i] && list[i].name === name && envHasPin(name, list[i].value, pin) && list[i].id !== undefined) found.push(list[i]);
      }
      if (found.length) {
        // 历史上若已有重复的同名同 PIN 项，全部更新，避免保留旧凭据。
        var index = 0, failed = false;
        function updateNext() {
          if (index >= found.length) { cb(failed ? '部分同 PIN 环境变量更新/启用失败' : null, '更新'); return; }
          var item = found[index++];
          var payload = { id: item.id, name: name, value: value };
          if (item.remarks !== undefined) payload.remarks = item.remarks;
          ql('PUT', '/open/envs', payload, function (e) {
            if (e) { failed = true; log('更新同 PIN 变量 id=' + item.id + ' 失败：' + e); updateNext(); return; }
            ql('PUT', '/open/envs/enable', [item.id], function (ee) {
              if (ee) { failed = true; log('启用变量 id=' + item.id + ' 失败：' + ee); }
              updateNext();
            });
          });
        }
        updateNext();
      } else {
        ql('POST', '/open/envs', [{ name: name, value: value, remarks: pin }], function (e) {
          if (e) { cb('新增环境变量 ' + name + ' 失败：' + e); return; }
          cb(null, '新增');
        });
      }
    });
  }
  function patchIni(text, pin, key, value) {
    // 只改目标 PIN 区段中的目标字段；没有 PIN 则追加新区段；没有字段则在该区段补入。字段写为 key=value，不改写 wskey/jskey 原值。
    // 其余账号、注释、空行及字段内容保留。使用文件原有主要换行符。
    text = String(text);
    var newline = text.indexOf('\r\n') >= 0 ? '\r\n' : (text.indexOf('\r') >= 0 && text.indexOf('\n') < 0 ? '\r' : '\n');
    var lines = text.split(/\r\n|\n|\r/);
    var begins = [], i, m;
    for (i = 0; i < lines.length; i++) {
      m = lines[i].match(/^\s*\[([^\]]+)\]\s*(?:[;#].*)?$/);
      if (m && m[1].trim() === pin) begins.push(i);
    }
    if (begins.length > 1) throw new Error('jdUser.ini 存在重复 PIN 区段 [' + pin + ']，为避免改错账号已停止');
    var line = key + '=' + String(value);
    if (begins.length === 1) {
      var begin = begins[0], end = lines.length;
      for (i = begin + 1; i < lines.length; i++) {
        if (/^\s*\[[^\]]+\]\s*(?:[;#].*)?$/.test(lines[i])) { end = i; break; }
      }
      var matches = [], keyRe = new RegExp('^\\s*' + key + '\\s*=', 'i');
      for (i = begin + 1; i < end; i++) if (keyRe.test(lines[i])) matches.push(i);
      if (matches.length) {
        lines[matches[0]] = line;
        for (i = matches.length - 1; i >= 1; i--) lines.splice(matches[i], 1);
      } else {
        var at = end;
        while (at > begin + 1 && lines[at - 1] === '') at--;
        lines.splice(at, 0, line);
      }
    } else {
      while (lines.length && lines[lines.length - 1] === '') lines.pop();
      if (lines.length) lines.push('');
      lines.push('[' + pin + ']', 'pin=' + pin, line);
    }
    return lines.join(newline);
  }
  function extractConfigText(obj, depth) {
    depth = depth || 0;
    if (typeof obj === 'string') {
      var t = obj.replace(/^\uFEFF/, '');
      try { var parsed = JSON.parse(t); if (typeof parsed === 'string') return parsed; } catch (e) {}
      return t;
    }
    if (!obj || typeof obj !== 'object' || depth > 5) return null;
    var keys = ['content', 'value', 'data', 'body', 'text'];
    for (var i = 0; i < keys.length; i++) if (Object.prototype.hasOwnProperty.call(obj, keys[i])) {
      var found = extractConfigText(obj[keys[i]], depth + 1);
      if (typeof found === 'string') return found;
    }
    return null;
  }
  function iniHasValue(text, pin, field, value) {
    var lines = String(text).split(/\r\n|\n|\r/), section = -1, end = lines.length, i, m;
    for (i = 0; i < lines.length; i++) {
      m = lines[i].match(/^\s*\[([^\]]+)\]\s*(?:[;#].*)?$/);
      if (m && m[1].trim() === pin) { section = i; break; }
    }
    if (section < 0) return false;
    for (i = section + 1; i < lines.length; i++) if (/^\s*\[[^\]]+\]\s*(?:[;#].*)?$/.test(lines[i])) { end = i; break; }
    for (i = section + 1; i < end; i++) {
      m = lines[i].match(new RegExp('^\\s*' + field + '\\s*=\\s*(.*?)\\s*$', 'i'));
      if (m) {
        var actual = m[1].trim().replace(/^"(.*)"$/, '$1').replace(/\\(["\\])/g, '$1');
        if (actual === String(value)) return true;
      }
    }
    return false;
  }
  function updateIni(pin, value, field, cb) {
    // 不再依赖 /open/configs/files 列表接口。
    // 青龙 OpenAPI 同时提供 /open/configs/{file} 读取指定配置文件，
    // 直接读取 jdUser.ini，避免列表响应结构差异导致整个写入流程中断。
    var path = 'jdUser.ini';
    var readPath = '/open/configs/' + encodeURIComponent(path);
    ql('GET', readPath, null, function (e, detail) {
      if (e) { cb('直接读取 jdUser.ini 失败：' + e); return; }
      var content = extractConfigText(detail);
      if (typeof content !== 'string') {
        cb('青龙未返回 jdUser.ini 字符串正文，已停止写入保护原文件；响应字段=' +
          (detail && typeof detail === 'object' ? Object.keys(detail).join(',') : typeof detail));
        return;
      }
      var changed;
      try { changed = patchIni(content, pin, field, value); }
      catch (ex) { cb('解析 jdUser.ini 失败：' + String(ex)); return; }
      if (changed === content) { cb(null, '已存在相同内容'); return; }
      ql('POST', '/open/configs/save', { name: path, content: changed }, function (se) {
        if (se) { cb('保存 jdUser.ini 失败：' + se); return; }
        // 保存后仍通过指定文件接口回读；未验证目标 PIN/字段前绝不报告成功。
        ql('GET', readPath, null, function (ve, verify) {
          if (ve) { cb('保存请求成功，但回读校验失败：' + ve); return; }
          var saved = extractConfigText(verify);
          if (typeof saved !== 'string' || !iniHasValue(saved, pin, field, value)) {
            cb('保存请求已返回成功，但回读未找到目标 PIN 的目标字段，不能确认写入'); return;
          }
          cb(null, '写入并回读校验成功');
        });
      });
    });
  }
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
      ql('GET', '/open/configs/' + encodeURIComponent('jdUser.ini'), null, function (ce, obj) {
        if (ce) { log('环境变量权限正常；直接读取 jdUser.ini 失败：' + ce); finish(); return; }
        var content = extractConfigText(obj);
        log(typeof content === 'string' ? '连接测试通过：Token、envs、jdUser.ini 读取均正常' : 'Token、envs 正常，但 jdUser.ini 响应没有字符串正文；响应字段=' + (obj && typeof obj === 'object' ? Object.keys(obj).join(',') : typeof obj));
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
