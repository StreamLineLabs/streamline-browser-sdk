import { LWWRegister } from "@streamlinelabs/browser-sdk";

const browserA = new LWWRegister<string>("browser-a");
browserA.set("dark");

const value = browserA.get();
if (value !== undefined) {
  const browserB = new LWWRegister<string>("browser-b");
  const result = browserB.merge({
    value,
    timestamp: browserA.timestamp,
  });

  console.log(result.chosen, browserB.get());
}
