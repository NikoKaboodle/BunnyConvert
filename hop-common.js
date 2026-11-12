/* ============================================================
   HopConvert shared runtime — hop-common.js
   ------------------------------------------------------------
   Loaded on every page. Provides two things:

   1. HopPrivacy — a verifiable privacy audit.
      Records every network request the page makes, records the
      HTTP method of every fetch()/XHR call, watches for the
      moment user data enters the page, and then reports exactly
      what happened. The report is generated in the browser from
      the browser's own Performance API — nothing is sent
      anywhere to produce it.

   2. HopFilter — a small jq-style filter for JSON input.
      Supports `.field`, `.a.b`, `.[0]`, `.[]`, `select(...)`
      and `|` pipelines.

   No dependencies. No network calls. Works from file:// too.
   ============================================================ */
(function (global) {
  'use strict';

  /* =========================================================
     HopPrivacy
     ========================================================= */
  var Privacy = (function () {

    var resources = [];   // every network resource the page loaded
    var calls = [];       // every fetch()/XHR call, with its HTTP method
    var dataAt = null;    // performance.now() when user data entered the page
    var seen = Object.create(null);
    var listeners = [];

    function now() {
      return (global.performance && global.performance.now) ? global.performance.now() : Date.now();
    }

    function pushResource(e) {
      var key = e.name + '|' + e.startTime;
      if (seen[key]) return;
      seen[key] = 1;
      resources.push({
        url: e.name,
        type: e.initiatorType || 'other',
        start: e.startTime,
        ms: Math.round(e.duration || 0),
        size: e.transferSize || e.encodedBodySize || 0
      });
    }

    // --- Capture every subresource: scripts, css, images, fonts, fetch, xhr ---
    if (global.PerformanceObserver) {
      try {
        var po = new PerformanceObserver(function (list) {
          list.getEntries().forEach(pushResource);
        });
        po.observe({ type: 'resource', buffered: true });
      } catch (e) { /* fall through to the manual sweep below */ }
    }
    try {
      (global.performance.getEntriesByType('resource') || []).forEach(pushResource);
    } catch (e) { /* no Performance API — report will show zero resources */ }

    // PerformanceResourceTiming does not expose the HTTP method, so wrap
    // fetch() and XMLHttpRequest to record it. Your data can only be
    // transmitted by a request that is not a GET/HEAD, so the method is
    // exactly the signal we need.
    if (typeof global.fetch === 'function') {
      var nativeFetch = global.fetch;
      global.fetch = function (input, init) {
        try {
          var url = typeof input === 'string' ? input : ((input && input.url) || String(input));
          var method = (init && init.method) || (input && input.method) || 'GET';
          var hasBody = !!(init && init.body) ||
            (input && typeof input !== 'string' && input.body !== undefined && input.body !== null);
          calls.push({ method: String(method).toUpperCase(), url: String(url), body: hasBody, at: now() });
        } catch (e) { /* never let instrumentation break the page */ }
        return nativeFetch.apply(this, arguments);
      };
    }

    if (global.XMLHttpRequest && global.XMLHttpRequest.prototype) {
      var proto = global.XMLHttpRequest.prototype;
      var origOpen = proto.open;
      var origSend = proto.send;
      proto.open = function (method, url) {
        this.__hopMethod = String(method || 'GET').toUpperCase();
        this.__hopUrl = String(url || '');
        return origOpen.apply(this, arguments);
      };
      proto.send = function (body) {
        calls.push({
          method: this.__hopMethod || 'GET',
          url: this.__hopUrl || '',
          body: body !== undefined && body !== null,
          at: now()
        });
        return origSend.apply(this, arguments);
      };
    }

    /* --- Detect when user data enters the page --- */
    function isDataField(t) {
      if (!t || !t.closest) return false;
      if (!t.closest('.converter, [data-privacy-zone]')) return false;
      // Controls explicitly marked as not carrying user data (the jq filter
      // box, for example) must not trigger the "data entered" state.
      if (t.closest('[data-privacy-ignore]')) return false;
      if (t.tagName === 'TEXTAREA') return true;
      if (t.isContentEditable) return true;
      if (t.tagName === 'INPUT') {
        var ty = (t.type || 'text').toLowerCase();
        // Buttons and toggles never carry data. Everything else might —
        // a number, email or date field can hold user data just as well as
        // a text field, so we cannot whitelist by type.
        if (ty === 'button' || ty === 'submit' || ty === 'reset' ||
            ty === 'checkbox' || ty === 'radio' || ty === 'image') return false;
        return true;
      }
      return false;
    }

    function markData(reason) {
      if (dataAt === null) {
        dataAt = now();
        listeners.forEach(function (fn) { try { fn('data', reason); } catch (e) {} });
      }
    }

    document.addEventListener('input', function (e) {
      if (isDataField(e.target)) markData('input');
    }, true);

    document.addEventListener('paste', function (e) {
      if (isDataField(e.target)) markData('paste');
    }, true);

    document.addEventListener('change', function (e) {
      if (isDataField(e.target)) markData('change');
    }, true);

    document.addEventListener('drop', function (e) {
      if (e.target && e.target.closest && e.target.closest('.converter, [data-privacy-zone]')) {
        markData('drop');
      }
    }, true);

    /* --- Build the audit report --- */
    function urlParts(u) {
      try {
        var p = new URL(u, global.location.href);
        return { origin: p.origin, path: p.pathname };
      } catch (e) {
        return { origin: String(u || ''), path: '' };
      }
    }

    // A call is identified by method + origin + path. The path is used rather
    // than the full URL so that a tracking parameter changing between two
    // otherwise identical requests does not look like a brand new request.
    function callKey(c) {
      var p = urlParts(c.url);
      return c.method + '|' + p.origin + '|' + p.path;
    }

    function pathKey(u) {
      var p = urlParts(u);
      return p.origin + '|' + p.path;
    }

    function report() {
      var afterData = dataAt === null ? [] : resources.filter(function (r) { return r.start >= dataAt; });
      var callsAfter = dataAt === null ? [] : calls.filter(function (c) { return c.at >= dataAt; });

      // Baseline: everything the page had already requested before any user
      // data arrived. Only requests that are NEW after that point are ones we
      // cannot vouch for — the page's own fonts, styles and ad frames are
      // part of the baseline and stay harmless.
      var baseline = Object.create(null);
      if (dataAt !== null) {
        calls.forEach(function (c) {
          if (c.at < dataAt) baseline[callKey(c)] = 1;
        });
        resources.forEach(function (r) {
          if (r.start < dataAt) baseline[pathKey(r.url)] = 1;
        });
      }

      // A request that could carry your data: anything that is not GET/HEAD,
      // or that sends a request body.
      var uploads = callsAfter.filter(function (c) {
        return (c.method !== 'GET' && c.method !== 'HEAD') || c.body;
      });

      // A GET or HEAD can still carry data in the URL — for example when you
      // paste a URL for the page to fetch. Only requests the page had already
      // made before your data arrived are treated as safe.
      var urlLeaks = callsAfter.filter(function (c) {
        if (c.method !== 'GET' && c.method !== 'HEAD') return false;
        return !baseline[callKey(c)] && !baseline[pathKey(c.url)];
      });

      var risky = uploads.concat(urlLeaks);

      return {
        ok: risky.length === 0,
        dataEntered: dataAt !== null,
        uploads: uploads,
        urlLeaks: urlLeaks,
        requestsAfterData: afterData,
        callsAfterData: callsAfter,
        totalResources: resources.length,
        totalCalls: calls.length,
        resources: resources.slice().sort(function (a, b) { return a.start - b.start; })
      };
    }

    function onChange(fn) { listeners.push(fn); }

    return {
      report: report,
      onChange: onChange,
      markData: markData,
      get dataAt() { return dataAt; }
    };
  })();

  /* =========================================================
     HopFilter — a small jq-style filter
     ========================================================= */
  var Filter = (function () {

    var OPS = ['>=', '<=', '==', '!=', '>', '<'];

    function splitPipeline(expr) {
      var parts = [], buf = '', depth = 0, quote = null;
      for (var i = 0; i < expr.length; i++) {
        var c = expr[i];
        if (quote) {
          buf += c;
          if (c === quote && expr[i - 1] !== '\\') quote = null;
          continue;
        }
        if (c === '"' || c === "'") { quote = c; buf += c; continue; }
        if (c === '(') depth++;
        if (c === ')') depth--;
        if (c === '|' && depth === 0) { parts.push(buf); buf = ''; continue; }
        buf += c;
      }
      parts.push(buf);
      return parts.map(function (p) { return p.trim(); }).filter(function (p) { return p !== ''; });
    }

    function parsePathOps(src) {
      var ops = [], i = 0;
      while (i < src.length) {
        var c = src[i];
        if (c === '[') {
          var j = src.indexOf(']', i);
          if (j < 0) break;
          var inner = src.slice(i + 1, j).trim();
          if (inner === '') ops.push({ t: 'each' });
          else if (/^-?\d+$/.test(inner)) ops.push({ t: 'idx', v: parseInt(inner, 10) });
          else ops.push({ t: 'key', v: stripQuotes(inner) });
          i = j + 1;
          continue;
        }
        if (c === '.') {
          i++;
          if (src[i] === '[') continue;      // handled by the [ branch
          if (src[i] === '"' || src[i] === "'") {
            var q = src[i], k = '';
            i++;
            while (i < src.length && src[i] !== q) { k += src[i]; i++; }
            i++;                            // closing quote
            ops.push({ t: 'key', v: k });
            continue;
          }
          var name = '';
          while (i < src.length && /[A-Za-z0-9_\-]/.test(src[i])) { name += src[i]; i++; }
          if (name) ops.push({ t: 'key', v: name });
          continue;
        }
        i++;
      }
      return ops;
    }

    function stripQuotes(s) {
      s = String(s).trim();
      if ((s[0] === '"' && s[s.length - 1] === '"') || (s[0] === "'" && s[s.length - 1] === "'")) {
        return s.slice(1, -1);
      }
      return s;
    }

    function parseLiteral(raw) {
      var s = String(raw).trim();
      if (s === '') return '';
      if ((s[0] === '"' && s[s.length - 1] === '"') || (s[0] === "'" && s[s.length - 1] === "'")) {
        return s.slice(1, -1);
      }
      if (s === 'true') return true;
      if (s === 'false') return false;
      if (s === 'null') return null;
      if (/^-?\d+(\.\d+)?$/.test(s)) return parseFloat(s);
      return s;
    }

    /**
     * Find the first comparison operator that appears OUTSIDE a quoted
     * value, so `select(.s != "a == b")` still reads `!=`.
     */
    function findOperator(body) {
      var quote = null;
      for (var i = 0; i < body.length; i++) {
        var c = body.charAt(i);
        if (quote) { if (c === quote) quote = null; continue; }
        if (c === '"' || c === "'") { quote = c; continue; }
        for (var k = 0; k < OPS.length; k++) {
          if (body.substr(i, OPS[k].length) === OPS[k]) return { op: OPS[k], at: i };
        }
      }
      return { op: null, at: -1 };
    }

    function parseStage(stage) {
      var m = /^\s*select\s*\(([\s\S]*)\)\s*$/i.exec(stage);
      if (m) {
        var body = m[1].trim();
        var found = findOperator(body);
        var om = found.op, path = null, value = null;
        if (om) {
          path = body.slice(0, found.at).trim();
          value = body.slice(found.at + om.length).trim();
          // An unterminated string would compare against the stray quote and
          // silently match nothing. Fail loudly instead.
          var q = value.charAt(0);
          if ((q === '"' || q === "'") && (value.length < 2 || value.charAt(value.length - 1) !== q)) {
            throw new Error('Unterminated string in select(...)');
          }
        } else {
          path = body;
        }
        return { type: 'select', path: path, op: om, value: parseLiteral(value) };
      }
      return { type: 'path', ops: parsePathOps(stage) };
    }

    function readPath(item, path) {
      var ops = parsePathOps(path);
      var v = item;
      for (var i = 0; i < ops.length; i++) {
        if (v === null || v === undefined) return undefined;
        if (ops[i].t === 'key') {
          if (typeof v !== 'object') return undefined;
          v = v[ops[i].v];
        } else if (ops[i].t === 'idx') {
          if (!Array.isArray(v)) return undefined;
          v = v[ops[i].v];
        } else if (ops[i].t === 'each') {
          if (!Array.isArray(v)) return undefined;
          v = v[0];
        }
      }
      return v;
    }

    function looseEq(a, b) {
      if (a === b) return true;
      if (a === null || a === undefined) return b === null || b === undefined;
      if (typeof a === 'number' && typeof b === 'string') return String(a) === b;
      if (typeof a === 'string' && typeof b === 'number') return a === String(b);
      return String(a) === String(b);
    }

    function toNum(v) {
      var n = parseFloat(v);
      return isNaN(n) ? NaN : n;
    }

    function testCond(item, stage) {
      var v = readPath(item, stage.path);
      if (!stage.op) return v !== undefined && v !== null;
      switch (stage.op) {
        case '==': return looseEq(v, stage.value);
        case '!=': return !looseEq(v, stage.value);
        case '>': return toNum(v) > toNum(stage.value);
        case '>=': return toNum(v) >= toNum(stage.value);
        case '<': return toNum(v) < toNum(stage.value);
        case '<=': return toNum(v) <= toNum(stage.value);
        default: return true;
      }
    }

    function applyPath(input, ops) {
      var cur = [input];
      for (var o = 0; o < ops.length; o++) {
        var op = ops[o];
        var next = [];
        for (var i = 0; i < cur.length; i++) {
          var v = cur[i];
          if (v === null || v === undefined) continue;
          if (op.t === 'key') {
            if (Array.isArray(v)) {
              for (var k = 0; k < v.length; k++) {
                var e = v[k];
                if (e && typeof e === 'object' && !Array.isArray(e)) next.push(e[op.v]);
              }
            } else if (typeof v === 'object') {
              next.push(v[op.v]);
            }
          } else if (op.t === 'idx') {
            if (Array.isArray(v)) next.push(v[op.v]);
          } else if (op.t === 'each') {
            if (Array.isArray(v)) { for (var a = 0; a < v.length; a++) next.push(v[a]); }
            else next.push(v);
          }
        }
        cur = next;
      }
      return cur;
    }

    /**
     * Apply a jq-lite expression to parsed JSON.
     * Always returns an array of results (empty array when nothing matched).
     */
    function apply(data, expr) {
      var text = String(expr || '').trim();
      if (text === '') return Array.isArray(data) ? data : [data];

      var stages = splitPipeline(text);
      var value = data;

      for (var s = 0; s < stages.length; s++) {
        var st = parseStage(stages[s]);
        if (st.type === 'select') {
          var items = Array.isArray(value) ? value : [value];
          value = items.filter(function (it) { return testCond(it, st); });
        } else {
          value = applyPath(value, st.ops);
        }
        // jq semantics: a single result that is itself an array expands to its
        // elements, so `.rows` on {"rows":[...]} yields the rows themselves
        // and a following `select(...)` filters those rows.
        if (Array.isArray(value) && value.length === 1 && Array.isArray(value[0])) {
          value = value[0];
        }
      }

      if (value === undefined || value === null) return [];
      return Array.isArray(value) ? value : [value];
    }

    /** Validate an expression, returning null when OK or an error message. */
    function validate(expr) {
      var text = String(expr || '').trim();
      if (text === '') return null;
      var stages = splitPipeline(text);
      for (var i = 0; i < stages.length; i++) {
        var st = stages[i];
        if (/^\s*select\s*\(/i.test(st)) {
          if (!/\)\s*$/.test(st)) return 'Unclosed parentheses in select(...)';
          var body = st.replace(/^\s*select\s*\(/i, '').replace(/\)\s*$/, '');
          if (!body.trim()) return 'select(...) needs a condition, e.g. select(.status == "ok")';
          // An unterminated string must be reported, not silently ignored.
          var found = findOperator(body);
          if (found.op) {
            var lit = body.slice(found.at + found.op.length).trim();
            var q = lit.charAt(0);
            if ((q === '"' || q === "'") && (lit.length < 2 || lit.charAt(lit.length - 1) !== q)) {
              return 'Unterminated string in select(...)';
            }
          }
        } else if (!/^[\s.[\]A-Za-z0-9_\-"']*$/.test(st)) {
          return 'Unsupported character in "' + st + '"';
        }
      }
      return null;
    }

    return {
      apply: apply,
      validate: validate,
      syntax: '.field  ·  .a.b  ·  .[0]  ·  .[]  ·  select(.f == "x")  ·  |  to chain stages'
    };
  })();

  /* =========================================================
     Privacy check UI
     ========================================================= */
  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  function shortUrl(u) {
    try {
      var parsed = new URL(u, global.location.href);
      var host = parsed.hostname.replace(/^www\./, '');
      var path = parsed.pathname === '/' ? '' : parsed.pathname;
      var s = host + path;
      if (parsed.search) s += '?…';
      return s.length > 64 ? s.slice(0, 61) + '…' : s;
    } catch (e) {
      return String(u).length > 64 ? String(u).slice(0, 61) + '…' : String(u);
    }
  }

  function fmtBytes(n) {
    if (!n) return '—';
    if (n < 1024) return n + ' B';
    if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
    return (n / 1024 / 1024).toFixed(2) + ' MB';
  }

  function renderReport(rep) {
    var ok = rep.ok;

    var verdict = ok
      ? '<div class="pv-verdict pv-ok">' +
          '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/><polyline points="9 12 11 14 15.5 9.5"/></svg>' +
          '<div><strong>Your data never left this browser.</strong>' +
          '<p>' + (rep.dataEntered
            ? 'Since you pasted your data, this page made <strong>0 requests that could carry it</strong>. Every request listed below is one the page made on its own — fonts, styles, scripts and ad frames.'
            : 'No request on this page can carry your data. Paste or upload something, then re-check to see the live count.') +
          '</p></div></div>'
      : '<div class="pv-verdict pv-warn">' +
          '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>' +
          '<div><strong>Something on this page sent a request after your data arrived.</strong>' +
          '<p>' + rep.uploads.length + ' upload request(s) and ' + rep.urlLeaks.length +
          ' new request(s) were made after your data entered the page. They are listed below — none are HopConvert converters.</p></div></div>';

    var stats =
      '<div class="pv-stats">' +
        '<div class="pv-stat"><span class="pv-stat-value">' + (rep.uploads.length + rep.urlLeaks.length) + '</span><span class="pv-stat-label">Requests that could carry your data</span></div>' +
        '<div class="pv-stat"><span class="pv-stat-value">' + rep.requestsAfterData.length + '</span><span class="pv-stat-label">Requests since your data arrived</span></div>' +
        '<div class="pv-stat"><span class="pv-stat-value">' + rep.totalResources + '</span><span class="pv-stat-label">Total page requests</span></div>' +
      '</div>';

    var rows = '';
    if (rep.resources.length === 0) {
      rows = '<tr><td colspan="4" class="pv-empty">No network requests recorded.</td></tr>';
    } else {
      rep.resources.forEach(function (r) {
        rows += '<tr>' +
          '<td><span class="pv-tag">' + escapeHtml(r.type) + '</span></td>' +
          '<td class="pv-url">' + escapeHtml(shortUrl(r.url)) + '</td>' +
          '<td class="pv-num">' + fmtBytes(r.size) + '</td>' +
          '<td class="pv-num">' + r.ms + ' ms</td>' +
        '</tr>';
      });
    }

    var table =
      '<table class="pv-table">' +
        '<thead><tr><th>Type</th><th>Request</th><th>Size</th><th>Time</th></tr></thead>' +
        '<tbody>' + rows + '</tbody>' +
      '</table>';

    var note =
      '<p class="pv-note">This report is generated live in your browser using the browser\'s own Performance API. ' +
      'Nothing is sent to HopConvert (or anywhere else) to produce it. Requests to Google\'s ad network may appear — ' +
      'they are ad delivery and never contain anything you typed.</p>';

    return verdict + stats +
      '<h4 class="pv-h4">Every network request this page made</h4>' + table + note;
  }

  function buildModal() {
    if (document.getElementById('privacyModal')) return document.getElementById('privacyModal');
    var backdrop = document.createElement('div');
    backdrop.className = 'modal-backdrop';
    backdrop.id = 'privacyModal';
    backdrop.setAttribute('role', 'dialog');
    backdrop.setAttribute('aria-modal', 'true');
    backdrop.setAttribute('aria-labelledby', 'privacyModalTitle');
    backdrop.innerHTML =
      '<div class="modal modal-lg">' +
        '<div class="modal-header">' +
          '<h3 id="privacyModalTitle">Privacy check — live in your browser</h3>' +
          '<button class="icon-btn" id="closePrivacy" aria-label="Close privacy check">' +
            '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>' +
          '</button>' +
        '</div>' +
        '<div class="modal-body" id="privacyBody"></div>' +
        '<div class="modal-foot">' +
          '<button class="btn btn-secondary" id="closePrivacyFoot" type="button">Close</button>' +
          '<button class="btn btn-primary" id="refreshPrivacy" type="button">Re-run check</button>' +
        '</div>' +
      '</div>';
    document.body.appendChild(backdrop);
    return backdrop;
  }

  function openPrivacy() {
    var modal = buildModal();
    var body = document.getElementById('privacyBody');
    if (body) body.innerHTML = renderReport(Privacy.report());
    modal.classList.add('visible');
  }

  function closePrivacy() {
    var modal = document.getElementById('privacyModal');
    if (modal) modal.classList.remove('visible');
  }

  var TRIGGER_SVG =
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/><polyline points="9 12 11 14 15.5 9.5"/></svg>';

  function makeTrigger() {
    var btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'trust-item trust-verify';
    btn.id = 'privacyVerifyBtn';
    btn.setAttribute('aria-haspopup', 'dialog');
    btn.innerHTML = TRIGGER_SVG + ' Verify: nothing uploaded';
    btn.addEventListener('click', openPrivacy);
    return btn;
  }

  function initTrigger() {
    if (document.getElementById('privacyVerifyBtn')) return;

    // Preferred home: the trust strip on converter pages.
    var trust = document.querySelector('.trust');
    if (trust) {
      trust.appendChild(makeTrigger());
      return;
    }

    // Otherwise: an explicit slot on the page.
    var slot = document.querySelector('[data-privacy-verify]');
    if (slot) {
      slot.innerHTML = '';
      slot.appendChild(makeTrigger());
      slot.classList.add('privacy-slot');
      return;
    }

    // Fallback: just after the hero section (or at the top of main).
    var main = document.getElementById('main');
    if (main) {
      var wrap = document.createElement('div');
      wrap.className = 'privacy-inline';
      wrap.setAttribute('data-privacy-verify', '');
      wrap.appendChild(makeTrigger());
      var hero = main.querySelector('.hero');
      if (hero && hero.parentNode) {
        hero.parentNode.insertBefore(wrap, hero.nextSibling);
      } else {
        main.insertBefore(wrap, main.firstChild);
      }
    }
  }

  function init() {
    initTrigger();

    // Modal wiring (delegated, works before/after the modal exists).
    document.addEventListener('click', function (e) {
      if (e.target && e.target.id === 'closePrivacy') closePrivacy();
      if (e.target && e.target.id === 'closePrivacyFoot') closePrivacy();
      if (e.target && e.target.id === 'refreshPrivacy') {
        var body = document.getElementById('privacyBody');
        if (body) body.innerHTML = renderReport(Privacy.report());
      }
      var modal = document.getElementById('privacyModal');
      if (modal && e.target === modal) closePrivacy();
    });

    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape') {
        var modal = document.getElementById('privacyModal');
        if (modal && modal.classList.contains('visible')) closePrivacy();
      }
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

  /* =========================================================
     HopTools — shared converter utilities
     ========================================================= */
  var Tools = (function () {

    function esc(s) {
      return String(s === null || s === undefined ? '' : s).replace(/[&<>"']/g, function (c) {
        return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
      });
    }

    /** Escape one CSV cell (RFC 4180 style). */
    function csvCell(value, delim) {
      var s = value === null || value === undefined ? '' : String(value);
      var d = delim === undefined ? ',' : delim;
      if (s.indexOf('"') >= 0 || s.indexOf(d) >= 0 || s.indexOf('\n') >= 0 || s.indexOf('\r') >= 0) {
        return '"' + s.replace(/"/g, '""') + '"';
      }
      return s;
    }

    /** Build a full CSV document from headers + row objects. */
    function toCsv(headers, rows, delim) {
      var d = delim === undefined ? ',' : delim;
      var lines = [headers.map(function (h) { return csvCell(h, d); }).join(d)];
      rows.forEach(function (r) {
        lines.push(headers.map(function (h) {
          var v = r[h];
          return csvCell(v === undefined || v === null ? '' : v, d);
        }).join(d));
      });
      return lines.join('\r\n') + '\r\n';
    }

    /** Flatten a nested object into single-level key/value pairs. */
    function flattenValue(obj, sep, joinDelim) {
      var out = {};
      (function walk(prefix, value) {
        if (value === null || value === undefined) { if (prefix) out[prefix] = ''; return; }
        if (Array.isArray(value)) {
          if (value.length === 0) { if (prefix) out[prefix] = ''; return; }
          var allPrimitive = value.every(function (v) {
            return v === null || typeof v !== 'object';
          });
          if (allPrimitive) {
            out[prefix] = value.map(function (v) {
              return v === null || v === undefined ? '' : String(v);
            }).join(joinDelim);
            return;
          }
          out[prefix] = value.map(function (o) {
            return (o && typeof o === 'object') ? JSON.stringify(o) : String(o);
          }).join(joinDelim);
          return;
        }
        if (typeof value === 'object') {
          var keys = Object.keys(value);
          if (keys.length === 0) { if (prefix) out[prefix] = ''; return; }
          keys.forEach(function (k) { walk(prefix ? prefix + sep + k : k, value[k]); });
          return;
        }
        out[prefix] = value;
      })('', obj);
      return out;
    }

    /** Header/detail expansion: one row per array element, parent fields repeated. */
    function detailRows(item, sep, joinDelim, depth, out) {
      var arrKey = null;
      for (var k in item) {
        if (!Object.prototype.hasOwnProperty.call(item, k)) continue;
        var v = item[k];
        if (Array.isArray(v) && v.length && v[0] && typeof v[0] === 'object' && !Array.isArray(v[0])) {
          arrKey = k; break;
        }
      }
      if (arrKey === null || depth > 6) {
        out.push(flattenValue(item, sep, joinDelim));
        return;
      }
      var base = {};
      for (var b in item) if (Object.prototype.hasOwnProperty.call(item, b) && b !== arrKey) base[b] = item[b];
      item[arrKey].forEach(function (child) {
        var merged = {};
        for (var x in base) merged[x] = base[x];
        if (child && typeof child === 'object') {
          for (var y in child) {
            // A child field must never silently replace the parent's field of
            // the same name — that would lose the parent value. Keep both by
            // qualifying the child's key with the array it came from.
            var key = Object.prototype.hasOwnProperty.call(merged, y) ? arrKey + sep + y : y;
            merged[key] = child[y];
          }
        } else {
          merged[arrKey] = child;
        }
        detailRows(merged, sep, joinDelim, depth + 1, out);
      });
    }

    /**
     * Turn parsed JSON into { headers, rows }.
     * strategy: 'detail' (default) | 'flatten'
     */
    function collectRows(data, opts) {
      opts = opts || {};
      var sep = opts.sep || '__';
      var joinDelim = opts.joinDelim || ' | ';
      var strategy = opts.strategy || 'detail';

      var items;
      if (Array.isArray(data)) items = data;
      else if (data && typeof data === 'object') items = [data];
      else items = [];

      var rows = [];
      items.forEach(function (item) {
        if (item === null || item === undefined) return;
        if (typeof item !== 'object' || Array.isArray(item)) {
          rows.push({ value: item });
          return;
        }
        if (strategy === 'detail') detailRows(item, sep, joinDelim, 0, rows);
        else rows.push(flattenValue(item, sep, joinDelim));
      });

      var headers = [];
      var seen = Object.create(null);
      rows.forEach(function (r) {
        for (var k in r) {
          if (!seen[k]) { seen[k] = 1; headers.push(k); }
        }
      });

      return { headers: headers, rows: rows };
    }

    /** Render a preview table. */
    function renderTable(headers, rows, limit) {
      var lim = limit || 50;
      if (!headers.length) return '<div class="results-empty">No columns could be derived from the input.</div>';
      var h = '<table><thead><tr>';
      headers.forEach(function (k) { h += '<th>' + esc(k) + '</th>'; });
      h += '</tr></thead><tbody>';
      rows.slice(0, lim).forEach(function (r) {
        h += '<tr>';
        headers.forEach(function (k) {
          var v = r[k];
          h += '<td>' + esc(v === undefined || v === null ? '' : v) + '</td>';
        });
        h += '</tr>';
      });
      h += '</tbody></table>';
      if (rows.length > lim) {
        h += '<div class="results-empty">Showing the first ' + lim + ' of ' + rows.length + ' rows. Download for the full file.</div>';
      }
      return h;
    }

    /** Render a plain-text output block. */
    function renderPre(text, cls) {
      return '<pre class="' + (cls || '') + '">' + esc(text) + '</pre>';
    }

    /** Trigger a client-side file download. */
    function download(filename, content, mime) {
      var blob = new Blob([content], { type: mime || 'text/plain;charset=utf-8' });
      var url = URL.createObjectURL(blob);
      var a = document.createElement('a');
      a.href = url;
      a.download = filename;
      a.style.display = 'none';
      document.body.appendChild(a);
      a.click();
      setTimeout(function () {
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
      }, 100);
    }

    /** Read a File as UTF-8 text. */
    function readFile(file) {
      return new Promise(function (resolve, reject) {
        var reader = new FileReader();
        reader.onload = function () { resolve(String(reader.result || '')); };
        reader.onerror = function () { reject(new Error('Could not read that file.')); };
        reader.readAsText(file);
      });
    }

    /** Guess the delimiter of a delimited text file. */
    function detectDelimiter(text) {
      var line = String(text || '').split(/\r?\n/).filter(function (l) { return l.trim() !== ''; })[0] || '';
      var candidates = [',', '\t', ';', '|'];
      var best = ',';
      var bestCount = 0;
      candidates.forEach(function (d) {
        var count = line.split(d).length - 1;
        if (count > bestCount) { bestCount = count; best = d; }
      });
      return best;
    }

    /** Split delimited text into an array of string arrays (RFC 4180 aware). */
    function parseDelimited(text, delim) {
      var d = delim || ',';
      var rows = [];
      var row = [];
      var field = '';
      var inQuotes = false;
      var s = String(text || '').replace(/^\ufeff/, '');
      for (var i = 0; i < s.length; i++) {
        var c = s[i];
        if (inQuotes) {
          if (c === '"') {
            if (s[i + 1] === '"') { field += '"'; i++; }
            else inQuotes = false;
          } else field += c;
          continue;
        }
        if (c === '"') { inQuotes = true; continue; }
        if (c === d) { row.push(field); field = ''; continue; }
        if (c === '\n') { row.push(field); rows.push(row); row = []; field = ''; continue; }
        if (c === '\r') continue;
        field += c;
      }
      if (field !== '' || row.length) { row.push(field); rows.push(row); }
      return rows;
    }

    /** Show an error message in the converter's error box. */
    function showError(id, message) {
      var box = document.getElementById(id);
      if (!box) return;
      box.textContent = message;
      box.style.display = message ? 'block' : 'none';
    }

    /**
     * Wire up the standard converter chrome.
     * cfg: { inputId, fileId, statusId, sampleId, resetId, downloadId,
     *        errorId, resultsId, emptyId, sample, downloadName, downloadMime,
     *        convert(text) -> { html, text, rows, cols, extra } }
     */
    function mount(cfg) {
      var input = document.getElementById(cfg.inputId);
      var results = document.getElementById(cfg.resultsId);
      var emptyEl = document.getElementById(cfg.emptyId);
      var statusEl = document.getElementById(cfg.statusId);
      var fileInput = document.getElementById(cfg.fileId);
      var lastOutput = null;

      function show(html) {
        if (!results) return;
        if (emptyEl) emptyEl.style.display = 'none';
        results.innerHTML = html;
        results.classList.add('visible');
      }

      function reset() {
        if (input) input.value = '';
        if (fileInput) fileInput.value = '';
        if (results) { results.innerHTML = ''; results.classList.remove('visible'); }
        if (emptyEl) { emptyEl.style.display = ''; }
        if (statusEl) statusEl.textContent = 'Awaiting input';
        showError(cfg.errorId, '');
        lastOutput = null;
        if (cfg.onReset) cfg.onReset();
      }

      function run(text) {
        if (text === null || text === undefined || String(text).trim() === '') {
          showError(cfg.errorId, '');
          if (statusEl) statusEl.textContent = 'Awaiting input';
          if (results) { results.innerHTML = ''; results.classList.remove('visible'); }
          if (emptyEl) { emptyEl.style.display = ''; }
          lastOutput = null;
          return;
        }
        var t0 = (window.performance && performance.now) ? performance.now() : Date.now();
        try {
          var out = cfg.convert(String(text));
          var ms = Math.round(((window.performance && performance.now) ? performance.now() : Date.now()) - t0);
          showError(cfg.errorId, '');
          if (statusEl) statusEl.textContent = 'Converted in ' + ms + ' ms';
          show(out.html);
          lastOutput = out;
          if (cfg.onSuccess) cfg.onSuccess(out, ms);
        } catch (err) {
          lastOutput = null;
          if (results) { results.innerHTML = ''; results.classList.remove('visible'); }
          if (emptyEl) { emptyEl.style.display = ''; }
          if (statusEl) statusEl.textContent = 'Error';
          showError(cfg.errorId, err && err.message ? err.message : 'Could not convert that input.');
        }
      }

      if (input) {
        input.addEventListener('input', function () { run(input.value); });
        input.addEventListener('paste', function () { setTimeout(function () { run(input.value); }, 0); });
      }

      if (fileInput) {
        fileInput.addEventListener('change', function () {
          var f = fileInput.files && fileInput.files[0];
          if (!f) return;
          readFile(f).then(function (txt) {
            if (input) input.value = txt;
            run(txt);
          }).catch(function (e) {
            showError(cfg.errorId, e && e.message ? e.message : 'Could not read that file.');
          });
        });
      }

      var sampleBtn = document.getElementById(cfg.sampleId);
      if (sampleBtn) {
        sampleBtn.addEventListener('click', function () {
          if (input) input.value = cfg.sample;
          run(cfg.sample);
        });
      }

      var resetBtn = document.getElementById(cfg.resetId);
      if (resetBtn) resetBtn.addEventListener('click', reset);

      var dlBtn = document.getElementById(cfg.downloadId);
      if (dlBtn) {
        dlBtn.addEventListener('click', function () {
          if (!lastOutput) {
            showError(cfg.errorId, 'Nothing to download yet — paste or upload something first.');
            return;
          }
          if (lastOutput.blob) {
            var url = URL.createObjectURL(lastOutput.blob);
            var a = document.createElement('a');
            a.href = url;
            a.download = cfg.downloadName;
            a.style.display = 'none';
            document.body.appendChild(a);
            a.click();
            setTimeout(function () {
              document.body.removeChild(a);
              URL.revokeObjectURL(url);
            }, 100);
          } else {
            download(cfg.downloadName, lastOutput.text, cfg.downloadMime);
          }
        });
      }

      // Settings modal
      var modal = document.getElementById('settingsModal');
      if (modal) {
        var openBtn = document.getElementById('settingsBtn');
        var closeBtn = document.getElementById('closeSettings');
        var closeFoot = document.getElementById('closeSettingsFoot');
        var applyBtn = document.getElementById('applySettings');
        function close() { modal.classList.remove('visible'); }
        if (openBtn) openBtn.addEventListener('click', function () { modal.classList.add('visible'); });
        if (closeBtn) closeBtn.addEventListener('click', close);
        if (closeFoot) closeFoot.addEventListener('click', close);
        if (applyBtn) {
          applyBtn.addEventListener('click', function () {
            close();
            if (cfg.applySettings) cfg.applySettings();
            if (input) run(input.value);
          });
        }
        modal.addEventListener('click', function (e) { if (e.target === modal) close(); });
      }

      return { run: run, reset: reset };
    }

    return {
      esc: esc,
      csvCell: csvCell,
      toCsv: toCsv,
      flattenValue: flattenValue,
      collectRows: collectRows,
      renderTable: renderTable,
      renderPre: renderPre,
      download: download,
      readFile: readFile,
      detectDelimiter: detectDelimiter,
      parseDelimited: parseDelimited,
      showError: showError,
      mount: mount
    };
  })();

  global.HopPrivacy = Privacy;
  global.HopFilter = Filter;
  global.HopTools = Tools;

})(typeof window !== 'undefined' ? window : this);
