throw new Error(
  [
    "Live integration is blocked:",
    "this repository has no browser-protocol Streamline fixture or validated live test suite.",
    "Opening a WebSocket and returning from send() cannot prove authentication,",
    "server acceptance, subscription behavior, or broker acknowledgement.",
    "Keep releases blocked until test:integration exercises an explicit compatible",
    "protocol and fails on server errors, rejected authentication, missing acknowledgements,",
    "disconnects, and timeouts. A raw Kafka listener is not a valid substitute.",
  ].join(" "),
);
