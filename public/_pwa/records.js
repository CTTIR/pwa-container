/*
 * pwa-container record helper for uploaded web apps.
 *
 *   <script src="/_pwa/records.js"></script>
 *   await pwaRecords.submit({ score: 7, answers: [...] }, { collection: 'sessions' });
 *
 * Records go to POST /api/records on the app's own host. If the device is offline or the
 * server is unreachable, records wait in localStorage and are resent automatically (on load,
 * when the connection returns, and every 30 seconds). Nothing identifying is added: the server
 * stores the record, its collection and the calendar day only.
 */
(function () {
  'use strict';
  var KEY = 'pwa-container:records-outbox';
  var ENDPOINT = (function () {
    var m = location.pathname.match(/^\/a\/([a-z0-9][a-z0-9-]{2,63})\//);
    return m ? '/api/apps/' + m[1] + '/records' : '/api/records';
  })();
  var sending = false;

  function load() {
    try {
      return JSON.parse(localStorage.getItem(KEY) || '[]');
    } catch (e) {
      return [];
    }
  }
  function save(list) {
    try {
      localStorage.setItem(KEY, JSON.stringify(list));
    } catch (e) {
      /* storage unavailable: keep in memory only */
    }
  }
  var memory = load();

  function post(item) {
    return fetch(ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ collection: item.collection, data: item.data }),
      cache: 'no-store',
    }).then(
      function (res) {
        if (res.status === 201) return 'stored';
        if (res.status >= 500 || res.status === 429 || res.status === 408) return 'retry';
        return 'rejected';
      },
      function () {
        return 'retry';
      }
    );
  }

  function flush() {
    if (sending || memory.length === 0) return Promise.resolve(memory.length);
    sending = true;
    var item = memory[0];
    return post(item).then(function (result) {
      sending = false;
      if (result === 'retry') return memory.length;
      memory.shift();
      save(memory);
      if (result === 'rejected') console.warn('pwa-container: record rejected by the server', item.collection);
      return flush();
    });
  }

  window.pwaRecords = {
    /** Queues a record and tries to send it. Resolves to the number of records still waiting. */
    submit: function (data, options) {
      var collection = (options && options.collection) || 'default';
      memory.push({ collection: collection, data: data });
      save(memory);
      return flush();
    },
    /** Number of records waiting to be sent. */
    pending: function () {
      return memory.length;
    },
    flush: flush,
  };

  window.addEventListener('online', flush);
  setInterval(flush, 30000);
  flush();
})();
