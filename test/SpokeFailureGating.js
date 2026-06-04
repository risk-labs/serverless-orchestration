// Tests for the per-spoke consecutive-failure gate, stable PagerDuty dedup_key, and resolve-on-
// recovery flow added to ServerlessHub. The hub is run in localStorage mode with a stubbed PD
// client (`_pdEventsClient`) so we can assert the exact trigger/resolve sequence.

const { network } = require("hardhat");
const { assert } = require("chai");
const viem = require("viem");
const request = require("supertest");

const winston = require("winston");
const sinon = require("sinon");
const { SpyTransport } = require("@risk-labs/logger");

const hub = require("../src/ServerlessHub");
const spoke = require("../src/ServerlessSpoke");
const spokeFailureState = require("../src/SpokeFailureState");

describe("ServerlessHub spoke-failure gating", function () {
  let provider;
  let defaultChainId;
  let hubSpy;
  let hubSpyLogger;
  let spokeSpy;
  let spokeSpyLogger;
  let hubInstance;
  let spokeInstance;
  let pdStub;

  const hubTestPort = 8090;
  const spokeTestPort = 8091;

  const sendHubRequest = (body) =>
    request(`http://localhost:${hubTestPort}`).post("/").send(body).set("Accept", "application/json");

  const makePdStub = () => {
    const calls = [];
    return {
      calls,
      enabled: true,
      trigger: async (args) => {
        calls.push({ kind: "trigger", ...args });
      },
      resolve: async (args) => {
        calls.push({ kind: "resolve", ...args });
      },
    };
  };

  const setEnvironmentVariableKeys = [];
  const setEnv = (k, v) => {
    setEnvironmentVariableKeys.push(k);
    process.env[k] = v;
  };
  const clearSpokeStateEnvs = () => {
    for (const key of Object.keys(process.env)) {
      if (key.startsWith("spokeFailureState-")) delete process.env[key];
    }
  };

  // Boot the hub fresh in each test so we can inject a fresh PD stub and threshold.
  const bootHub = async ({ threshold = 2 } = {}) => {
    pdStub = makePdStub();
    hubInstance = await hub.Poll(
      hubSpyLogger,
      hubTestPort,
      `http://localhost:${spokeTestPort}`,
      network.config.url,
      { spokeFailurePageThreshold: threshold, _pdEventsClient: pdStub }
    );
  };

  beforeEach(async function () {
    provider = viem.createPublicClient({ transport: viem.http(network.config.url) });
    defaultChainId = await provider.getChainId();
    hubSpy = sinon.spy();
    hubSpyLogger = winston.createLogger({
      level: "info",
      transports: [new SpyTransport({ level: "debug" }, { spy: hubSpy })],
    });
    spokeSpy = sinon.spy();
    spokeSpyLogger = winston.createLogger({
      level: "info",
      transports: [new SpyTransport({ level: "debug" }, { spy: spokeSpy })],
    });
    spokeInstance = await spoke.Poll(spokeSpyLogger, spokeTestPort);
    clearSpokeStateEnvs();
  });

  afterEach(async function () {
    if (hubInstance) hubInstance.close();
    if (spokeInstance) spokeInstance.close();
    for (const key of setEnvironmentVariableKeys) delete process.env[key];
    setEnvironmentVariableKeys.length = 0;
    clearSpokeStateEnvs();
  });

  const setupConfig = (configFile, hubConfig) => {
    const startingBlockNumber = 0;
    setEnv(`lastQueriedBlockNumber-${defaultChainId}-${configFile}`, String(startingBlockNumber));
    setEnv(`test-bucket-${configFile}`, JSON.stringify(hubConfig));
  };

  const failingSpoke = { serverlessCommand: "false", environmentVariables: { CUSTOM_NODE_URL: network.config.url } };
  const succeedingSpoke = { serverlessCommand: "true", environmentVariables: { CUSTOM_NODE_URL: network.config.url } };

  it("does not page on the first failure when threshold is 2", async function () {
    await bootHub({ threshold: 2 });
    const configFile = "gate-test-single-fail";
    setupConfig(configFile, { flakySpoke: failingSpoke });

    const res = await sendHubRequest({ bucket: "test-bucket", configFile });
    assert.equal(res.res.statusCode, 500); // partial-failure throws → 500
    assert.equal(pdStub.calls.length, 0, "no PD events should fire below threshold");

    const stored = await spokeFailureState.loadState({
      configFile,
      spokeName: "flakySpoke",
      hubConfig: { spokeFailureStateBackend: "localStorage" },
      logger: hubSpyLogger,
    });
    assert.equal(stored.consecutiveFailures, 1);
    assert.equal(stored.openIncidentDedupKey, null);
  });

  it("pages with a stable dedup_key after threshold consecutive failures", async function () {
    await bootHub({ threshold: 2 });
    const configFile = "gate-test-two-fails";
    setupConfig(configFile, { flakySpoke: failingSpoke });

    await sendHubRequest({ bucket: "test-bucket", configFile });
    await sendHubRequest({ bucket: "test-bucket", configFile });

    const triggers = pdStub.calls.filter((c) => c.kind === "trigger");
    assert.equal(triggers.length, 1, "exactly one trigger after the second failure");
    assert.equal(triggers[0].dedupKey, `serverless-hub:${configFile}:flakySpoke`);
    assert.equal(triggers[0].severity, "error");
    assert.equal(triggers[0].customDetails.consecutiveFailures, 2);
    assert.equal(triggers[0].customDetails.errorKind, "execution-error");

    const stored = await spokeFailureState.loadState({
      configFile,
      spokeName: "flakySpoke",
      hubConfig: { spokeFailureStateBackend: "localStorage" },
      logger: hubSpyLogger,
    });
    assert.equal(stored.consecutiveFailures, 2);
    assert.equal(stored.openIncidentDedupKey, `serverless-hub:${configFile}:flakySpoke`);
  });

  it("re-triggers with the same dedup_key on subsequent failures (PD will dedupe)", async function () {
    await bootHub({ threshold: 2 });
    const configFile = "gate-test-keep-failing";
    setupConfig(configFile, { flakySpoke: failingSpoke });

    await sendHubRequest({ bucket: "test-bucket", configFile });
    await sendHubRequest({ bucket: "test-bucket", configFile });
    await sendHubRequest({ bucket: "test-bucket", configFile });

    const triggers = pdStub.calls.filter((c) => c.kind === "trigger");
    assert.equal(triggers.length, 2, "second and third runs both trigger; first is below threshold");
    assert.equal(triggers[0].dedupKey, triggers[1].dedupKey);
    assert.equal(triggers[1].customDetails.consecutiveFailures, 3);
  });

  it("resolves the open incident when the spoke recovers", async function () {
    await bootHub({ threshold: 2 });
    const configFile = "gate-test-recovery";
    // Two failures to open an incident, then swap to a succeeding spoke and run again.
    setupConfig(configFile, { recoveringSpoke: failingSpoke });
    await sendHubRequest({ bucket: "test-bucket", configFile });
    await sendHubRequest({ bucket: "test-bucket", configFile });
    const triggers = pdStub.calls.filter((c) => c.kind === "trigger");
    assert.equal(triggers.length, 1);

    setupConfig(configFile, { recoveringSpoke: succeedingSpoke });
    const res = await sendHubRequest({ bucket: "test-bucket", configFile });
    assert.equal(res.res.statusCode, 200);

    const resolves = pdStub.calls.filter((c) => c.kind === "resolve");
    assert.equal(resolves.length, 1, "exactly one resolve after recovery");
    assert.equal(resolves[0].dedupKey, triggers[0].dedupKey);

    const stored = await spokeFailureState.loadState({
      configFile,
      spokeName: "recoveringSpoke",
      hubConfig: { spokeFailureStateBackend: "localStorage" },
      logger: hubSpyLogger,
    });
    assert.equal(stored.consecutiveFailures, 0);
    assert.equal(stored.openIncidentDedupKey, null);
  });

  it("does not resolve when no incident was open (transient single-tick failure then success)", async function () {
    await bootHub({ threshold: 2 });
    const configFile = "gate-test-transient";

    setupConfig(configFile, { transientSpoke: failingSpoke });
    await sendHubRequest({ bucket: "test-bucket", configFile });

    setupConfig(configFile, { transientSpoke: succeedingSpoke });
    await sendHubRequest({ bucket: "test-bucket", configFile });

    assert.equal(pdStub.calls.length, 0, "no PD events for transient one-tick failures");
  });

  it("threshold=1 pages on the first failure", async function () {
    await bootHub({ threshold: 1 });
    const configFile = "gate-test-threshold-one";
    setupConfig(configFile, { eagerSpoke: failingSpoke });

    await sendHubRequest({ bucket: "test-bucket", configFile });

    const triggers = pdStub.calls.filter((c) => c.kind === "trigger");
    assert.equal(triggers.length, 1);
    assert.equal(triggers[0].customDetails.consecutiveFailures, 1);
  });

  it("isolates dedup keys per (configFile, spokeName)", async function () {
    await bootHub({ threshold: 1 });
    const configFileA = "gate-test-isolation-a";
    const configFileB = "gate-test-isolation-b";
    setupConfig(configFileA, { sharedName: failingSpoke });
    setupConfig(configFileB, { sharedName: failingSpoke });

    await sendHubRequest({ bucket: "test-bucket", configFile: configFileA });
    await sendHubRequest({ bucket: "test-bucket", configFile: configFileB });

    const triggers = pdStub.calls.filter((c) => c.kind === "trigger");
    assert.equal(triggers.length, 2);
    assert.notEqual(triggers[0].dedupKey, triggers[1].dedupKey);
    assert.include(triggers[0].dedupKey, configFileA);
    assert.include(triggers[1].dedupKey, configFileB);
  });
});
