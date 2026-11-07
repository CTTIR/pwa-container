/*
 * pwa-container record helper for uploaded web apps.
 *
 *   <script src="/_pwa/records.js"></script>
 *   await pwaRecords.submit({ score: 7, answers: [...] }, { collection: 'sessions' });
 *
 * Records go to POST /api/records on the app's own host (or /api/apps/<id>/records when the app
 * runs under /a/<id>/). Every record gets a random id once, so the server stores it only once even
 * if it is sent twice (two tabs, a lost answer). Records wait in localStorage, per app, until the
 * server confirms them; when the server is unreachable, switched off, full or busy they are kept
 * and resent with growing pauses (30 s doubling up to 1 h), on load, and when the device comes
 * back online. Only records the server rejects as invalid (400/413) are dropped, with a console
 * warning. Nothing identifying is added: the server stores the record and its collection only.
 *
 *   pwaRecords.submit(data, { collection })  -> Promise<number of records still waiting>
 *   pwaRecords.pending()                     -> number of records waiting
 *   pwaRecords.flush()                       -> Promise<number still waiting>; sends now
 */
(function () {
  'use strict';
  if (window.pwaRecords) return;

  var MAX_QUEUE = 500;
  var FIRST_DELAY = 30 * 1000;
  var MAX_DELAY = 60 * 60 * 1000;
  var COLLECTION = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/;
  var LEGACY_KEY = 'pwa-container:records-outbox';

  var APP = (function () {
    var m = location.pathname.match(/^\/a\/([a-z0-9][a-z0-9-]{2,63})(?:\/|$)/);
    return m ? m[1] : null;
  })();
  var ENDPOINT = APP ? '/api/apps/' + APP + '/records' : '/api/records';
  // One outbox per app: apps that share an origin (path mode) never send each other's records.
  var KEY = LEGACY_KEY + ':' + location.host + (APP ? '/a/' + APP : '');

  var memory = []; // used when localStorage is missing or full
  var storageOk = (function () {
    try {
      var probe = KEY + ':probe';
      localStorage.setItem(probe, '1');
      localStorage.removeItem(probe);
      return true;
    } catch (e) {
      return false;
    }
  })();

  var sending = null; // promise of the running send loop
  var again = false; // a flush was requested while the loop ran
  var delay = 0; // current pause after a failure (0 = none)
  var nextTry = 0; // time before which automatic sends wait
  var timer = null;

  function uuid() {
    var c = window.crypto;
    if (c && typeof c.randomUUID === 'function') {
      try {
        return c.randomUUID();
      } catch (e) {
        /* insecure context: fall through */
      }
    }
    var b = new Uint8Array(16);
    if (c && typeof c.getRandomValues === 'function') c.getRandomValues(b);
    else for (var i = 0; i < 16; i++) b[i] = Math.floor(Math.random() * 256);
    b[6] = (b[6] & 0x0f) | 0x40;
    b[8] = (b[8] & 0x3f) | 0x80;
    var h = [];
    for (var j = 0; j < 16; j++) h.push((b[j] + 0x100).toString(16).slice(1));
    return h.slice(0, 4).join('') + '-' + h.slice(4, 6).join('') + '-' + h.slice(6, 8).join('') + '-' + h.slice(8, 10).join('') + '-' + h.slice(10).join('');
  }

  /** A queued record: { id, collection, json } with the data already serialized. */
  function valid(item) {
    return item && typeof item.id === 'string' && typeof item.collection === 'string' && typeof item.json === 'string';
  }

  /** Reads the outbox afresh, so changes made by other tabs are never overwritten. */
  function read() {
    if (!storageOk) return memory.slice();
    try {
      var list = JSON.parse(localStorage.getItem(KEY) || '[]');
      if (!Array.isArray(list)) return [];
      var good = list.filter(valid);
      if (good.length !== list.length) console.warn('pwa-container: ignored ' + (list.length - good.length) + ' unreadable queued record(s)');
      return good;
    } catch (e) {
      console.warn('pwa-container: record outbox unreadable', e);
      return memory.slice();
    }
  }

  function write(list) {
    memory = list.slice();
    if (!storageOk) return;
    try {
      if (list.length) localStorage.setItem(KEY, JSON.stringify(list));
      else localStorage.removeItem(KEY);
    } catch (e) {
      // Storage full or blocked: keep the queue in memory for this page from now on.
      storageOk = false;
      console.warn('pwa-container: localStorage unavailable, records are kept in memory only', e);
    }
  }

  /** Re-reads, changes and writes back the outbox in one step. */
  function update(change) {
    var list = read();
    change(list);
    write(list);
    return list.length;
  }

  /** Records of the old, shared outbox: adopted on an app's own host, left alone in path mode. */
  function adoptLegacy() {
    if (!storageOk) return;
    try {
      var old = JSON.parse(localStorage.getItem(LEGACY_KEY) || 'null');
      if (!Array.isArray(old) || old.length === 0) return;
      if (APP) {
        console.warn('pwa-container: ' + old.length + ' record(s) in the old shared outbox cannot be assigned to an app and stay there');
        return;
      }
      update(function (list) {
        old.forEach(function (o) {
          if (!o || typeof o !== 'object') return;
          try {
            var json = JSON.stringify(o.data === undefined ? null : o.data);
            list.push({ id: uuid(), collection: typeof o.collection === 'string' ? o.collection : 'default', json: json === undefined ? 'null' : json });
          } catch (e) {
            console.warn('pwa-container: dropped an old queued record that cannot be serialized', e);
          }
        });
        trim(list);
      });
      localStorage.removeItem(LEGACY_KEY);
    } catch (e) {
      /* unreadable legacy outbox: leave it */
    }
  }

  function trim(list) {
    if (list.length <= MAX_QUEUE) return;
    var dropped = list.length - MAX_QUEUE;
    list.splice(0, dropped);
    console.warn('pwa-container: record outbox full (' + MAX_QUEUE + '); dropped the ' + dropped + ' oldest record(s)');
  }

  /** 'done' (stored or duplicate), 'invalid' (400/413: will never be accepted) or 'retry'. */
  function post(item) {
    var body = '{"collection":' + JSON.stringify(item.collection) + ',"data":' + item.json + ',"id":' + JSON.stringify(item.id) + '}';
    return fetch(ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: body,
      cache: 'no-store',
      credentials: 'same-origin',
    }).then(
      function (res) {
        if (res.status === 201 || res.status === 200) return 'done';
        if (res.status === 400 || res.status === 413) return 'invalid';
        return 'retry'; // 403 switched off, 404, 409 full, 429, 5xx, anything else
      },
      function () {
        return 'retry';
      }
    );
  }

  function schedule() {
    if (timer) clearTimeout(timer);
    timer = setTimeout(function () {
      timer = null;
      flush(false);
    }, Math.max(1000, nextTry - Date.now()));
  }

  function backOff() {
    delay = delay ? Math.min(delay * 2, MAX_DELAY) : FIRST_DELAY;
    nextTry = Date.now() + delay;
    schedule();
  }

  /** Sends queued records one by one, oldest first, until the queue is empty or a send fails. */
  function drain() {
    var list = read();
    if (list.length === 0) return Promise.resolve(0);
    var item = list[0];
    return post(item).then(function (result) {
      if (result === 'retry') {
        backOff();
        return read().length;
      }
      if (result === 'invalid') console.warn('pwa-container: record rejected by the server and dropped', item.collection);
      delay = 0;
      nextTry = 0;
      update(function (l) {
        for (var i = l.length - 1; i >= 0; i--) if (l[i].id === item.id) l.splice(i, 1);
      });
      return drain();
    });
  }

  /** Starts sending unless a send is running or (when not forced) the pause after a failure lasts. */
  function flush(force) {
    if (force) nextTry = 0;
    if (sending) {
      // The running loop may already have read the queue: run once more when it ends.
      again = true;
      return sending;
    }
    if (Date.now() < nextTry) return Promise.resolve(read().length);
    again = false;
    var run;
    try {
      run = drain();
    } catch (e) {
      run = Promise.reject(e);
    }
    sending = run.then(
      function (n) {
        sending = null;
        if (again) return flush(false);
        return n;
      },
      function (e) {
        sending = null;
        console.warn('pwa-container: sending records failed', e);
        backOff();
        return read().length;
      }
    );
    return sending;
  }

  window.pwaRecords = {
    /** Queues a record and tries to send it. Resolves to the number of records still waiting. */
    submit: function (data, options) {
      var collection = (options && options.collection) || 'default';
      if (typeof collection !== 'string' || !COLLECTION.test(collection)) {
        return Promise.reject(new TypeError('pwaRecords: invalid collection name "' + collection + '"'));
      }
      var json;
      try {
        json = JSON.stringify(data === undefined ? null : data);
      } catch (e) {
        console.warn('pwa-container: record cannot be serialized and was not queued', e);
        return Promise.reject(e);
      }
      if (json === undefined) json = 'null'; // e.g. a function
      var item = { id: uuid(), collection: collection, json: json };
      update(function (list) {
        list.push(item);
        trim(list);
      });
      return flush(false);
    },
    /** Number of records waiting to be sent. */
    pending: function () {
      return read().length;
    },
    /** Sends waiting records now, without waiting for the pause after a failure. */
    flush: function () {
      return flush(true);
    },
  };

  adoptLegacy();
  window.addEventListener('online', function () {
    delay = 0;
    flush(true);
  });
  // Picks up records queued by other tabs and retries after pauses.
  setInterval(function () {
    flush(false);
  }, FIRST_DELAY);
  flush(false);
})();
