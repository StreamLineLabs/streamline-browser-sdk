import { Client } from "@streamlinelabs/browser-sdk";

const client = new Client({
  url: "wss://streamline.example.com/browser",
  clientId: "checkout-ui",
  preferTransport: "websocket",
});
const events = client.topic("events");

await client.connect();

try {
  await events.append({
    key: "page:/home",
    value: { action: "click", page: "/home" },
  });
  console.log("The record was written to the local pending queue.");
} finally {
  await client.close();
}
