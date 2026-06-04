// Per-spoke failure state for the ServerlessHub. Tracks consecutive failure counts and any open
// PagerDuty incident dedup key so the hub can: (a) hold paging until N consecutive failures, and
// (b) emit an explicit resolve event when a previously-failing spoke recovers.
//
// Two backends, mirroring ServerlessHub's saveQueriedBlock modes:
//   - "gcp"          → Datastore entity kind `ServerlessHubSpokeState`, key = `${configFile}/${spokeName}`.
//   - "localStorage" → process.env keys `spokeFailureState-${configFile}-${spokeName}` (JSON).
//
// Either backend returns a default empty state when no record exists.

const { Datastore } = require("@google-cloud/datastore");
const retry = require("async-retry");

const ENTITY_KIND = "ServerlessHubSpokeState";

const defaultState = () => ({
  consecutiveFailures: 0,
  lastErrorKind: null,
  lastErrorMessage: null,
  openIncidentDedupKey: null,
  lastChangedAt: null,
});

const envKey = (configFile, spokeName) => `spokeFailureState-${configFile}-${spokeName}`;
const datastoreKey = (datastore, configFile, spokeName) => datastore.key([ENTITY_KIND, `${configFile}/${spokeName}`]);

async function loadState({ configFile, spokeName, hubConfig, logger, _datastore }) {
  if (hubConfig.spokeFailureStateBackend === "gcp") {
    const datastore = _datastore || new Datastore();
    return retry(
      async () => {
        const [entity] = await datastore.get(datastoreKey(datastore, configFile, spokeName));
        if (!entity) return defaultState();
        return { ...defaultState(), ...entity };
      },
      {
        retries: 2,
        minTimeout: 2000,
        onRetry: (error) => {
          logger.debug({
            at: "SpokeFailureState",
            message: "Datastore get failed - retrying",
            spokeName,
            error: typeof error === "string" ? new Error(error) : error,
          });
        },
      }
    );
  }
  // localStorage
  const raw = process.env[envKey(configFile, spokeName)];
  if (!raw) return defaultState();
  try {
    return { ...defaultState(), ...JSON.parse(raw) };
  } catch (err) {
    logger.debug({
      at: "SpokeFailureState",
      message: "Failed to parse local-storage spoke state, resetting",
      spokeName,
      error: err.toString(),
    });
    return defaultState();
  }
}

async function saveState({ configFile, spokeName, state, hubConfig, logger, _datastore }) {
  const stamped = { ...state, lastChangedAt: new Date().toISOString() };
  if (hubConfig.spokeFailureStateBackend === "gcp") {
    const datastore = _datastore || new Datastore();
    await retry(
      async () => {
        await datastore.save({ key: datastoreKey(datastore, configFile, spokeName), data: stamped });
      },
      {
        retries: 2,
        minTimeout: 2000,
        onRetry: (error) => {
          logger.debug({
            at: "SpokeFailureState",
            message: "Datastore save failed - retrying",
            spokeName,
            error: typeof error === "string" ? new Error(error) : error,
          });
        },
      }
    );
    return stamped;
  }
  process.env[envKey(configFile, spokeName)] = JSON.stringify(stamped);
  return stamped;
}

module.exports = {
  loadState,
  saveState,
  defaultState,
  ENTITY_KIND,
  // exported for tests
  _envKey: envKey,
};
