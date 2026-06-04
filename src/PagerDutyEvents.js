// Minimal PagerDuty Events API v2 client for the ServerlessHub.
//
// The shared @risk-labs/logger PagerDutyV2Transport always fires `event_action: "trigger"` and
// does not pass a `dedup_key`, so every page becomes a fresh incident. We need both stable
// dedup keys (so repeated failures of the same spoke collapse into one rolling incident) and
// explicit `resolve` events (so transient failures self-cancel on recovery). Bypassing the
// transport for spoke pages keeps that machinery localised to the hub and avoids a logger
// release.
//
// If `integrationKey` is missing the client is a no-op — keeps the hub backward-compatible
// for any environment that has not yet provisioned a Events-API integration.

const fetch = require("node-fetch");

const EVENTS_URL = "https://events.pagerduty.com/v2/enqueue";

function makeClient({ integrationKey, fetchImpl = fetch, logger } = {}) {
  const enabled = Boolean(integrationKey);

  async function send({ eventAction, dedupKey, payload }) {
    if (!enabled) return { skipped: true };
    const body = { routing_key: integrationKey, event_action: eventAction, dedup_key: dedupKey };
    if (eventAction === "trigger") body.payload = payload;
    const res = await fetchImpl(EVENTS_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const text = typeof res.text === "function" ? await res.text() : "";
      const err = new Error(`PagerDuty events API ${eventAction} failed: ${res.status} ${text}`);
      if (logger) {
        logger.warn({
          at: "PagerDutyEvents",
          message: "PagerDuty events API call failed",
          eventAction,
          dedupKey,
          status: res.status,
          response: text,
        });
      }
      throw err;
    }
    return { ok: true };
  }

  return {
    enabled,
    trigger: ({ dedupKey, summary, severity = "error", source, customDetails }) =>
      send({
        eventAction: "trigger",
        dedupKey,
        payload: { summary, severity, source, custom_details: customDetails },
      }),
    resolve: ({ dedupKey }) => send({ eventAction: "resolve", dedupKey }),
  };
}

module.exports = { makeClient, EVENTS_URL };
