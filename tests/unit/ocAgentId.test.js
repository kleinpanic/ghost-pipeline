"use strict";

// 98-01: outbound sender attribution.
//
// ocGatewayPost() posted with neither `sessionKey` nor `agentId`, so the gateway resolved the
// send to the DEFAULT agent (main). Result: ghost-pipeline's own cards rendered
// "[KleinClaw-Main]" inside ghost's channel and minted a parasitic
// agent:main:discord:channel:<ghost> session.
//
// GHOST_OC_AGENT_ID sends the gateway's sanctioned `agentId` selector. It is UNSET by default —
// `agentId` only resolves for an agent that holds the message tool, and ghost's policy is
// profile:"minimal" with message absent from alsoAllow. Granting it is a security trade the
// operator owns, so these tests pin BOTH arms: the selector when set, and a byte-identical
// pre-98-01 body when not.

const https = require("https");

function captureInvokeBody(envValue) {
  jest.resetModules();
  if (envValue === undefined) delete process.env.GHOST_OC_AGENT_ID;
  else process.env.GHOST_OC_AGENT_ID = envValue;

  let written = null;
  const spy = jest.spyOn(https, "request").mockImplementation(() => ({
    on() {},
    setTimeout() {},
    write(b) { written = b; },
    end() {},
    destroy() {},
  }));

  const ghost = require("../../src/ghost.js");
  // Token must be present or ocGatewayPost short-circuits to null before building a body.
  if (!process.env.OC_GATEWAY_TOKEN) throw new Error("test harness: token not seeded");
  ghost.ocGatewayPost("message", { action: "send", target: "channel:1" });

  spy.mockRestore();
  return written;
}

describe("98-01 GHOST_OC_AGENT_ID outbound sender attribution", () => {
  const ORIG_AGENT = process.env.GHOST_OC_AGENT_ID;
  const ORIG_TOKEN = process.env.OC_GATEWAY_TOKEN;

  beforeAll(() => { process.env.OC_GATEWAY_TOKEN = "test-token-98-01"; });

  afterAll(() => {
    jest.resetModules();
    if (ORIG_AGENT === undefined) delete process.env.GHOST_OC_AGENT_ID;
    else process.env.GHOST_OC_AGENT_ID = ORIG_AGENT;
    if (ORIG_TOKEN === undefined) delete process.env.OC_GATEWAY_TOKEN;
    else process.env.OC_GATEWAY_TOKEN = ORIG_TOKEN;
  });

  test("set: the invoke body carries agentId", () => {
    const body = JSON.parse(captureInvokeBody("ghost"));
    expect(body.agentId).toBe("ghost");
    expect(body.tool).toBe("message");
  });

  test("unset: the body is byte-identical to the pre-98-01 shape", () => {
    const body = captureInvokeBody(undefined);
    expect(body).toBe(JSON.stringify({
      tool: "message",
      args: { action: "send", target: "channel:1" },
    }));
    expect(JSON.parse(body)).not.toHaveProperty("agentId");
  });

  // Boundary neighbors around the empty-string equivalence class: a blank or whitespace-only
  // value must behave as unset, not as a bogus agent id the gateway would 404.
  test("empty string: treated as unset", () => {
    expect(JSON.parse(captureInvokeBody(""))).not.toHaveProperty("agentId");
  });

  test("whitespace only: treated as unset", () => {
    expect(JSON.parse(captureInvokeBody("   "))).not.toHaveProperty("agentId");
  });

  test("surrounding whitespace is trimmed off a real id", () => {
    expect(JSON.parse(captureInvokeBody("  ghost  ")).agentId).toBe("ghost");
  });

  test("OC_AGENT_ID export reflects the trimmed env value", () => {
    jest.resetModules();
    process.env.GHOST_OC_AGENT_ID = "  immune  ";
    expect(require("../../src/ghost.js").OC_AGENT_ID).toBe("immune");
  });
});
