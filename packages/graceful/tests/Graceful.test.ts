import * as T from "@matechs/effect";
import * as G from "../src";
import * as assert from "assert";

describe("Graceful", () => {
  it("should record onExit and trigger", async () => {
    const module = G.graceful();

    let calls = 0;

    await T.promise(
      T.provide(module)(
        G.onExit(
          T.liftIO(() => {
            calls += 1;
          })
        )
      )
    );

    await T.promise(T.provide(module)(G.trigger()));

    assert.deepEqual(calls, 1);
  });
});
