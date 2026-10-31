import assert from "node:assert/strict";
import dgram from "node:dgram";
import { Resolver } from "node:dns";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createResolvedAddressGuard } from "@anthropic-ai/sandbox-runtime/dist/sandbox/resolved-address-guard.js";
import { sandboxConfiguration } from "../src/sandbox/runner.js";

test("resolved-address guard checks real local DNS replies without dialing their destinations", async (t) => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "swarm-dns-work-"));
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "swarm-dns-home-"));
  const server = dgram.createSocket("udp4");
  const resolver = new Resolver({ timeout: 1000, tries: 1 });
  let answer = "127.0.0.1";
  let queries = 0;
  server.on("message", (packet, peer) => {
    // A single A question produced by Node's real resolver; RFC 1035 wire
    // format with a compressed answer name pointing back to that question.
    assert.equal(packet.readUInt16BE(4), 1);
    let end = 12;
    while (packet[end] !== 0) end += 1 + packet[end]!;
    end += 5;
    assert.equal(packet.readUInt16BE(end - 4), 1);
    const header = Buffer.alloc(12);
    packet.copy(header, 0, 0, 2);
    header.writeUInt16BE(0x8180, 2);
    header.writeUInt16BE(1, 4);
    header.writeUInt16BE(1, 6);
    const record = Buffer.from([
      0xc0,
      0x0c,
      0,
      1,
      0,
      1,
      0,
      0,
      0,
      0,
      0,
      4,
      ...answer.split(".").map(Number),
    ]);
    queries++;
    server.send(Buffer.concat([header, packet.subarray(12, end), record]), peer.port, peer.address);
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.bind(0, "127.0.0.1", resolve);
  });
  resolver.setServers([`127.0.0.1:${server.address().port}`]);
  try {
    const config = await sandboxConfiguration(workspace, home, "readonly", process.env, "adaptive");
    const guard = createResolvedAddressGuard({
      deniedDomains: config.network.deniedDomains,
      deniedResolvedAddresses: config.network.deniedResolvedAddresses ?? [],
      resolve: (hostname, _options, callback) =>
        resolver.resolve4(hostname, (error, addresses) =>
          callback(
            error,
            (addresses ?? []).map((address) => ({ address, family: 4 })),
          ),
        ),
    });
    for (const address of ["127.0.0.1", "169.254.169.254", "10.1.2.3", "93.184.216.34"]) {
      answer = address;
      const result = await new Promise<{ error: NodeJS.ErrnoException | null; addresses: unknown }>(
        (resolve) => {
          guard.lookupFor(443)("fixture.example.test", { all: true }, (error, addresses) =>
            resolve({ error, addresses }),
          );
        },
      );
      if (address === "93.184.216.34") {
        assert.equal(result.error, null);
        assert.deepEqual(result.addresses, [{ address, family: 4 }]);
      } else {
        assert.equal(result.error?.code, "ERR_SRT_RESOLVED_ADDRESS_DENIED");
        assert.deepEqual(result.addresses, []);
      }
    }
    assert.equal(queries, 4, "each guard lookup reached the owned UDP authority");
    t.diagnostic(
      "four real DNS queries: loopback/metadata/private denied; public answer allowed; no destination dial",
    );
  } finally {
    resolver.cancel();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    fs.rmSync(workspace, { recursive: true, force: true });
    fs.rmSync(home, { recursive: true, force: true });
  }
});
