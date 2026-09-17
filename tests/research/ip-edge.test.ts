import { expect, it } from "vitest";
import { isPrivateAddress } from "@/lib/integrations/research/url-fetch";
it("blocks non-public IPv6 notations and allows public addresses", () => {
  expect(["::ffff:7f00:1", "::127.0.0.1", "64:ff9b::7f00:1", "[::1]", "fe80::1%en0", "0:0:0:0:0:0:0:1", "garbage"].map(isPrivateAddress)).toEqual([true, true, true, true, true, true, true]);
  expect(["2606:4700::1111", "8.8.8.8", "::ffff:8.8.8.8"].map(isPrivateAddress)).toEqual([false, false, false]);
});
