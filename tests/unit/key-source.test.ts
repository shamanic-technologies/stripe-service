import { describe, it, expect, vi, afterEach } from "vitest";
import { getKeySource } from "../../src/lib/key-client";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("getKeySource", () => {
  it("reads the user-less org-keyed route with the service key only", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          provider: "stripe",
          orgId: "d4cbcbd5-35ad-4634-919d-7dbd40f76a59",
          keySource: "platform",
          isDefault: true,
        }),
        { status: 200 }
      )
    );
    vi.stubGlobal("fetch", fetchMock);

    const res = await getKeySource("d4cbcbd5-35ad-4634-919d-7dbd40f76a59", "stripe");

    expect(res.keySource).toBe("platform");
    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toMatch(
      /\/internal\/keys\/by-org\/d4cbcbd5-35ad-4634-919d-7dbd40f76a59\/stripe\/source$/
    );
    expect(Object.keys(init.headers)).toEqual(["x-api-key"]);
  });

  it("fails loud on a non-2xx", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response("nope", { status: 400 }))
    );
    await expect(getKeySource("org", "stripe")).rejects.toThrow(/400 - nope/);
  });
});
