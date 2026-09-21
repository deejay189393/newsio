/**
 * The public base URL of the request currently being served.
 *
 * The stream handler needs it: a YouTube story is played through this
 * addon's own /yt endpoint, and Stremio requires an absolute URL, so the
 * handler has to know what host it is answering on. The SDK's handlers are
 * given only `{ id, config, extra }` -- no request object -- and the addon
 * answers on two hosts (production and beta), so the host cannot be a
 * constant or an environment variable either.
 *
 * AsyncLocalStorage carries it down instead. A module-level variable would
 * be wrong: requests interleave at every await, so one request could read
 * another's host and hand a viewer a URL pointing at the wrong deployment.
 */

const { AsyncLocalStorage } = require("async_hooks");

const storage = new AsyncLocalStorage();

/** Run `fn` with `baseUrl` readable by everything it awaits. */
function withBaseUrl(baseUrl, fn) {
  return storage.run({ baseUrl }, fn);
}

/** The base URL of the in-flight request, or undefined outside one. */
function currentBaseUrl() {
  const store = storage.getStore();
  return store ? store.baseUrl : undefined;
}

module.exports = { withBaseUrl, currentBaseUrl };
