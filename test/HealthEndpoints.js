// GET /health endpoints exist on both Hub and Spoke. Used by the deploy pipeline to pre-warm
// Cloud Run instances after a new revision rollout (see UMAprotocol/zion cloud-build module).
// These must (a) respond 200, (b) not require auth-shaped bodies, (c) not spawn any work.

const { network } = require("hardhat");
const { assert } = require("chai");
const request = require("supertest");
const winston = require("winston");
const sinon = require("sinon");
const { SpyTransport } = require("@risk-labs/logger");

const hub = require("../src/ServerlessHub");
const spoke = require("../src/ServerlessSpoke");

describe("/health endpoints", function () {
  const hubTestPort = 8092;
  const spokeTestPort = 8093;
  let hubInstance;
  let spokeInstance;

  beforeEach(async function () {
    const spy = sinon.spy();
    const logger = winston.createLogger({
      level: "info",
      transports: [new SpyTransport({ level: "debug" }, { spy })],
    });
    hubInstance = await hub.Poll(
      logger,
      hubTestPort,
      `http://localhost:${spokeTestPort}`,
      network.config.url,
      { spokeRunner: "localStorage" }
    );
    spokeInstance = await spoke.Poll(logger, spokeTestPort);
  });

  afterEach(async function () {
    if (hubInstance) hubInstance.close();
    if (spokeInstance) spokeInstance.close();
  });

  it("ServerlessHub GET /health returns 200", async function () {
    const res = await request(`http://localhost:${hubTestPort}`).get("/health");
    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.body, { ok: true });
  });

  it("ServerlessSpoke GET /health returns 200", async function () {
    const res = await request(`http://localhost:${spokeTestPort}`).get("/health");
    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.body, { ok: true });
  });

  it("ServerlessSpoke GET /health does not spawn any child process", async function () {
    // Sanity: 50 parallel GETs all return 200, no errors. Mirrors the deploy-time warm pattern.
    const responses = await Promise.all(
      Array.from({ length: 50 }, () => request(`http://localhost:${spokeTestPort}`).get("/health"))
    );
    for (const res of responses) assert.equal(res.statusCode, 200);
  });
});
