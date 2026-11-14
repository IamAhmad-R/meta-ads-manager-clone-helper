// Exercises the Graph client against a fake fetch: version fallback, retry
// policy, friendly session errors and preview chunking.

const local = {};
const session = {};

globalThis.chrome = {
  storage: {
    local: {
      get: async (key) => ({ [key]: local[key] }),
      set: async (values) => Object.assign(local, values),
      remove: async (key) => delete local[key],
    },
    session: {
      get: async (key) => ({ [key]: session[key] }),
      set: async (values) => Object.assign(session, values),
      remove: async (key) => delete session[key],
    },
  },
};

// Backoff sleeps do not slow the test down.
const realSetTimeout = globalThis.setTimeout;
globalThis.setTimeout = (fn) => {
  fn();
  return 0;
};

let requests = [];
let respond = () => ({ status: 200, body: { ok: true } });

globalThis.fetch = async (input, init) => {
  const url = String(input);
  requests.push({ url, method: init?.method, body: init?.body });
  const { status, body } = respond(url, init);
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: String(status),
    json: async () => body,
  };
};

const { setToken, clearToken, call, fetchPreviews, createCreative, fetchCreativeState } = await import('../extension/src/lib/api.js');

let passed = 0;
function test(name, fn) {
  return Promise.resolve()
    .then(fn)
    .then(() => {
      passed += 1;
      console.log(`ok   ${name}`);
    })
    .catch((error) => {
      console.log(`FAIL ${name}\n     ${error.message}`);
      process.exitCode = 1;
    });
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

await test("caches the first version Meta accepts", async () => {
  requests = [];
  delete local.graphApiVersion;
  respond = (url) => {
    if (url.includes('/v25.0/')) {
      return { status: 400, body: { error: { message: 'API Unknown: version v25.0 is not supported', code: 100 } } };
    }
    return { status: 200, body: { id: 'creative_9' } };
  };
  await setToken('token-a');
  const result = await call('act_1/adcreatives', { method: 'POST', body: { a: 1 } });
  assert(result.id === 'creative_9', 'expected the v24 response');
  assert(local.graphApiVersion === 'v24.0', `cached version was ${local.graphApiVersion}`);
  assert(requests[0].url.includes('/v25.0/'), 'first call should try v25');
  assert(requests[1].url.includes('/v24.0/'), 'second call should try v24');
  assert(requests[0].method === 'POST', 'POST should be forwarded');
  assert(requests[0].body === JSON.stringify({ a: 1 }), 'body should be JSON encoded');
});

await test("expired session error clears the token and reads friendly", async () => {
  await setToken('token-b');
  respond = () => ({ status: 400, body: { error: { message: 'Error validating access token', code: 190 } } });
  let message = '';
  try {
    await call('me');
  } catch (error) {
    message = error.message;
  }
  assert(/session expired/i.test(message), `unexpected message: ${message}`);
  assert(session.fbAccessToken === undefined, 'token should be removed from session storage');
});

await test("retryable errors are retried, then succeed", async () => {
  await setToken('token-c');
  requests = [];
  let attempt = 0;
  respond = () => {
    attempt += 1;
    if (attempt < 3) {
      return {
        status: 500,
        body: { error: { message: 'Ads buying service not available', error_subcode: 3008001, is_transient: true } },
      };
    }
    return { status: 200, body: { data: ['ok'] } };
  };
  const result = await call('act_1/adsets');
  assert(result.data[0] === 'ok', 'expected success after retries');
  assert(requests.length === 3, `expected 3 attempts, saw ${requests.length}`);
});

await test("creative creation is never retried", async () => {
  await setToken('token-d');
  requests = [];
  respond = () => ({ status: 500, body: { error: { message: 'temporary', is_transient: true } } });
  let failed = false;
  try {
    await createCreative('123', { title: 'x' });
  } catch {
    failed = true;
  }
  assert(failed, 'createCreative should throw');
  assert(requests.length === 1, `expected 1 request, saw ${requests.length}`);
});

await test("previews are requested in chunks of 50", async () => {
  await setToken('token-e');
  requests = [];
  delete local.graphApiVersion;
  respond = (url) => {
    const ids = new URL(url).searchParams.get('ids').split(',');
    return {
      status: 200,
      body: Object.fromEntries(ids.map((id) => [id, { name: `Ad ${id}`, __meta: 'ignored' }])),
    };
  };
  const ids = Array.from({ length: 120 }, (_, index) => String(1000 + index));
  const rows = await fetchPreviews(ids);
  assert(rows.length === 120, `expected 120 rows, saw ${rows.length}`);
  assert(requests.length === 3, `expected 3 chunk calls, saw ${requests.length}`);
  assert(rows[0].__meta === undefined, 'internal __ fields should be stripped');
});

await test("preview responses drop the __fb_trace_id__ envelope keys", async () => {
  await setToken('token-g');
  respond = () => ({
    status: 200,
    body: {
      '111222333444': { name: 'UGC bundle PDP test', __meta: 'x' },
      '555666777888': { name: 'Second ad' },
      __fb_trace_id__: 'abc123',
      __www_request_id__: 'def456',
    },
  });
  const rows = await fetchPreviews(['111222333444', '555666777888']);
  assert(rows.length === 2, `expected 2 rows, saw ${rows.length}`);
  assert(rows.every((row) => /^\d+$/.test(row.adId)), 'only numeric ad ids should survive');
  assert(rows[0].__meta === undefined, 'inner __ fields should still be stripped');
});

await test("creative read-back reports OPT_IN and missing keys", async () => {
  await setToken('token-f');
  respond = () => ({
    status: 200,
    body: {
      degrees_of_freedom_spec: {
        creative_features_spec: {
          product_extensions: { enroll_status: 'OPT_IN' },
          inline_comment: { enroll_status: 'OPT_OUT' },
          standard_enhancements: { enroll_status: 'OPT_IN' },
        },
      },
      destination_spec: {
        website: { optimization: { status: 'OPT_IN' } },
        native_commerce_experience: { product_browsing: { enroll_status: 'OPT_IN' } },
      },
      creative_sourcing_spec: { associated_product_set_id: 'ps_1' },
    },
  });
  const state = await fetchCreativeState('creative_1', [
    'product_extensions',
    'inline_comment',
    'text_optimizations',
  ]);
  assert(state.notOff.includes('product_extensions'), 'OPT_IN key should be reported');
  assert(!state.notOff.includes('inline_comment'), 'OPT_OUT key should not be reported');
  assert(state.notOff.includes('text_optimizations'), 'missing key should be reported');
  assert(state.destinationOn.includes('destination:optimize_website_destination'), 'website destination should be reported');
  assert(state.destinationOn.includes('destination:product_browsing'), 'product browsing destination should be reported');
  assert(state.destinationOn.includes('sourcing:associated_product_set_id'), 're-attached product set should be reported');
  assert(state.specPresent > 0, 'spec presence should be counted');
});

globalThis.setTimeout = realSetTimeout;
console.log(`\n${passed} API checks passed`);
