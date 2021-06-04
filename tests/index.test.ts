import run from "../src";
import fetch from "node-fetch";
import { Server } from "@hapi/hapi";

test("Runs Default", (done) => {
  const serverRef: { current?: Server } = { current: undefined };
  const failRef = { current: false };
  run({ serverRef }).catch((e) => {
    failRef.current = true;
    serverRef?.current?.stop?.();
    expect(e).toBeNull();
  });
  setTimeout(
    () => {
      if (failRef.current) {
        done();
        return;
      }
      fetch("http://localhost:3003/dev/test", {
        method: "POST",
        body: JSON.stringify({ foo: "bar" }),
      })
        .then((res) => {
          expect(res.status).toBe(200);
          expect(res.ok).toBe(true);
          return res.json();
        })
        .then((json) => {
          expect(json.foo).toBe("bar");
          done();
        })
        .finally(() => {
          serverRef?.current?.stop();
        });
    },
    // give the server a second to spin up
    1000
  );
});
